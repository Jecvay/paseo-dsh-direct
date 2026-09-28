import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  BridgeInitializeResult,
  BridgeMethods,
  BridgeNotifications,
  RpcNotification,
  RpcResponse,
} from "../shared/bridge-protocol.js";

type Method = keyof BridgeMethods;
type Notification = keyof BridgeNotifications;

export interface DshBridge {
  readonly initialized: BridgeInitializeResult;
  /** The resolved `dsh` executable this bridge was launched with (see `PASEO_DSH_EXECUTABLE`). */
  readonly executable: string;
  request<Name extends Method>(
    method: Name,
    params: BridgeMethods[Name]["params"],
  ): Promise<BridgeMethods[Name]["result"]>;
  on<Name extends Notification>(
    method: Name,
    listener: (params: BridgeNotifications[Name]) => void,
  ): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

/** An MCP server mounted through `@deepseek-ai/dsh-mcp-client` for one bridge process. */
export type BridgeMcpServer =
  | {
      serverName: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      serverName: string;
      transport: "streamable-http";
      url: string;
      headers?: Record<string, string>;
    };

/** Per-session launch choices; each Paseo session owns its bridge process. */
export interface SessionLaunch {
  env?: Readonly<Record<string, string>>;
  /** Store sessions under the bridge's temporary directory, removed on close. */
  ephemeral?: boolean;
  mcpServers?: readonly BridgeMcpServer[];
}

export interface LaunchBridgeOptions extends SessionLaunch {
  executable?: string;
  profile?: string;
  bridgeSource: string;
  startupTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const MAX_STDERR = 16_384;

/** The profile the plugin launches unless `PASEO_DSH_PROFILE` names another one. */
export const DEFAULT_PROFILE = "paseo";
/** The official DSH profile template the default profile is created from. */
export const DEFAULT_PROFILE_TEMPLATE = "web";
/**
 * Rows of the web template that open a browser-facing surface. The bridge is
 * this profile's surface, so the launcher disables them in every bridge patch.
 */
export const DISABLED_SURFACE_ROWS = ["web-startup", "webserver", "web-runtime", "connection"] as const;

/** The DSH home, resolved the same way as `@deepseek-ai/dsh-home-paths`. */
export function resolveDshHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.DSH_HOME;
  const home = configured !== undefined && configured.trim().length > 0 ? configured : path.join(homedir(), ".dsh");
  if (home === "~") return homedir();
  if (home.startsWith("~/") || home.startsWith("~\\")) return path.resolve(homedir(), home.slice(2));
  return path.resolve(home);
}

/** The bridge patch: surface rows disabled, session overrides, then the bridge itself. */
export function createBridgePatch(options: {
  profile: string;
  bridgePath: string;
  sessionsRoot?: string;
  mcpServers?: readonly BridgeMcpServer[];
}): unknown[] {
  return [
    ...DISABLED_SURFACE_ROWS.map((id) => ({ id, disabled: true })),
    ...(options.sessionsRoot
      ? [{ id: "session-persistence-jsonl", config: { root: options.sessionsRoot } }]
      : []),
    {
      insert: [
        ...(options.mcpServers ?? []).map((server) => ({
          id: `paseo-mcp-${server.serverName}`,
          name: "@deepseek-ai/dsh-mcp-client",
          config: server,
        })),
        { id: "paseo-dsh-bridge", name: options.bridgePath, config: { profile: options.profile } },
      ],
    },
  ];
}

/**
 * Make sure the profile directory exists before DSH is started with it. The
 * default profile is created once from the official web template; a missing
 * profile chosen through `PASEO_DSH_PROFILE` is reported instead.
 */
export async function ensureDshProfile(options: {
  executable: string;
  profile: string;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}): Promise<void> {
  const directory = path.join(resolveDshHome(options.env), "profiles", options.profile);
  if (await isDirectory(directory)) return;
  if (options.profile !== DEFAULT_PROFILE) {
    throw new Error(
      `DSH profile "${options.profile}" does not exist at ${directory}. ` +
        `Create it with \`dsh --profile ${options.profile} --from-default-profile ${DEFAULT_PROFILE_TEMPLATE} --dump-config\`, ` +
        `or unset PASEO_DSH_PROFILE to use the "${DEFAULT_PROFILE}" profile.`,
    );
  }
  // Concurrent first launches share one creation run.
  let creation = profileCreations.get(directory);
  if (!creation) {
    creation = runProfileInit(options.executable, options.profile, options.env, options.timeoutMs ?? 60_000).finally(
      () => profileCreations.delete(directory),
    );
    profileCreations.set(directory, creation);
  }
  await creation;
  if (!(await isDirectory(directory))) {
    throw new Error(`DSH did not create the "${options.profile}" profile at ${directory}`);
  }
}

const profileCreations = new Map<string, Promise<void>>();

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function runProfileInit(
  executable: string,
  profile: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["--profile", profile, "--from-default-profile", DEFAULT_PROFILE_TEMPLATE, "--dump-config"],
      { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Creating the DSH "${profile}" profile timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Creating the DSH "${profile}" profile failed ${signal ? `from ${signal}` : `with code ${String(code)}`}` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          ),
        );
    });
  });
}

export async function launchDshBridge(options: LaunchBridgeOptions): Promise<DshBridge> {
  const profile = options.profile?.trim() || DEFAULT_PROFILE;
  const executable = options.executable?.trim() || "dsh";
  const env = { ...process.env, ...options.env };
  await ensureDshProfile({ executable, profile, env });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-dsh-direct-"));
  const bridgePath = path.join(directory, "dsh-bridge.mjs");
  const patchPath = path.join(directory, "patch.json");
  await writeFile(bridgePath, options.bridgeSource, { mode: 0o600 });
  await writeFile(
    patchPath,
    JSON.stringify(
      createBridgePatch({
        profile,
        bridgePath,
        sessionsRoot: options.ephemeral ? path.join(directory, "sessions") : undefined,
        mcpServers: options.mcpServers,
      }),
    ),
    { mode: 0o600 },
  );

  const child = spawn(executable, ["--profile", profile, "--patch", patchPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const client = new JsonlBridgeClient(child, directory, executable);
  try {
    await client.waitUntilReady(options.startupTimeoutMs ?? 15_000);
    client.initialized = await client.request("bridge.initialize", {});
    if (client.initialized.protocolVersion !== 1) {
      throw new Error(`Unsupported DSH bridge protocol ${client.initialized.protocolVersion}`);
    }
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

class JsonlBridgeClient implements DshBridge {
  initialized!: BridgeInitializeResult;
  readonly executable: string;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notifications = new Map<string, Set<(params: never) => void>>();
  private readonly failures = new Set<(error: Error) => void>();
  private ready = false;
  private terminalError: Error | null = null;
  private stderr = "";
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly temporaryDirectory: string,
    executable: string,
  ) {
    this.executable = executable;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.acceptLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
    });
    child.once("error", (error) => {
      this.fail(error);
      this.resolveExited();
    });
    child.once("exit", (code, signal) => {
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      this.fail(
        new Error(
          `DSH bridge exited ${signal ? `from ${signal}` : `with code ${String(code)}`}${suffix}`,
        ),
      );
      this.resolveExited();
    });
    child.once("close", () => this.resolveExited());
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.ready) return;
    if (this.terminalError) throw this.terminalError;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        releaseReady();
        releaseFailure();
        reject(new Error(`DSH bridge did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      const releaseReady = this.on("bridge.ready", () => {
        clearTimeout(timeout);
        releaseReady();
        releaseFailure();
        resolve();
      });
      const releaseFailure = this.onFailure((error) => {
        clearTimeout(timeout);
        releaseReady();
        releaseFailure();
        reject(error);
      });
    });
  }

  request<Name extends Method>(
    method: Name,
    params: BridgeMethods[Name]["params"],
  ): Promise<BridgeMethods[Name]["result"]> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closing && method !== "bridge.shutdown") {
      return Promise.reject(new Error("DSH bridge is closing"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH bridge request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(payload, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    }) as Promise<BridgeMethods[Name]["result"]>;
  }

  on<Name extends Notification>(
    method: Name,
    listener: (params: BridgeNotifications[Name]) => void,
  ): () => void {
    const listeners = this.notifications.get(method) ?? new Set();
    listeners.add(listener as (params: never) => void);
    this.notifications.set(method, listeners);
    return () => listeners.delete(listener as (params: never) => void);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.terminalError) queueMicrotask(() => listener(this.terminalError!));
    return () => this.failures.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (!this.terminalError) {
        await Promise.race([
          this.request("bridge.shutdown", {}).catch(() => undefined),
          delay(500),
        ]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGTERM");
        await Promise.race([this.exited, delay(1_000)]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([this.exited, delay(1_000)]);
      }
      await rm(this.temporaryDirectory, { recursive: true, force: true });
    })();
    return this.closePromise;
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcResponse | RpcNotification;
    try {
      message = JSON.parse(line) as RpcResponse | RpcNotification;
    } catch {
      this.fail(new Error(`DSH bridge wrote invalid JSON: ${line.slice(0, 200)}`));
      return;
    }
    if ("id" in message) {
      if (message.id === null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if ("error" in message) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "bridge.ready") this.ready = true;
    for (const listener of this.notifications.get(message.method) ?? []) {
      listener(message.params as never);
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) for (const listener of this.failures) listener(error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
