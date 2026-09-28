import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
  BridgeMethods,
  RpcRequest,
} from "../../shared/bridge-protocol.js";
import type { HostContext, HostHelpers } from "./host.js";
import { BridgeService } from "./service.js";

export const name = "paseo-dsh-bridge";
export const inject = [
  "agents",
  "sessionQuery",
  "agentPresets",
  "llm",
];

/** Keep stack traces off the wire and redact common credential representations. */
export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "DSH operation failed";
  return raw
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.\-]+/gi, "[redacted]")
    .replace(
      /((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 1000);
}

const METHODS = new Set<keyof BridgeMethods>([
  "bridge.initialize",
  "bridge.shutdown",
  "session.list",
  "session.read",
  "session.open",
  "session.close",
  "session.prompt",
  "session.steer",
  "session.configure",
  "session.rename",
  "session.commands",
  "session.command",
  "session.cancel",
  "interaction.respond",
]);

export function parseRequest(line: string): RpcRequest {
  // Prompts carry base64 images.
  if (line.length > 64 * 1024 * 1024) throw new Error("Request too large");
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid JSON-RPC request");
  }
  const request = value as Record<string, unknown>;
  if (
    request.jsonrpc !== "2.0" ||
    (typeof request.id !== "number" && typeof request.id !== "string") ||
    (typeof request.id === "number" && !Number.isSafeInteger(request.id)) ||
    typeof request.method !== "string" ||
    !METHODS.has(request.method as keyof BridgeMethods) ||
    (request.params !== undefined &&
      (!request.params ||
        typeof request.params !== "object" ||
        Array.isArray(request.params)))
  ) {
    throw new Error("Invalid or unsupported JSON-RPC request");
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    method: request.method as keyof BridgeMethods,
    ...(request.params === undefined
      ? {}
      : { params: request.params as Record<string, unknown> }),
  };
}

export async function apply(
  ctx: HostContext,
  config: { profile?: string } = {},
): Promise<void> {
  // Resolve only inside the DSH child, against its own installed closure.
  // Paseo never imports or bundles a second copy of these runtime services.
  const bin = process.argv[1];
  let helpers: HostHelpers | undefined;
  if (bin) {
    const requireHost = createRequire(realpathSync(bin));
    const module: unknown = await import(
      pathToFileURL(requireHost.resolve("@deepseek-ai/dsh-agent")).href
    );
    if (
      typeof module === "object" &&
      module !== null &&
      "installModelSelection" in module &&
      typeof module.installModelSelection === "function"
    )
      helpers = module as HostHelpers;
  }
  const send = (value: unknown, flushed?: () => void) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, flushed);
  };
  const service = new BridgeService(
    ctx,
    (method, params) => send({ jsonrpc: "2.0", method, params }),
    config.profile,
    helpers,
  );
  let input: ReturnType<typeof createInterface> | undefined;
  let disposed = false;
  const activeIds = new Set<string | number>();
  const exit = (code: number) => ctx.get("appExit")?.(code);
  const onReady = ctx.get("appReady");
  if (!onReady || !ctx.get("appExit"))
    throw new Error("Paseo bridge requires the DSH profile launcher");
  const removeReady = onReady.onReady(() => {
    if (disposed) return;
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
      if (!line.trim()) return;
      let request: RpcRequest;
      try {
        request = parseRequest(line);
        if (activeIds.has(request.id))
          throw new Error("Request id is already active");
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: safeError(error) },
        });
        return;
      }
      activeIds.add(request.id);
      void service
        .handle(request.method, request.params)
        .then(
          (result) => {
            send(
              { jsonrpc: "2.0", id: request.id, result },
              request.method === "bridge.shutdown" ? () => exit(0) : undefined,
            );
          },
          (error) =>
            send({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32000, message: safeError(error) },
            }),
        )
        .finally(() => activeIds.delete(request.id));
    });
    input.on("close", () => {
      if (!disposed)
        void service.shutdown().then(
          () => exit(0),
          () => exit(1),
        );
    });
    send({
      jsonrpc: "2.0",
      method: "bridge.ready",
      params: { protocolVersion: 1 },
    });
  });
  ctx.effect(
    () => async () => {
      disposed = true;
      removeReady();
      input?.close();
      await service.shutdown();
    },
    "paseo-dsh-bridge",
  );
}
