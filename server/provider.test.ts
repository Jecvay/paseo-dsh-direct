import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import type { BridgeInitializeResult, BridgeMethods, BridgeNotifications, QuestionAnswer, QuestionItem } from "../shared/bridge-protocol.js";
import type { DshBridge, SessionLaunch } from "./bridge-client.js";
import { DEFAULT_PROFILE } from "./bridge-client.js";
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
  /** Rows the next `session.list` returns (see the import list tests). */
  listedSessions: BridgeMethods["session.list"]["result"]["sessions"] = [];
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
  readonly calls: Array<{ method: keyof BridgeMethods; params: unknown; timeoutMs?: number }> = [];
  canStop = true;
  closeCount = 0;
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private failureListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly failures: ReadonlySet<keyof BridgeMethods> = new Set(),
    private readonly closeInteractionSynchronously = false,
    private readonly completePromptSynchronously = true,
  ) {}

  async request<Name extends keyof BridgeMethods>(method: Name, params: BridgeMethods[Name]["params"], timeoutMs?: number): Promise<BridgeMethods[Name]["result"]> {
    this.calls.push({ method, params, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    if (this.failures.has(method)) throw new Error(`${method} failed`);
    if (method === "session.can_stop_runtime") return { canStop: this.canStop } as BridgeMethods[Name]["result"];
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
    if (method === "session.list") return { sessions: this.listedSessions } as BridgeMethods[Name]["result"];
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
        images: [],
      });
      this.notify("session.event", {
        sessionId: "native-new",
        event: { type: "command/done", seq: 11, time: 2, data: { commandId: "c1", kind: "success", text: "Compacted 3 history items." } },
        images: [],
      });
      if (command.name === "plan") {
        this.notify("session.event", {
          sessionId: "native-new",
          event: { type: "plan/mode", seq: 12, time: 2, data: { active: command.arguments !== "off" } },
          images: [],
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

  it("forwards the import list window to the bridge and maps the rows", async () => {
    const bridge = new FakeBridge();
    bridge.listedSessions = [
      { id: "n-1", createdAt: 5, cwd: "/repo", title: "Fix the bug", agentPreset: "standard" },
      { id: "n-2", createdAt: 4, cwd: "/repo" },
    ];
    const provider = createDshProvider({ createBridge: async () => bridge, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["session.list", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({ type: "sessions", requestId: "list-1", cwd: "/repo", query: " bug ", limit: 1 });
    await tick();
    assert.deepEqual(bridge.calls.find((call) => call.method === "session.list")?.params, {
      cwd: "/repo",
      query: "bug",
      limit: 1,
    });
    const listed = events.find((event) => event.type === "sessions");
    assert.deepEqual(listed?.type === "sessions" ? listed.sessions : undefined, [
      {
        persistence: { version: 1, data: { dshSessionId: "n-1" } },
        cwd: "/repo",
        title: "Fix the bug",
        description: "preset: standard",
        updatedAt: new Date(5_000).toISOString(),
      },
    ]);
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
      images: [],
    });
    // DSH drains the goal continuation without going idle.
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: { type: "turn/start", seq: 19, time: 3, data: { turn: 2 } },
      images: [],
    });
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: { type: "turn/end", seq: 20, time: 3, data: { turn: 2, reason: { kind: "completed" } } },
      images: [],
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
      images: [],
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
      images: [],
    });
    const config = events.filter((event) => event.type === "session.config").at(-1);
    assert.equal(
      config?.type === "session.config" && config.config.settings?.[0]?.value,
      "workspace-write",
    );
    await connection.close();
  });

  it("does not report session usage from an assistant message", async () => {
    // Paseo replaces lastUsage whole; see TimelineProjector.projectAssistantMessage.
    const bridge = new FakeBridge();
    const { connection, events } = await openSession(bridge);
    bridge.notify("session.event", {
      sessionId: "native-new",
      event: {
        type: "assistant/message",
        seq: 12,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          usage: { inputTokens: 3091, outputTokens: 61, cacheReadTokens: 7808 },
        },
      },
      images: [],
    });
    await tick();
    assert.deepEqual(events.filter((event) => event.type === "session.usage"), []);
    await connection.close();
  });

  it("forwards the bridge's complete usage reading to Paseo unchanged", async () => {
    const bridge = new FakeBridge();
    const { connection, events } = await openSession(bridge);
    const usage = {
      inputTokens: 3091,
      cachedInputTokens: 7808,
      outputTokens: 61,
      contextWindowUsedTokens: 10899,
      contextWindowMaxTokens: 1000000,
    };
    bridge.notify("session.usage", { sessionId: "native-new", usage });
    await tick();
    assert.deepEqual(
      events.flatMap((event) => (event.type === "session.usage" ? [event.usage] : [])),
      [usage],
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
      images: [],
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

describe("dsh provider shutdown during startup", () => {
  const input: Extract<ProviderInput, { type: "session.open" }> = {
    type: "session.open", requestId: "open-1", sessionId: "paseo-1", history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
  };

  it("does not start a queued open after the connection closes", async () => {
    const discovery = new FakeBridge();
    let launches = 0;
    const provider = createDshProvider({ createBridge: async () => { launches += 1; return discovery; }, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({ versions: [1], capabilities: [] });
    const sending = connection.send(input);
    await connection.close();
    await sending;
    await tick();
    assert.equal(launches, 1);
    assert.equal(discovery.closeCount, 1);
    assert.equal(discovery.calls.length, 0);
  });

  it("waits for an in-flight launch and closes it without opening a session", async () => {
    const discovery = new FakeBridge();
    const runtime = new FakeBridge();
    const launch = deferred<DshBridge>();
    let launches = 0;
    const provider = createDshProvider({
      createBridge: () => ++launches === 1 ? Promise.resolve(discovery) : launch.promise,
      detectDshVersion: noVersionWarning,
    });
    const connection = await provider.connect({ versions: [1], capabilities: [] });
    await connection.send(input);
    await tick();
    let firstClosed = false;
    let secondClosed = false;
    const first = connection.close().then(() => { firstClosed = true; });
    const second = connection.close().then(() => { secondClosed = true; });
    await tick();
    const closedBeforeLaunch = firstClosed || secondClosed;
    launch.resolve(runtime);
    await Promise.all([first, second]);
    await tick();
    assert.equal(closedBeforeLaunch, false);
    assert.equal(runtime.closeCount, 1);
    assert.deepEqual(runtime.calls, []);
  });

  for (const blockedMethod of ["session.open", "session.commands"] as const) {
    it(`closes an acquired bridge while ${blockedMethod} is pending`, async () => {
      const entered = deferred<void>();
      const resume = deferred<void>();
      class StartingBridge extends FakeBridge {
        override async request<Name extends keyof BridgeMethods>(method: Name, params: BridgeMethods[Name]["params"]): Promise<BridgeMethods[Name]["result"]> {
          if (method === blockedMethod) { entered.resolve(); await resume.promise; }
          return super.request(method, params);
        }
      }
      const discovery = new FakeBridge();
      const runtime = new StartingBridge();
      const provider = createDshProvider({ createBridge: async (launch) => launch ? runtime : discovery, detectDshVersion: noVersionWarning });
      const connection = await provider.connect({ versions: [1], capabilities: [] });
      const events: ProviderEvent[] = [];
      connection.onEvent(event => events.push(event));
      await connection.send(input);
      await entered.promise;
      let closed = false;
      const closing = connection.close().then(() => { closed = true; });
      await tick();
      const closedBeforeResponse = closed;
      const cleanupStarted = runtime.closeCount;
      resume.resolve();
      await closing;
      await tick();
      assert.equal(closedBeforeResponse, false);
      assert.equal(cleanupStarted, 1);
      assert.equal(runtime.closeCount, 1);
      assert.equal(events.some(event => event.type === "session.ready"), false);
      if (blockedMethod === "session.open") {
        assert.equal(runtime.calls.some(call => call.method === "session.commands"), false);
      }
    });
  }

  it("finishes closing when an in-flight launch rejects", async () => {
    const discovery = new FakeBridge();
    const launch = deferred<DshBridge>();
    let launches = 0;
    const provider = createDshProvider({ createBridge: () => ++launches === 1 ? Promise.resolve(discovery) : launch.promise, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({ versions: [1], capabilities: [] });
    await connection.send(input);
    await tick();
    const closing = connection.close();
    launch.reject(new Error("startup failed"));
    await closing;
    assert.equal(discovery.closeCount, 1);
  });
});

describe("dsh provider runtime safety", () => {
  const defaultCapabilities = ["prompt.message", "session.configure", "session.persistence", "session.can_stop_runtime"];

  async function setup(runtime: FakeBridge, capabilities = defaultCapabilities, persist = true) {
    const discovery = new FakeBridge();
    const provider = createDshProvider({ createBridge: async (launch) => launch ? runtime : discovery, detectDshVersion: noVersionWarning });
    const connection = await provider.connect({ versions: [1], capabilities });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open", requestId: "open-1", sessionId: "paseo-1", history: "skip",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist },
    });
    await tick();
    await tick();
    return { connection, events };
  }

  it("negotiates session.can_stop_runtime for new hosts and drops it for older hosts", async () => {
    const { connection: modern, events: modernEvents } = await setup(new FakeBridge());
    const opened = modernEvents.find((event) => event.type === "session.opened");
    assert.ok(modern.capabilities.includes("session.can_stop_runtime"));
    assert.ok(opened?.type === "session.opened" && opened.capabilities.includes("session.can_stop_runtime"));
    await modern.close();

    const { connection: legacy } = await setup(new FakeBridge(), ["prompt.message", "session.persistence"]);
    assert.equal(legacy.capabilities.includes("session.can_stop_runtime"), false);
    await assert.rejects(
      () => legacy.send({ type: "session.can_stop_runtime", requestId: "stop-0", sessionId: "paseo-1" }),
      /session\.can_stop_runtime/,
    );
    await legacy.close();
  });

  it("queries the session bridge with a bounded timeout and preserves the session state", async () => {
    const runtime = new FakeBridge();
    const { connection, events } = await setup(runtime);

    for (const expected of [true, false]) {
      runtime.canStop = expected;
      await connection.send({ type: "session.can_stop_runtime", requestId: `stop-${expected}`, sessionId: "paseo-1" });
      await tick();
      await tick();
      assert.deepEqual(
        events.find((event) => "requestId" in event && event.requestId === `stop-${expected}`),
        { type: "session.can_stop_runtime", requestId: `stop-${expected}`, sessionId: "paseo-1", canStop: expected },
      );
    }
    const safetyCalls = runtime.calls.filter((call) => call.method === "session.can_stop_runtime");
    assert.deepEqual(safetyCalls, [
      { method: "session.can_stop_runtime", params: { sessionId: "native-new" }, timeoutMs: 5_000 },
      { method: "session.can_stop_runtime", params: { sessionId: "native-new" }, timeoutMs: 5_000 },
    ]);
    assert.equal(runtime.closeCount, 0);
    assert.equal(events.some((event) => event.type === "session.closed"), false);
    assert.equal(events.some((event) => event.type === "request.completed"), false);
    await connection.close();
  });

  it("answers false without waiting on the session lane while a turn or configure is running", async () => {
    const configureGate = deferred<void>();
    class SlowConfigureBridge extends FakeBridge {
      override async request<Name extends keyof BridgeMethods>(method: Name, params: BridgeMethods[Name]["params"], timeoutMs?: number): Promise<BridgeMethods[Name]["result"]> {
        if (method === "session.configure") await configureGate.promise;
        return super.request(method, params, timeoutMs);
      }
    }
    const runtime = new SlowConfigureBridge(new Set(), false, false);
    const { connection, events } = await setup(runtime);

    // Admitted configure work is still in the lane.
    void connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "paseo-1",
      changes: { model: "deepseek/chat" },
    });
    await connection.send({ type: "session.can_stop_runtime", requestId: "stop-pending-op", sessionId: "paseo-1" });
    await tick();
    assert.deepEqual(
      events.find((event) => "requestId" in event && event.requestId === "stop-pending-op"),
      { type: "session.can_stop_runtime", requestId: "stop-pending-op", sessionId: "paseo-1", canStop: false },
    );

    configureGate.resolve();
    await tick();
    await tick();

    // Start a turn that remains active.
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: { clientMessageId: "c-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "work" }] } },
    });
    await tick();
    await tick();
    await connection.send({ type: "session.can_stop_runtime", requestId: "stop-active-turn", sessionId: "paseo-1" });
    await tick();
    assert.deepEqual(
      events.find((event) => "requestId" in event && event.requestId === "stop-active-turn"),
      { type: "session.can_stop_runtime", requestId: "stop-active-turn", sessionId: "paseo-1", canStop: false },
    );
    assert.equal(runtime.calls.some((call) => call.method === "session.can_stop_runtime"), false);
    await connection.close();
  });

  for (const blockedBy of ["non-persistent session", "pending interaction"] as const) {
    it(`answers false without a bridge query for a ${blockedBy}`, async () => {
      const runtime = new FakeBridge();
      const { connection, events } = await setup(runtime, defaultCapabilities, blockedBy !== "non-persistent session");
      if (blockedBy === "pending interaction") {
        runtime.notify("interaction.request", {
          sessionId: "native-new", requestId: "question-1", kind: "questions",
          questions: [{ id: "q1", question: "Continue?" }],
        });
      }
      await connection.send({ type: "session.can_stop_runtime", requestId: "stop-blocked", sessionId: "paseo-1" });
      await tick();
      assert.deepEqual(
        events.find((event) => "requestId" in event && event.requestId === "stop-blocked"),
        { type: "session.can_stop_runtime", requestId: "stop-blocked", sessionId: "paseo-1", canStop: false },
      );
      assert.equal(runtime.calls.some((call) => call.method === "session.can_stop_runtime"), false);
      assert.equal(runtime.closeCount, 0);
      await connection.close();
    });
  }

  for (const closing of ["session", "connection"] as const) {
    it(`never answers true when the ${closing} closes during the bridge query`, async () => {
      const queryEntered = deferred<void>();
      const queryResult = deferred<{ canStop: boolean }>();
      class ClosingBridge extends FakeBridge {
        override async request<Name extends keyof BridgeMethods>(method: Name, params: BridgeMethods[Name]["params"], timeoutMs?: number): Promise<BridgeMethods[Name]["result"]> {
          if (method === "session.can_stop_runtime") {
            queryEntered.resolve();
            return queryResult.promise as Promise<BridgeMethods[Name]["result"]>;
          }
          return super.request(method, params, timeoutMs);
        }
      }
      const { connection, events } = await setup(new ClosingBridge());
      await connection.send({ type: "session.can_stop_runtime", requestId: "stop-closing", sessionId: "paseo-1" });
      await queryEntered.promise;
      if (closing === "session") {
        await connection.send({ type: "session.close", requestId: "close-1", sessionId: "paseo-1" });
        await tick();
      } else {
        await connection.close();
      }
      queryResult.resolve({ canStop: true });
      await tick();
      await tick();
      const reply = events.find((event) => "requestId" in event && event.requestId === "stop-closing");
      if (closing === "session") {
        assert.deepEqual(reply, {
          type: "session.can_stop_runtime", requestId: "stop-closing", sessionId: "paseo-1", canStop: false,
        });
      } else {
        assert.equal(reply, undefined, "closed connections cannot publish a late safety response");
      }
      await connection.close();
    });
  }

  it("answers false when activity happens while the bridge safety query is in flight", async () => {
    const queryEntered = deferred<void>();
    const queryResult = deferred<{ canStop: boolean }>();
    class RacingBridge extends FakeBridge {
      override async request<Name extends keyof BridgeMethods>(method: Name, params: BridgeMethods[Name]["params"], timeoutMs?: number): Promise<BridgeMethods[Name]["result"]> {
        if (method === "session.can_stop_runtime") {
          queryEntered.resolve();
          return queryResult.promise as Promise<BridgeMethods[Name]["result"]>;
        }
        return super.request(method, params, timeoutMs);
      }
    }
    const runtime = new RacingBridge();
    const { connection, events } = await setup(runtime);

    await connection.send({ type: "session.can_stop_runtime", requestId: "stop-race", sessionId: "paseo-1" });
    await queryEntered.promise;
    // A turn starts and completes before the bridge answers the older safety snapshot.
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: { clientMessageId: "c-race", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "quick" }] } },
    });
    await tick();
    await tick();
    queryResult.resolve({ canStop: true });
    await tick();
    await tick();

    assert.deepEqual(
      events.find((event) => "requestId" in event && event.requestId === "stop-race"),
      { type: "session.can_stop_runtime", requestId: "stop-race", sessionId: "paseo-1", canStop: false },
    );
    await connection.close();
  });

  it("reports request.failed for an unknown session, a bridge error or a malformed bridge result", async () => {
    class MalformedBridge extends FakeBridge {
      malformed = false;
      override async request<Name extends keyof BridgeMethods>(method: Name, params: BridgeMethods[Name]["params"], timeoutMs?: number): Promise<BridgeMethods[Name]["result"]> {
        if (method === "session.can_stop_runtime" && this.malformed) {
          return { canStop: "yes" } as unknown as BridgeMethods[Name]["result"];
        }
        return super.request(method, params, timeoutMs);
      }
    }
    const runtime = new MalformedBridge(new Set(["session.can_stop_runtime"]));
    const { connection, events } = await setup(runtime);

    await connection.send({ type: "session.can_stop_runtime", requestId: "stop-missing", sessionId: "unknown" });
    await connection.send({ type: "session.can_stop_runtime", requestId: "stop-error", sessionId: "paseo-1" });
    await tick();
    await tick();

    runtime.malformed = true;
    await connection.send({ type: "session.can_stop_runtime", requestId: "stop-bad", sessionId: "paseo-1" });
    await tick();
    await tick();

    for (const requestId of ["stop-missing", "stop-error", "stop-bad"]) {
      assert.ok(events.some((event) => event.type === "request.failed" && event.requestId === requestId), requestId);
    }
    assert.equal(events.some((event) => event.type === "session.can_stop_runtime"), false);
    await connection.close();
  });
});

describe("dsh provider question answers", () => {
  const cases: Array<{ name: string; question: QuestionItem; answer: string; expected: QuestionAnswer }> = [
    {
      name: "keeps a single selected label containing a comma",
      question: { id: "q1", header: "Choice", question: "Continue?", options: [{ label: "Yes, use HTTPS" }, { label: "No" }] },
      answer: "Yes, use HTTPS",
      expected: { id: "q1", selected: ["Yes, use HTTPS"] },
    },
    {
      name: "keeps an entire free-text answer containing commas",
      question: { id: "q1", question: "Which settings?" },
      answer: "Use 8080, keep TLS",
      expected: { id: "q1", selected: [], custom: "Use 8080, keep TLS" },
    },
    {
      name: "keeps an entire Other answer for a single-choice question",
      question: { id: "q1", question: "Which settings?", options: [{ label: "Default" }] },
      answer: "Use 8080, keep TLS",
      expected: { id: "q1", selected: [], custom: "Use 8080, keep TLS" },
    },
    {
      name: "decodes multiple selected labels in click order",
      question: { id: "q1", question: "Which colors?", multiSelect: true, options: [{ label: "Red" }, { label: "Blue" }] },
      answer: "Blue, Red",
      expected: { id: "q1", selected: ["Blue", "Red"] },
    },
    {
      name: "keeps a comma inside a multi-select label",
      question: { id: "q1", question: "Which settings?", multiSelect: true, options: [{ label: "Yes, use HTTPS" }, { label: "Keep 8080" }] },
      answer: "Yes, use HTTPS, Keep 8080",
      expected: { id: "q1", selected: ["Yes, use HTTPS", "Keep 8080"] },
    },
    {
      name: "preserves all custom text after selected labels",
      question: { id: "q1", question: "Which settings?", multiSelect: true, options: [{ label: "HTTPS" }] },
      answer: "HTTPS, Use 8080, keep TLS",
      expected: { id: "q1", selected: ["HTTPS"], custom: "Use 8080, keep TLS" },
    },
    {
      name: "matches the longest complete label before its prefix",
      question: { id: "q1", question: "Which settings?", multiSelect: true, options: [{ label: "Yes" }, { label: "Yes, use HTTPS" }] },
      answer: "Yes, use HTTPS",
      expected: { id: "q1", selected: ["Yes, use HTTPS"] },
    },
    {
      name: "keeps a multi-select Other answer without selected labels",
      question: { id: "q1", question: "Which settings?", multiSelect: true, options: [{ label: "HTTPS" }] },
      answer: "Use 8080, keep TLS",
      expected: { id: "q1", selected: [], custom: "Use 8080, keep TLS" },
    },
  ];
  for (const { name, question, answer, expected } of cases) {
    it(name, async () => {
      const discovery = new FakeBridge();
      const runtime = new FakeBridge();
      const provider = createDshProvider({ createBridge: async (launch) => launch ? runtime : discovery, detectDshVersion: noVersionWarning });
      const connection = await provider.connect({ versions: [1], capabilities: ["permission"] });
      try {
        await openTestSession(connection);
        runtime.notify("interaction.request", {
          sessionId: "native-new", requestId: "question-1", kind: "questions", questions: [question],
        });
        await connection.send({
          type: "session.permission", sessionId: "paseo-1", permissionId: "question-1",
          response: { behavior: "allow", updatedInput: { answers: { [question.header ?? question.id]: answer } } },
        });
        await tick();
        assert.deepEqual(runtime.calls.find((call) => call.method === "interaction.respond")?.params, {
          requestId: "question-1", answers: [expected],
        });
      } finally {
        await connection.close();
      }
    });
  }
});

describe("dsh catalog cache key", () => {
  const keyFor = (configured: { executable?: string; profile?: string }, request: Parameters<NonNullable<ReturnType<typeof createDshProvider>["getCatalogCacheKey"]>>[0] = { scope: "global" }) =>
    createDshProvider({
      configured: () => configured,
      createBridge: async () => {
        throw new Error("the cache key must not launch a bridge");
      },
    }).getCatalogCacheKey!(request);

  it("changes with the effective profile", async () => {
    assert.notEqual(await keyFor({ profile: "a" }), await keyFor({ profile: "b" }));
    assert.equal(await keyFor({}), await keyFor({ profile: DEFAULT_PROFILE }));
  });

  it("changes with the effective executable, including Paseo's launch when none is configured", async () => {
    assert.notEqual(await keyFor({ executable: "/a/dsh" }), await keyFor({ executable: "/b/dsh" }));
    const launch = (command: string) => ({ scope: "global" as const, launch: { command, args: [], env: {} } });
    assert.notEqual(await keyFor({}, launch("/p/dsh")), await keyFor({}, launch("/q/dsh")));
    assert.equal(await keyFor({ executable: "/a/dsh" }, launch("/p/dsh")), await keyFor({ executable: "/a/dsh" }, launch("/q/dsh")));
  });

  it("observes the latest launch even when the catalog cache key stays unchanged", async () => {
    const seen: unknown[] = [];
    const provider = createDshProvider({
      observeLaunch: (launch) => { seen.push(launch); },
      createBridge: async () => { throw new Error("cache lookup must not create a bridge"); },
    });
    const first = { command: "dsh", args: [], env: { DSH_HOME: "/first" } };
    const second = { ...first, env: { DSH_HOME: "/second" } };
    await provider.getCatalogCacheKey!({ scope: "global", launch: first });
    await provider.getCatalogCacheKey!({ scope: "global", launch: second });
    assert.deepEqual(seen, [first, second]);
  });

  it("keeps global and per-workspace discovery apart", async () => {
    const keys = new Set([
      await keyFor({}),
      await keyFor({}, { scope: "workspace", cwd: "/w1" }),
      await keyFor({}, { scope: "workspace", cwd: "/w2" }),
    ]);
    assert.equal(keys.size, 3);
  });
});

describe("dsh provider status", () => {
  const probe = (version: string, seen: string[] = []) => async (executable: string, options?: { args?: readonly string[] }): Promise<string> => {
    seen.push([executable, ...(options?.args ?? [])].join(" "));
    return version;
  };
  const noBridge = async (): Promise<DshBridge> => {
    throw new Error("status() must not launch a bridge");
  };
  const statusFor = (
    executable: string | undefined,
    detect: Parameters<typeof createDshProvider>[0]["detectDshVersion"],
    launch?: { command: string; args: string[]; env: Record<string, string> },
  ) => createDshProvider({ configured: () => ({ executable }), createBridge: noBridge, detectDshVersion: detect }).status!({ launch });

  it("declares dsh as the default command", () => {
    assert.deepEqual(createDshProvider({ createBridge: noBridge }).command, ["dsh"]);
  });

  it("is available without a diagnostic when dsh is on the plugin's line", async () => {
    const seen: string[] = [];
    assert.deepEqual(await statusFor("/opt/dsh", probe(PLUGIN_VERSION, seen)), { available: true });
    assert.deepEqual(seen, ["/opt/dsh"]);
  });

  it("probes the same executable connect would use: override, then launch, then dsh", async () => {
    const launch = { command: "/paseo/dsh", args: ["--flag"], env: { A: "1" } };
    const seen: string[] = [];
    await statusFor("/env/dsh", probe(PLUGIN_VERSION, seen), launch);
    await statusFor(undefined, probe(PLUGIN_VERSION, seen), launch);
    await statusFor(undefined, probe(PLUGIN_VERSION, seen));
    assert.deepEqual(seen, ["/env/dsh", "/paseo/dsh --flag", "dsh"]);
  });

  it("passes the daemon-owned launch environment to the probe", async () => {
    let env: unknown;
    await statusFor(undefined, async (_exe, options) => {
      env = options?.env;
      return PLUGIN_VERSION;
    }, { command: "/p/dsh", args: [], env: { HOME: "/h" } });
    assert.deepEqual(env, { HOME: "/h" });
  });

  it("is unavailable with a diagnostic naming the executable and both override paths", async () => {
    const status = await statusFor("/opt/missing-dsh", probe(""));
    assert.equal(status.available, false);
    assert.match(status.diagnostic ?? "", /\/opt\/missing-dsh --version/);
    assert.match(status.diagnostic ?? "", /agents\.providers\.dsh-pi\.command/);
    assert.match(status.diagnostic ?? "", /PASEO_DSH_EXECUTABLE/);
    assert.match(status.diagnostic ?? "", /plugin settings/);
  });

  it("is unavailable when the version probe rejects", async () => {
    const status = await statusFor(undefined, async () => {
      throw new Error("spawn failed");
    });
    assert.equal(status.available, false);
  });

  it("stays available with the line-mismatch warning for another major.minor line", async () => {
    const status = await statusFor(undefined, probe("9.9.0"));
    assert.equal(status.available, true);
    assert.match(status.diagnostic ?? "", /detected dsh 9\.9\.0/);
  });

  it("hands Paseo's launch to every bridge it creates", async () => {
    const launches: unknown[] = [];
    const provider = createDshProvider({
      createBridge: async (launch) => {
        launches.push(launch?.providerLaunch);
        return new FakeBridge();
      },
      detectDshVersion: noVersionWarning,
    });
    const launch = { command: "/paseo/dsh", args: [], env: {} };
    await provider.connect({ launch, versions: [1], capabilities: [] });
    assert.deepEqual(launches, [launch]);
  });
});

test("a tool result image becomes an assistant message with an encoded file link", async () => {
  const imagePath = process.platform === "win32"
    ? "\\\\server\\share\\shot #1.png"
    : "/cache/images/shot #1.png";
  const imageUrl = process.platform === "win32"
    ? "file://server/share/shot%20%231.png"
    : "file:///cache/images/shot%20%231.png";
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

  bridge.notify("session.event", {
    sessionId: "native-new",
    event: { type: "tool/result", seq: 30, time: 4, data: { turn: 1, step: 1, message: { role: "tool", content: [] } } },
    images: [{ index: 2, status: "ready", path: imagePath, name: "shot.png" }],
  });
  await tick();

  const images = events.filter(
    (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
      event.type === "timeline.item" && event.item.id === "tool-image:30:2",
  );
  assert.equal(images.length, 1);
  const item = images[0]!.item;
  assert.equal(item.type, "assistant_message");
  if (item.type !== "assistant_message") return;
  assert.equal(item.messageId, "tool-image:30:2");
  // The text is a standalone paragraph, so it has leading newlines.
  assert.ok(item.text.includes(`![shot.png](${imageUrl})`));
  await connection.close();
});

test("a tool result without images adds no assistant message", async () => {
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

  bridge.notify("session.event", {
    sessionId: "native-new",
    event: { type: "tool/result", seq: 31, time: 5, data: { turn: 1, step: 1, message: { role: "tool", content: [] } } },
    images: [],
  });
  await tick();

  assert.equal(
    events.filter((event) => event.type === "timeline.item" && event.item.id.startsWith("tool-image:31")).length,
    0,
  );
  await connection.close();
});

test("replaying a resumed session emits tool-result images from historical events", async () => {
  class ReplayImageBridge extends FakeBridge {
    override async request<Name extends keyof BridgeMethods>(
      method: Name,
      params: BridgeMethods[Name]["params"],
      timeoutMs?: number,
    ): Promise<BridgeMethods[Name]["result"]> {
      if (method === "session.open") {
        const open = params as BridgeMethods["session.open"]["params"];
        return {
          sessionId: open.sessionId ?? "native-resumed",
          cwd: open.cwd,
          model: this.initialized.catalog.defaultModel,
          preset: "default",
          permissionPreset: open.permissionPreset ?? "read-only",
          events: [
            {
              type: "tool/call",
              seq: 40,
              time: 4,
              data: { callId: "call-1", name: "read_image", arguments: JSON.stringify({ file_path: "/repo/shot.png" }) },
            },
            {
              type: "tool/result",
              seq: 41,
              time: 5,
              data: {
                turn: 1,
                step: 1,
                message: {
                  role: "tool",
                  toolCallId: "call-1",
                  content: [{ type: "text", text: "<type>image</type>" }],
                },
              },
              images: [{ index: 1, status: "ready", path: "/cache/images/replayed.png", name: "shot.png" }],
            },
          ],
        } as BridgeMethods[Name]["result"];
      }
      return super.request(method, params, timeoutMs);
    }
  }

  const bridge = new ReplayImageBridge();
  const provider = createDshProvider({ createBridge: async () => bridge, detectDshVersion: noVersionWarning });
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open-replay",
    sessionId: "paseo-replay",
    persistence: { version: 1, data: { dshSessionId: "native-resumed" } },
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "replay",
  });
  await tick();
  await tick();

  const imageItems = events.filter(
    (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
      event.type === "timeline.item" && event.item.id === "tool-image:41:1",
  );
  assert.equal(imageItems.length, 1);
  const item = imageItems[0]!.item;
  assert.equal(item.type, "assistant_message");
  if (item.type === "assistant_message") {
    assert.equal(item.messageId, "tool-image:41:1");
    assert.ok(item.text.includes("![shot.png](file:///cache/images/replayed.png)"));
  }
  await connection.close();
});

test("streams live subagent sessions and correlates parent sub_agent tool calls", async () => {
  const bridge = new FakeBridge();
  const provider = createDshProvider({ createBridge: async () => bridge, detectDshVersion: noVersionWarning });
  const connection = await provider.connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "session.persistence",
      "session.subsession",
      "session.can_stop_runtime",
    ],
  });
  assert.ok(connection.capabilities.includes("session.subsession"));

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open-sub",
    sessionId: "paseo-root",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "skip",
  });
  await tick();
  await tick();

  // Parent emits subagent tool/call
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "tool/call",
      seq: 1,
      time: 10,
      data: {
        callId: "call-sub-1",
        name: "subagent",
        arguments: JSON.stringify({
          description: "Audit auth module",
          prompt: "Inspect server/auth.ts and summarize findings",
          agent_preset: "explore",
        }),
      },
    },
    images: [],
  });

  // Bridge announces child session creation followed by setup() descriptor
  bridge.notify("session.child", {
    sessionId: "native-child-1",
    parentSessionId: "native-new",
    cwd: "/repo",
  });
  bridge.notify("session.event", {
    sessionId: "native-child-1",
    event: {
      type: "agent-preset/selected",
      seq: 0,
      time: 11,
      data: { agentPreset: "explore" },
    },
    images: [],
  });
  bridge.notify("session.event", {
    sessionId: "native-child-1",
    event: {
      type: "subagent/descriptor",
      seq: 1,
      time: 12,
      data: { version: 3, mode: "continuable", provider: "spawn", label: "Audit auth module" },
    },
    images: [],
  });

  // Child starts turn and streams assistant text
  bridge.notify("session.event", {
    sessionId: "native-child-1",
    event: {
      type: "user/message",
      seq: 2,
      time: 13,
      data: {
        id: "child-u-1",
        source: { kind: "user" },
        content: [
          { type: "text", text: "Inspect server/auth.ts and summarize findings" },
          {
            type: "text",
            text: 'Your parent agent id is "native-new". Before you finish, send your result to that agent with send_message({ agent_id: "native-new", message: "<final summary>" }).',
          },
        ],
      },
    },
    images: [],
  });

  const childOpened = events.find(
    (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
      event.type === "session.opened" && event.sessionId === "native-child-1",
  );
  assert.ok(childOpened);
  assert.equal(childOpened.parentSessionId, "paseo-root");
  assert.equal(childOpened.restoration, "parent");
  assert.deepEqual(childOpened.capabilities, []);
  assert.equal(childOpened.title, "explore");
  assert.equal(childOpened.description, "Audit auth module");
  assert.equal(childOpened.toolCallId, "call-sub-1");
  bridge.notify("session.event", {
    sessionId: "native-child-1",
    event: { type: "turn/start", seq: 3, time: 14, data: { turn: 1 } },
    images: [],
  });
  bridge.notify("session.stream", {
    sessionId: "native-child-1",
    frame: {
      type: "chunk",
      attemptId: "c-a1",
      revision: 1,
      index: 0,
      time: 15,
      chunk: { type: "text-delta", index: 0, text: "Auth module looks clean." },
    },
  });

  // While child turn is active, session.can_stop_runtime returns canStop: false
  await connection.send({
    type: "session.can_stop_runtime",
    requestId: "stop-while-child-active",
    sessionId: "paseo-root",
  });
  await tick();
  const stopCheck = events.find(
    (event): event is Extract<ProviderEvent, { type: "session.can_stop_runtime" }> =>
      event.type === "session.can_stop_runtime" && event.requestId === "stop-while-child-active",
  );
  assert.equal(stopCheck?.canStop, false);

  bridge.notify("session.event", {
    sessionId: "native-child-1",
    event: { type: "turn/end", seq: 4, time: 16, data: { turn: 1 } },
    images: [],
  });

  const childTurns = events.filter(
    (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
      event.type === "session.turn" && event.sessionId === "native-child-1",
  );
  assert.deepEqual(
    childTurns.map((turn) => turn.state),
    ["started", "completed"],
  );

  const childTimeline = events.filter(
    (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
      event.type === "timeline.item" && event.sessionId === "native-child-1",
  );
  assert.equal(childTimeline.length, 2);
  assert.equal(childTimeline[0]?.item.type, "user_message");
  if (childTimeline[0]?.item.type === "user_message") {
    assert.equal(childTimeline[0].item.text, "Inspect server/auth.ts and summarize findings");
  }
  assert.equal(childTimeline[1]?.item.type, "assistant_message");
  if (childTimeline[1]?.item.type === "assistant_message") {
    assert.equal(childTimeline[1].item.text, "Auth module looks clean.");
  }

  await connection.close();
});

test("replays historical subagent sessions on session.open and degrades when session.subsession is not negotiated", async () => {
  class ReplaySubagentBridge extends FakeBridge {
    override async request<Name extends keyof BridgeMethods>(
      method: Name,
      params: BridgeMethods[Name]["params"],
      timeoutMs?: number,
    ): Promise<BridgeMethods[Name]["result"]> {
      if (method === "session.open") {
        const open = params as BridgeMethods["session.open"]["params"];
        return {
          sessionId: open.sessionId ?? "native-root",
          cwd: open.cwd,
          model: this.initialized.catalog.defaultModel,
          preset: "default",
          permissionPreset: "read-only",
          events: [
            {
              type: "tool/call",
              seq: 1,
              time: 10,
              data: {
                callId: "call-hist-1",
                name: "subagent",
                arguments: JSON.stringify({
                  description: "Check routes",
                  prompt: "Inspect routes.ts",
                  agent_preset: "explore",
                }),
              },
            },
            {
              type: "subagent/catalog",
              seq: 2,
              time: 11,
              data: {
                version: 0,
                childId: "child-hist-1",
                childCreatedAt: 11,
                mode: "continuable",
                label: "Check routes",
              },
            },
            {
              type: "tool/result",
              seq: 3,
              time: 12,
              data: {
                message: {
                  role: "tool",
                  toolCallId: "call-hist-1",
                  content: [{ type: "text", text: "started subagent child-hist-1" }],
                },
              },
            },
          ],
          subagents: [
            {
              sessionId: "child-hist-1",
              parentSessionId: "native-root",
              cwd: "/repo",
              agentPreset: "explore",
              label: "Check routes",
              provider: "spawn",
              events: [
                { type: "turn/start", seq: 0, time: 11, data: { turn: 1 } },
                {
                  type: "assistant/message",
                  seq: 1,
                  time: 12,
                  data: {
                    turn: 1,
                    step: 1,
                    message: { id: "m-1", content: [{ type: "text", text: "Routes verified." }] },
                  },
                },
                { type: "turn/end", seq: 2, time: 13, data: { turn: 1 } },
              ],
            },
          ],
        } as BridgeMethods[Name]["result"];
      }
      return super.request(method, params, timeoutMs);
    }
  }

  // 1. With session.subsession negotiated
  const bridgeWithSub = new ReplaySubagentBridge();
  const providerWithSub = createDshProvider({
    createBridge: async () => bridgeWithSub,
    detectDshVersion: noVersionWarning,
  });
  const connWithSub = await providerWithSub.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence", "session.subsession"],
  });
  const eventsWithSub: ProviderEvent[] = [];
  connWithSub.onEvent((event) => eventsWithSub.push(event));
  await connWithSub.send({
    type: "session.open",
    requestId: "open-with-sub",
    sessionId: "paseo-with-sub",
    persistence: { version: 1, data: { dshSessionId: "native-root" } },
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "replay",
  });
  await tick();
  await tick();

  const childOpened = eventsWithSub.find(
    (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
      event.type === "session.opened" && event.sessionId === "child-hist-1",
  );
  assert.ok(childOpened);
  assert.equal(childOpened.parentSessionId, "paseo-with-sub");
  assert.equal(childOpened.toolCallId, "call-hist-1");
  assert.equal(childOpened.title, "explore");
  assert.equal(childOpened.description, "Check routes");

  const childTurn = eventsWithSub.find(
    (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
      event.type === "session.turn" && event.sessionId === "child-hist-1",
  );
  assert.equal(childTurn?.state, "completed");
  await connWithSub.close();

  // 2. Without session.subsession negotiated (graceful fallback)
  const bridgeWithoutSub = new ReplaySubagentBridge();
  const providerWithoutSub = createDshProvider({
    createBridge: async () => bridgeWithoutSub,
    detectDshVersion: noVersionWarning,
  });
  const connWithoutSub = await providerWithoutSub.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence"],
  });
  const eventsWithoutSub: ProviderEvent[] = [];
  connWithoutSub.onEvent((event) => eventsWithoutSub.push(event));
  await connWithoutSub.send({
    type: "session.open",
    requestId: "open-without-sub",
    sessionId: "paseo-without-sub",
    persistence: { version: 1, data: { dshSessionId: "native-root" } },
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "replay",
  });
  await tick();
  await tick();

  assert.equal(
    eventsWithoutSub.some(
      (event) => "sessionId" in event && event.sessionId === "child-hist-1",
    ),
    false,
  );
  const parentToolCalls = eventsWithoutSub.filter(
    (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
      event.type === "timeline.item" &&
      event.sessionId === "paseo-without-sub" &&
      event.item.type === "tool_call",
  );
  assert.equal(parentToolCalls.length, 2);
  await connWithoutSub.close();
});

test("disambiguates parallel same-description subagents, ignores pre-admission rollback and external catalog entries, and fails running child tools on turn error", async () => {
  const bridge = new FakeBridge();
  const provider = createDshProvider({
    createBridge: async () => bridge,
    detectDshVersion: noVersionWarning,
  });
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence", "session.subsession"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "paseo-root",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "skip",
  });
  await tick();
  await tick();

  // 1. Subagent startup fails after descriptor and before admission: must not emit session.opened
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "tool/call",
      seq: 1,
      time: 1000,
      data: {
        callId: "call-rollback",
        name: "subagent",
        arguments: JSON.stringify({ description: "Fail before admission", prompt: "Work" }),
      },
    },
    images: [],
  });
  bridge.notify("session.child", {
    sessionId: "child-rollback",
    parentSessionId: "native-new",
    cwd: "/repo",
  });
  bridge.notify("session.event", {
    sessionId: "child-rollback",
    event: {
      type: "subagent/descriptor",
      seq: 0,
      time: 1001,
      data: { version: 3, mode: "continuable", provider: "spawn", label: "Fail before admission" },
    },
    images: [],
  });
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "tool/result",
      seq: 2,
      time: 1002,
      data: {
        message: {
          toolCallId: "call-rollback",
          isError: true,
          content: [{ type: "text", text: "cwd does not exist" }],
        },
      },
    },
    images: [],
  });
  assert.equal(
    events.some(
      (event) => event.type === "session.opened" && event.sessionId === "child-rollback",
    ),
    false,
  );

  // 2. External catalog entry: must not emit local child session.opened
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "subagent/catalog",
      seq: 3,
      time: 1003,
      data: { version: 3, childId: "child-external", mode: "external", label: "External worker" },
    },
    images: [],
  });
  assert.equal(
    events.some(
      (event) => event.type === "session.opened" && event.sessionId === "child-external",
    ),
    false,
  );

  // 3. Two parallel subagent calls with identical descriptions where child-b starts before child-a
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "tool/call",
      seq: 4,
      time: 1004,
      data: {
        callId: "call-a",
        name: "subagent",
        arguments: JSON.stringify({ description: "Same description", prompt: "Task A" }),
      },
    },
    images: [],
  });
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "tool/call",
      seq: 5,
      time: 1005,
      data: {
        callId: "call-b",
        name: "subagent",
        arguments: JSON.stringify({ description: "Same description", prompt: "Task B" }),
      },
    },
    images: [],
  });

  bridge.notify("session.child", {
    sessionId: "child-b",
    parentSessionId: "native-new",
    cwd: "/repo",
  });
  bridge.notify("session.event", {
    sessionId: "child-b",
    event: {
      type: "subagent/descriptor",
      seq: 0,
      time: 1006,
      data: { version: 3, mode: "continuable", provider: "spawn", label: "Same description" },
    },
    images: [],
  });
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "subagent/catalog",
      seq: 6,
      time: 1007,
      data: { version: 3, childId: "child-b", mode: "continuable", label: "Same description" },
    },
    images: [],
  });
  bridge.notify("session.event", {
    sessionId: "child-b",
    event: { type: "turn/start", seq: 1, time: 1008, data: { turn: 0 } },
    images: [],
  });
  // Authoritative tool/result for call-b arrives first
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "tool/result",
      seq: 7,
      time: 1009,
      data: {
        message: {
          toolCallId: "call-b",
          content: [{ type: "text", text: "started subagent child-b" }],
        },
      },
    },
    images: [],
  });

  bridge.notify("session.child", {
    sessionId: "child-a",
    parentSessionId: "native-new",
    cwd: "/repo",
  });
  bridge.notify("session.event", {
    sessionId: "child-a",
    event: {
      type: "subagent/descriptor",
      seq: 0,
      time: 1010,
      data: { version: 3, mode: "continuable", provider: "spawn", label: "Same description" },
    },
    images: [],
  });
  bridge.notify("session.event", {
    sessionId: "native-new",
    event: {
      type: "subagent/catalog",
      seq: 8,
      time: 1011,
      data: { version: 3, childId: "child-a", mode: "continuable", label: "Same description" },
    },
    images: [],
  });

  const openedB = events.find(
    (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
      event.type === "session.opened" && event.sessionId === "child-b",
  );
  const openedA = events.find(
    (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
      event.type === "session.opened" && event.sessionId === "child-a",
  );
  assert.equal(openedB?.toolCallId, "call-b");
  assert.equal(openedA?.toolCallId, "call-a");

  // 4. Child turn error settles any running streamed tool call on the child
  bridge.notify("session.stream", {
    sessionId: "child-b",
    frame: {
      type: "chunk",
      attemptId: "att-1",
      index: 0,
      revision: 1,
      time: 1012,
      chunk: {
        type: "tool-call-delta",
        id: "child-tool-1",
        name: "bash",
        argumentsDelta: '{"command":"ls"}',
      },
    },
  });
  bridge.notify("session.event", {
    sessionId: "child-b",
    event: {
      type: "turn/end",
      seq: 2,
      time: 1013,
      data: {
        turn: 0,
        reason: { kind: "error", error: { message: "Stream disconnected" } },
      },
    },
    images: [],
  });

  const childToolItems = events.filter(
    (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
      event.type === "timeline.item" &&
      event.sessionId === "child-b" &&
      event.item.type === "tool_call",
  );
  const lastToolItem = childToolItems.at(-1)?.item;
  assert.equal(lastToolItem?.type, "tool_call");
  if (lastToolItem?.type === "tool_call") {
    assert.equal(lastToolItem.status, "failed");
    assert.equal(lastToolItem.error, "Stream disconnected");
  }

  await connection.close();
});

test("waits for exact parent call identity when an ambiguous child finishes before its launch result", async () => {
  const bridge = new FakeBridge();
  const provider = createDshProvider({
    createBridge: async () => bridge,
    detectDshVersion: noVersionWarning,
  });
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "session.persistence", "session.subsession"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open",
      requestId: "open-early-child",
      sessionId: "paseo-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    await tick();
    await tick();
    let seq = 0;
    const durable = (sessionId: string, type: string, data: Record<string, unknown>) => {
      bridge.notify("session.event", {
        sessionId,
        event: { type, seq: seq++, time: 1, data },
        images: [],
      });
    };
    for (const callId of ["call-a", "call-b"]) {
      durable("native-new", "tool/call", {
        callId,
        name: "subagent",
        arguments: JSON.stringify({ description: "Same task", prompt: "Inspect" }),
      });
    }
    bridge.notify("session.child", {
      sessionId: "child-b",
      parentSessionId: "native-new",
      cwd: "/repo",
    });
    durable("child-b", "subagent/descriptor", { mode: "continuable", label: "Same task" });
    durable("native-new", "subagent/catalog", {
      childId: "child-b", mode: "continuable", label: "Same task",
    });
    durable("child-b", "turn/start", { turn: 1 });
    durable("child-b", "assistant/message", {
      turn: 1, step: 1,
      message: { id: "early-report", content: [{ type: "text", text: "Finished early" }] },
    });
    durable("child-b", "turn/end", { turn: 1 });
    assert.equal(events.some((event) => event.type === "session.opened" && event.sessionId === "child-b"), false);

    durable("native-new", "tool/result", {
      message: { toolCallId: "call-b", content: [{ type: "text", text: "started subagent child-b" }] },
    });
    const childOpened = events.filter(
      (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
        event.type === "session.opened" && event.sessionId === "child-b",
    );
    assert.equal(childOpened.length, 1);
    assert.equal(childOpened[0]?.toolCallId, "call-b");
    const childEvents = events.filter((event) => "sessionId" in event && event.sessionId === "child-b");
    assert.deepEqual(childEvents.map((event) => event.type), [
      "session.opened", "session.turn", "timeline.item", "session.turn",
    ]);
    assert.deepEqual(childEvents.filter((event) => event.type === "session.turn").map((event) => event.state), ["started", "completed"]);
    assert.equal(events.some((event) => event.type === "timeline.item" && event.item.type === "tool_call" && event.item.callId === "call-a" && event.item.detail.type === "sub_agent" && event.item.detail.childSessionId === "child-b"), false);
  } finally {
    await connection.close();
  }
});

test("opens a buffered parent before its already-finished nested subagent", async () => {
  const bridge = new FakeBridge();
  const provider = createDshProvider({ createBridge: async () => bridge, detectDshVersion: noVersionWarning });
  const connection = await provider.connect({
    versions: [1], capabilities: ["prompt.message", "session.persistence", "session.subsession"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  try {
    await connection.send({
      type: "session.open", requestId: "open-nested", sessionId: "paseo-root",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true }, history: "skip",
    });
    await tick();
    await tick();
    let seq = 0;
    const durable = (sessionId: string, type: string, data: Record<string, unknown>) => {
      bridge.notify("session.event", { sessionId, event: { type, seq: seq++, time: 1, data }, images: [] });
    };
    for (const callId of ["call-a", "call-b"]) {
      durable("native-new", "tool/call", {
        callId, name: "subagent", arguments: JSON.stringify({ description: "Same task", prompt: "Inspect" }),
      });
    }
    bridge.notify("session.child", { sessionId: "child-b", parentSessionId: "native-new", cwd: "/repo" });
    durable("child-b", "subagent/descriptor", { mode: "continuable", label: "Same task" });
    durable("native-new", "subagent/catalog", { childId: "child-b", mode: "continuable", label: "Same task" });
    durable("child-b", "turn/start", { turn: 1 });
    durable("child-b", "tool/call", {
      callId: "grand-call", name: "subagent", arguments: JSON.stringify({ description: "Nested task" }),
    });
    bridge.notify("session.child", { sessionId: "grandchild", parentSessionId: "child-b", cwd: "/repo" });
    durable("child-b", "subagent/catalog", { childId: "grandchild", mode: "continuable", label: "Nested task" });
    durable("grandchild", "turn/start", { turn: 1 });
    durable("grandchild", "assistant/message", {
      turn: 1, step: 1, message: { id: "nested-report", content: [{ type: "text", text: "Nested report" }] },
    });
    durable("grandchild", "turn/end", { turn: 1 });
    durable("child-b", "tool/result", {
      message: { toolCallId: "grand-call", content: [{ type: "text", text: "started subagent grandchild" }] },
    });
    durable("child-b", "turn/end", { turn: 1 });
    assert.equal(events.some((event) => "sessionId" in event && ["child-b", "grandchild"].includes(event.sessionId)), false);

    durable("native-new", "tool/result", {
      message: { toolCallId: "call-b", content: [{ type: "text", text: "started subagent child-b" }] },
    });
    const opened = events.filter(
      (event): event is Extract<ProviderEvent, { type: "session.opened" }> =>
        event.type === "session.opened" && ["child-b", "grandchild"].includes(event.sessionId),
    );
    assert.deepEqual(opened.map((event) => [event.sessionId, event.parentSessionId, event.toolCallId]), [
      ["child-b", "paseo-root", "call-b"], ["grandchild", "child-b", "grand-call"],
    ]);
    const grandchildEvents = events.filter((event) => "sessionId" in event && event.sessionId === "grandchild");
    assert.deepEqual(grandchildEvents.map((event) => event.type), ["session.opened", "session.turn", "timeline.item", "session.turn"]);
    assert.deepEqual(grandchildEvents.filter((event) => event.type === "session.turn").map((event) => event.state), ["started", "completed"]);
  } finally {
    await connection.close();
  }
});
