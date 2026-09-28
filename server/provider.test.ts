import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { BridgeInitializeResult, BridgeMethods, BridgeNotifications } from "../shared/bridge-protocol.js";
import type { DshBridge, SessionLaunch } from "./bridge-client.js";
import { PLUGIN_VERSION } from "./plugin-version.js";
import { createDshProvider } from "./provider.js";
import { versionLine } from "./version-line.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolves to the plugin's own version so `matchVersionLine` reports "match" and no warning fires. */
const noVersionWarning = async (): Promise<string> => PLUGIN_VERSION;

class FakeBridge implements DshBridge {
  readonly executable = "dsh";
  readonly initialized: BridgeInitializeResult = {
    protocolVersion: 1,
    profile: "paseo",
    capabilities: { stream: true, approvals: true, questions: true, history: true, cancel: true },
    catalog: {
      models: [{ id: "deepseek/chat", provider: "deepseek", model: "chat", name: "DeepSeek Chat", providerName: "DeepSeek" }],
      presets: [{ id: "default", name: "Default" }],
      defaultModel: { provider: "deepseek", model: "chat" },
      defaultPreset: "default",
      permissionPresets: [
        { id: "read-only", name: "Read only" },
        { id: "workspace-write", name: "Workspace write" },
      ],
      defaultPermissionPreset: "read-only",
    },
  };
  readonly calls: Array<{ method: keyof BridgeMethods; params: unknown }> = [];
  closeCount = 0;
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private failureListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly failures: ReadonlySet<keyof BridgeMethods> = new Set(),
    private readonly closeInteractionSynchronously = false,
    private readonly completePromptSynchronously = true,
  ) {}

  async request<Name extends keyof BridgeMethods>(method: Name, params: BridgeMethods[Name]["params"]): Promise<BridgeMethods[Name]["result"]> {
    this.calls.push({ method, params });
    if (this.failures.has(method)) throw new Error(`${method} failed`);
    if (method === "session.open") {
      const open = params as BridgeMethods["session.open"]["params"];
      return {
        sessionId: open.sessionId ?? "native-new",
        cwd: open.cwd,
        model: this.initialized.catalog.defaultModel,
        preset: "default",
        permissionPreset: open.permissionPreset ?? "read-only",
        events: [],
      } as BridgeMethods[Name]["result"];
    }
    if (method === "interaction.respond" && this.closeInteractionSynchronously) {
      const response = params as BridgeMethods["interaction.respond"]["params"];
      this.notify("interaction.closed", {
        sessionId: "native-new",
        requestId: response.requestId,
      });
    }
    if (method === "session.prompt") {
      this.notify("session.status", { sessionId: "native-new", status: "running" });
      if (this.completePromptSynchronously) {
        this.notify("session.status", { sessionId: "native-new", status: "idle" });
      }
      return { messageId: "user-1" } as BridgeMethods[Name]["result"];
    }
    if (method === "session.list") return { sessions: [] } as BridgeMethods[Name]["result"];
    if (method === "session.commands") {
      return {
        commands: [
          { name: "compact", description: "Compact history", kind: "command" },
          { name: "plan", description: "Enter or leave plan mode", kind: "command" },
          { name: "review", description: "Review code", kind: "skill" },
        ],
      } as BridgeMethods[Name]["result"];
    }
    if (method === "session.command") {
      const command = params as BridgeMethods["session.command"]["params"];
      this.notify("session.event", {
        sessionId: "native-new",
        event: { type: "command/run", seq: 10, time: 1, data: { commandId: "c1", name: command.name, args: "" } },
      });
      this.notify("session.event", {
        sessionId: "native-new",
        event: { type: "command/done", seq: 11, time: 2, data: { commandId: "c1", kind: "success", text: "Compacted 3 history items." } },
      });
      if (command.name === "plan") {
        this.notify("session.event", {
          sessionId: "native-new",
          event: { type: "plan/mode", seq: 12, time: 2, data: { active: command.arguments !== "off" } },
        });
        return { kind: "success", text: "Plan mode on.", running: false } as BridgeMethods[Name]["result"];
      }
      if (command.name === "goal") {
        this.notify("session.status", { sessionId: "native-new", status: "running" });
        return { kind: "success", text: "Goal set.", running: true } as BridgeMethods[Name]["result"];
      }
      return { kind: "success", text: "Compacted 3 history items.", running: false } as BridgeMethods[Name]["result"];
    }
    return {} as BridgeMethods[Name]["result"];
  }

  on<Name extends keyof BridgeNotifications>(method: Name, listener: (params: BridgeNotifications[Name]) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener as (params: unknown) => void);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener as (params: unknown) => void);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  fail(error: Error): void {
    for (const listener of this.failureListeners) listener(error);
  }

  notify<Name extends keyof BridgeNotifications>(method: Name, params: BridgeNotifications[Name]): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }
}

describe("dsh provider", () => {
  it("advertises DSH commands and skills, runs commands and sends skills as prompts", async () => {
    const bridge = new FakeBridge();
    const { connection, events } = await openSession(bridge);
    assert.ok(connection.capabilities.includes("prompt.command"));
    const listed = events.find((event) => event.type === "session.commands");
    assert.deepEqual(listed?.type === "session.commands" && listed.commands.map((command) => command.name), ["compact", "plan", "review"]);

    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: { clientMessageId: "client-c", delivery: "auto", input: { type: "command", name: "compact", arguments: "" } },
    });
    await tick();
    await tick();
    assert.ok(events.some((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" &&
      event.item.text === "/compact" && event.item.clientMessageId === "client-c"));
    assert.ok(events.some((event) =>
      event.type === "timeline.item" && event.item.type === "notification" &&
      event.item.message === "Compacted 3 history items."));
    assert.ok(events.some((event) =>
      event.type === "session.prompt_result" && event.clientMessageId === "client-c" && event.result.type === "completed"));

    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: { clientMessageId: "client-s", delivery: "auto", input: { type: "command", name: "review", arguments: "src/a.ts" } },
    });
    await tick();
    await tick();
    assert.deepEqual(
      bridge.calls.filter((call) => call.method === "session.prompt").map((call) => call.params),
      [{ sessionId: "native-new", content: [{ type: "text", text: "/review src/a.ts" }] }],
    );
    await connection.close();
  });

  it("reports a command that wakes the agent as a turn and tracks DSH-initiated turns", async () => {
    const bridge = new FakeBridge();
    const { connection, events } = await openSession(bridge);
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: { clientMessageId: "client-g", delivery: "auto", input: { type: "command", name: "goal", arguments: "ship it" } },
    });
    await tick();
    await tick();
    const result = events.find((event) => event.type === "session.prompt_result" && event.clientMessageId === "client-g");
    assert.deepEqual(result?.type === "session.prompt_result" && result.result, { type: "turn", turnId: "dsh-command-client-g" });
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: { type: "turn/end", seq: 18, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
    });
    // DSH drains the goal continuation without going idle.
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: { type: "turn/start", seq: 19, time: 3, data: { turn: 2 } },
    });
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: { type: "turn/end", seq: 20, time: 3, data: { turn: 2, reason: { kind: "completed" } } },
    });
    const turns = events.flatMap((event) => (event.type === "session.turn" ? [`${event.turnId.replace(/-[0-9a-f-]{36}$/u, "")}:${event.state}`] : []));
    assert.deepEqual(turns, [
      "dsh-command-client-g:started",
      "dsh-command-client-g:completed",
      "dsh-auto:started",
      "dsh-auto:completed",
    ]);
    await connection.close();
  });

  it("exposes DSH plan mode as a toggle that runs /plan and follows plan/mode events", async () => {
    const bridge = new FakeBridge();
    const { connection, events } = await openSession(bridge);
    const planSetting = () => {
      const config = events.filter((event) => event.type === "session.config").at(-1);
      return config?.type === "session.config"
        ? config.config.settings.find((setting) => setting.id === "planMode")
        : undefined;
    };
    assert.equal(planSetting()?.value, false);
    await connection.send({
      type: "session.configure",
      requestId: "cfg-plan",
      sessionId: "paseo-1",
      changes: { settings: { planMode: true } },
    });
    await tick();
    await tick();
    assert.deepEqual(bridge.calls.find((call) => call.method === "session.command")?.params, {
      sessionId: "native-new",
      name: "plan",
      arguments: "",
    });
    assert.equal(planSetting()?.value, true);
    // Approving a plan exits plan mode on the DSH side.
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: { type: "plan/mode", seq: 40, time: 5, data: { active: false } },
    });
    assert.equal(planSetting()?.value, false);
    await connection.close();
  });

  it("follows DSH permission preset changes in the Paseo config", async () => {
    const bridge = new FakeBridge();
    const { connection, events } = await openSession(bridge);
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: { type: "permission/preset", seq: 30, time: 4, data: { preset: "workspace-write" } },
    });
    const config = events.filter((event) => event.type === "session.config").at(-1);
    assert.equal(
      config?.type === "session.config" && config.config.settings?.[0]?.value,
      "workspace-write",
    );
    await connection.close();
  });

  it("forwards images, uploaded files and context attachments to the bridge", async () => {
    const bridge = new FakeBridge();
    const { connection, events } = await openSession(bridge);
    assert.ok(connection.capabilities.includes("prompt.image"));
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: {
        clientMessageId: "client-i",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "check" },
            { type: "image", data: "AA==", mimeType: "image/png" },
            { type: "uploaded_file", id: "u", fileName: "a.log", mimeType: "text/plain", size: 3, path: "/tmp/a.log" },
            { type: "github_issue", mimeType: "application/github-issue", number: 7, title: "Bug", url: "https://x/7" },
          ],
        },
      },
    });
    await tick();
    await tick();
    assert.deepEqual(bridge.calls.find((call) => call.method === "session.prompt")?.params, {
      sessionId: "native-new",
      content: [
        { type: "text", text: "check" },
        { type: "image", mediaType: "image/png", data: "AA==" },
        { type: "file", path: "/tmp/a.log", name: "a.log" },
        { type: "text", text: "GitHub Issue #7: Bug\nhttps://x/7" },
      ],
    });
    assert.ok(events.some((event) =>
      event.type === "timeline.item" && event.item.type === "user_message" &&
      event.item.text === "check\n[image]\n[file: a.log]\nGitHub Issue #7: Bug\nhttps://x/7"));
    await connection.close();
  });

  it("reports the DSH failure message when a turn fails", async () => {
    const bridge = new FakeBridge(new Set(), false, false);
    const { connection, events } = await openSession(bridge);
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: { clientMessageId: "client-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } },
    });
    await tick();
    await tick();
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: {
        type: "turn/end",
        seq: 5,
        time: 1,
        data: { turn: 1, reason: { kind: "error", error: { message: "429 rate limited", code: "RATE_LIMIT", status: 429 } } },
      },
    });
    const failed = events.find((event) => event.type === "session.turn" && event.state === "failed");
    assert.deepEqual(failed?.type === "session.turn" && failed.error, {
      message: "[RATE_LIMIT] 429 rate limited",
      code: "RATE_LIMIT",
      diagnostic: "HTTP 429",
    });
    await connection.close();
  });

  it("correlates the optimistic user message and terminalizes an instant turn once", async () => {
    const bridge = new FakeBridge();
    const provider = createDshProvider({ createBridge: async () => bridge, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "paseo-1",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    await tick();
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: {
        clientMessageId: "client-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await tick();
    await tick();

    assert.ok(events.some((event) => event.type === "timeline.item" && event.item.type === "user_message" && event.item.clientMessageId === "client-1"));
    assert.deepEqual(
      events.filter((event) => event.type === "session.turn").map((event) => event.state),
      ["started", "completed"],
    );
    await connection.close();
  });

  it("resumes persistence without overriding the historical model or preset", async () => {
    const bridge = new FakeBridge();
    const provider = createDshProvider({ createBridge: async () => bridge, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["session.persistence", "session.configure"],
    });
    connection.onEvent(() => {});
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "paseo-1",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true, model: "deepseek/chat", mode: "default" },
      persistence: { version: 1, data: { dshSessionId: "native-old" } },
      history: "replay",
    });
    await tick();

    const open = bridge.calls.find((call) => call.method === "session.open");
    assert.deepEqual(open?.params, { sessionId: "native-old", resume: true, cwd: "/repo" });
    await connection.send({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "paseo-1",
      changes: { settings: { permissionPreset: "workspace-write" } },
    });
    await tick();
    assert.deepEqual(bridge.calls.find((call) => call.method === "session.configure")?.params, {
      sessionId: "native-old",
      permissionPreset: "workspace-write",
    });
    await connection.close();
  });

  it("passes Paseo launch environment and permission preset to the session bridge", async () => {
    const discovery = new FakeBridge();
    const runtime = new FakeBridge();
    const launches: Array<SessionLaunch | undefined> = [];
    const provider = createDshProvider({
      createBridge: async (launch) => {
        launches.push(launch);
        return launch ? runtime : discovery;
      },
      detectDshVersion: noVersionWarning,
    });
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["session.configure", "permission.tool_policy"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "paseo-1",
      config: {
        cwd: "/repo",
        env: { PASEO_LAUNCH_TOKEN: "session-value" },
        mcpServers: {
          paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents", headers: { Authorization: "Bearer t" } },
          files: { type: "stdio", command: "mcp-files", args: ["--root", "/repo"] },
        },
        toolPolicy: { preapproved: [{ kind: "mcp", server: "paseo", tool: "create_agent" }] },
        systemPrompt: "Follow the Paseo daemon rules.",
        settings: { permissionPreset: "workspace-write" },
        persist: false,
      },
      history: "skip",
    });
    await tick();
    await tick();

    assert.deepEqual(launches, [
      undefined,
      {
        env: { PASEO_LAUNCH_TOKEN: "session-value" },
        ephemeral: true,
        mcpServers: [
          {
            serverName: "paseo",
            transport: "streamable-http",
            url: "http://127.0.0.1:6767/mcp/agents",
            headers: { Authorization: "Bearer t" },
          },
          { serverName: "files", transport: "stdio", command: "mcp-files", args: ["--root", "/repo"] },
        ],
      },
    ]);
    assert.deepEqual(runtime.calls.find((call) => call.method === "session.open")?.params, {
      cwd: "/repo",
      model: { provider: "deepseek", model: "chat" },
      permissionPreset: "workspace-write",
      systemPrompt: "Follow the Paseo daemon rules.",
      preapprovedTools: ["mcp__paseo__create_agent"],
    });
    const opened = events.find((event) => event.type === "session.opened");
    assert.equal(opened?.type === "session.opened" && "persistence" in opened, false);
    const config = events.find((event) => event.type === "session.config");
    assert.equal(
      config?.type === "session.config" ? config.config.settings[0]?.value : undefined,
      "workspace-write",
    );
    await connection.close();
  });

  it("reports a queued configure failure to Paseo", async () => {
    const discovery = new FakeBridge();
    const runtime = new FakeBridge(new Set(["session.configure"]));
    const provider = createDshProvider({ createBridge: async (env) => env ? runtime : discovery, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({ versions: [1], capabilities: ["session.configure"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await openTestSession(connection);
    await connection.send({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "paseo-1",
      changes: { mode: "default" },
    });
    await tick();
    await tick();

    assert.ok(events.some((event) => event.type === "request.failed" && event.requestId === "configure-1"));
    await connection.close();
  });

  it("rejects a DSH question and resolves its card exactly once", async () => {
    const discovery = new FakeBridge();
    const runtime = new FakeBridge(new Set(), true);
    const provider = createDshProvider({ createBridge: async (env) => env ? runtime : discovery, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({ versions: [1], capabilities: ["permission"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await openTestSession(connection);
    runtime.notify("interaction.request", {
      sessionId: "native-new",
      requestId: "question-1",
      kind: "questions",
      questions: [{ id: "q1", question: "Continue?" }],
    });
    await connection.send({
      type: "session.permission",
      sessionId: "paseo-1",
      permissionId: "question-1",
      response: { behavior: "deny" },
    });
    await tick();

    assert.deepEqual(runtime.calls.find((call) => call.method === "interaction.respond")?.params, {
      requestId: "question-1",
      outcome: "rejected",
    });
    assert.equal(
      events.filter((event) => event.type === "session.permission_resolved").length,
      1,
    );
    runtime.notify("interaction.request", {
      sessionId: "native-new",
      requestId: "approval-1",
      kind: "approval",
      toolName: "shell",
    });
    await connection.send({
      type: "session.close",
      requestId: "close-1",
      sessionId: "paseo-1",
    });
    await tick();
    assert.ok(
      events.some(
        (event) =>
          event.type === "session.permission_resolved" &&
          event.permissionId === "approval-1",
      ),
    );
    await connection.close();
  });

  it("closes the Paseo session when the native close request fails", async () => {
    const discovery = new FakeBridge();
    const runtime = new FakeBridge(new Set(["session.close"]), false, false);
    const provider = createDshProvider({ createBridge: async (env) => env ? runtime : discovery, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await openTestSession(connection);
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: {
        clientMessageId: "client-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await tick();
    await connection.send({
      type: "session.close",
      requestId: "close-1",
      sessionId: "paseo-1",
    });
    await tick();
    await tick();

    assert.ok(events.some((event) => event.type === "session.closed"));
    assert.ok(
      events.some(
        (event) => event.type === "session.turn" && event.state === "canceled",
      ),
    );
    assert.ok(
      events.some(
        (event) => event.type === "request.failed" && event.requestId === "close-1",
      ),
    );
    await connection.close();
  });

  it("closes a failed bridge immediately", async () => {
    const discovery = new FakeBridge();
    const runtime = new FakeBridge();
    const provider = createDshProvider({ createBridge: async (env) => env ? runtime : discovery, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({ versions: [1], capabilities: [] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await openTestSession(connection);
    runtime.fail(new Error("invalid bridge output"));
    await tick();

    assert.equal(runtime.closeCount, 1);
    assert.ok(events.some((event) => event.type === "session.runtime_failed"));
    await connection.close();
  });

  it("warns in the timeline on a dsh version-line mismatch but keeps the session usable", async () => {
    const bridge = new FakeBridge();
    const provider = createDshProvider({
      createBridge: async () => bridge,
      detectDshVersion: async () => "0.9.9-rc.1",
    });
    const connection = await provider.connect({ versions: [1], capabilities: ["prompt.message"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await openTestSession(connection);

    const warning = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.level === "warning",
    );
    assert.ok(warning, "expected a version-mismatch warning notification");
    const message = warning?.type === "timeline.item" && warning.item.type === "notification" ? warning.item.message : "";
    assert.match(message, /0\.9\.9-rc\.1/);
    assert.match(message, new RegExp(`${escapeRegExp(versionLine(PLUGIN_VERSION)!)}\\.\\*`));
    assert.ok(events.some((event) => event.type === "session.ready"));

    // The session still works: DSH's own handshake is what can block startup, not this check.
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: { clientMessageId: "client-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "hi" }] } },
    });
    await tick();
    await tick();
    assert.ok(events.some((event) => event.type === "session.turn" && event.state === "completed"));
    await connection.close();
  });

  it("warns instead of blocking when the dsh version cannot be confirmed", async () => {
    const bridge = new FakeBridge();
    const provider = createDshProvider({
      createBridge: async () => bridge,
      detectDshVersion: async () => "",
    });
    const connection = await provider.connect({ versions: [1], capabilities: [] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await openTestSession(connection);

    const warning = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "notification" && event.item.level === "warning",
    );
    assert.ok(warning, "expected an unconfirmed-version warning notification");
    assert.ok(events.some((event) => event.type === "session.ready"));
    await connection.close();
  });
});

async function openTestSession(connection: Awaited<ReturnType<ReturnType<typeof createDshProvider>["connect"]>>): Promise<void> {
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    config: {
      cwd: "/repo",
      env: { PASEO_TEST: "1" },
      mcpServers: {},
      settings: {},
      persist: true,
    },
    history: "skip",
  });
  await tick();
  await tick();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function openSession(bridge: FakeBridge) {
  const provider = createDshProvider({ createBridge: async () => bridge, detectDshVersion: noVersionWarning });
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.command", "prompt.image", "session.persistence", "session.configure"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-1",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "skip",
  });
  await tick();
  return { connection, events };
}
