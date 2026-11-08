import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { apply, parseRequest } from "./bridge.js";
import { BridgeService, missingHostSurface, savedModel, validateAnswers } from "./service.js";
import type {
  HostAgent,
  HostContext,
  HostEvents,
  HostServices,
  HostSession,
} from "./host.js";
import type {
  BridgeNotifications,
  DshSessionEvent,
} from "../../shared/bridge-protocol.js";

function fixture(
  options: Pick<
    Partial<HostServices>,
    | "commands"
    | "skills"
    | "attachments"
    | "systemPrompt"
    | "sessionProjections"
    | "sessionQuery"
    | "settings"
    | "configEditor"
    | "jobs"
    | "goals"
    | "schedule"
  > = {},
) {
  const listeners = new Map<keyof HostEvents, Array<(...args: any[]) => unknown>>();
  const notifications: Array<{
    method: keyof BridgeNotifications;
    params: unknown;
  }> = [];
  let disposeCount = 0;
  const followups: unknown[] = [];
  let created: HostAgent | undefined;
  let createGate = Promise.resolve();
  const models = { provider: "configured", model: "test" };
  const services = {
    settings: options.settings,
    configEditor: options.configEditor,
    agents: {
      get: () => created,
      list: () => (created ? [created] : []),
      isOwnedBy: () => false,
      async create(options) {
        await createGate;
        const agent: HostAgent = {
          id: options.sessionId!,
          ctx,
          inbox: { nextTurn: [], nextStep: [] },
          options: models,
          status: "idle",
          session: {
            id: options.sessionId!,
            header: { id: options.sessionId!, createdAt: 1, cwd: "/tmp" },
            snapshotEvents: () => [],
            requestHeader: () => undefined,
            append: () => undefined,
          },
          followup: (message) => {
            followups.push(message);
          },
          steer: () => undefined,
          cancel: () => undefined,
          whenIdle: async () => {
            const activityDone = Promise.resolve();
            let activity: Promise<void>;
            do { await (activity = activityDone); } while (activity !== activityDone);
          },
        };
        created = agent;
        await options.setup(ctx, agent);
        return {
          agent,
          dispose: async () => {
            disposeCount++;
            created = undefined;
          },
        };
      },
      resume: async () => {
        throw new Error("Unexpected resume");
      },
    },
    sessionQuery: options.sessionQuery ?? {
      listSessions: async () => [],
      readSession: async () => {
        throw new Error("Unexpected read");
      },
      observeSession: async () => {
        throw new Error("Unexpected observation");
      },
    },
    agentPresets: {
      list: async () => [{ id: "standard" }],
      resolve: async () => ({ id: "standard" }),
      mount: async () => undefined,
      select: async () => "standard",
      defaultId: "standard",
    },
    llm: {
      listProviders: () => [{ id: "broken" }, { id: "configured" }],
      listModels: async (provider: string) => {
        if (provider === "broken") throw new Error("No credential");
        return [{ id: "test" }];
      },
    },
    agentDefaultModel: { currentSelection: () => models },
    sessionProjections: options.sessionProjections,
    approval: {},
    permissionPresets: undefined,
    commands: options.commands,
    jobs: options.jobs ?? { list: () => [] },
    goals: options.goals,
    schedule: options.schedule,
    skills: options.skills,
    attachments: options.attachments,
    systemPrompt: options.systemPrompt,
    userQuestions: {},
    sessionTitle: undefined,
    appReady: undefined,
    appExit: undefined,
  } satisfies HostServices;
  const ctx: HostContext = {
    get: (name) => services[name],
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener as (...args: any[]) => unknown);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(listener as (...args: any[]) => unknown);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect: () => undefined,
  };
  const bridge = new BridgeService(
    ctx,
    (method, params) => notifications.push({ method, params }),
    "/tmp/paseo-dsh-test-images",
  );
  return {
    ctx,
    bridge,
    notifications,
    followups,
    get agent() {
      return created!;
    },
    get disposeCount() {
      return disposeCount;
    },
    blockCreate(promise: Promise<void>) {
      createGate = promise;
    },
    listener<K extends keyof HostEvents>(event: K): HostEvents[K] {
      const list = listeners.get(event) ?? [];
      return ((...args: any[]) => {
        let last: unknown;
        for (const fn of list) last = fn(...args);
        return last;
      }) as HostEvents[K];
    },
  };
}

test("one unavailable model provider does not prevent profile initialization", async () => {
  const f = fixture();
  const result = await f.bridge.handle("bridge.initialize");
  assert.equal(result.catalog.models.length, 1);
  assert.equal(result.catalog.models[0]?.provider, "configured");
  await f.bridge.shutdown();
});

test("missing optional settings leave initialization and normal sessions usable", async () => {
  const f = fixture();
  await f.bridge.handle("bridge.initialize");
  assert.equal((await f.bridge.handle("subagent.settings.read")).supported, false);
  await f.bridge.handle("session.open", { cwd: "/tmp", sessionId: "without-settings" });
  await f.bridge.shutdown();
});

test("failed subagent initialization is visible to settings but does not block normal sessions", async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const f = fixture({
    settings: {
      documentPath: "/test/cordis.patch.yml",
      describe: () => [{ ns: "subagent-model-selection-settings", revision: 0,
        value: { enabled: false, allowedModels: [] } }],
      mutate: async () => { throw new Error("disk full"); },
    },
    configEditor: { configuration: () => [{ entry: {
      options: { id: "subagent-model-selection-settings", config: {} },
    } }] },
  });
  const result = await f.bridge.handle("bridge.initialize");
  assert.equal(result.catalog.models.length, 1);
  assert.match(String(errors[0]?.[0]), /initialization failed: disk full/);
  await assert.rejects(f.bridge.handle("subagent.settings.read"), /initialization failed: disk full/);
  await f.bridge.handle("session.open", { cwd: "/tmp", sessionId: "settings-failed" });
  await f.bridge.shutdown();
});

test("bridge initializes subagent settings and exposes atomic read/save RPCs", async () => {
  let raw: Record<string, unknown> = {};
  let revision = 0;
  let writes = 0;
  const f = fixture({
    settings: {
      documentPath: "/test/cordis.patch.yml",
      describe: () => [{ ns: "subagent-model-selection-settings", revision,
        value: { enabled: false, allowedModels: [], ...raw }, user: raw }],
      mutate: async (_ns, ops, expectedRevision) => {
        assert.equal(expectedRevision, revision);
        for (const op of ops) raw = { ...raw, [op.path[0]!]: op.value };
        revision++;
        writes++;
      },
    },
    configEditor: { configuration: () => [{ entry: {
      options: { id: "subagent-model-selection-settings", config: raw },
    } }] },
  });
  await f.bridge.handle("bridge.initialize");
  const read = await f.bridge.handle("subagent.settings.read");
  assert.deepEqual(read.selection, {
    enabled: true, allowedModels: [{ provider: "configured", model: "test" }],
  });
  assert.deepEqual(read.failedProviders, ["broken"]);
  const saved = await f.bridge.handle("subagent.settings.save", {
    profile: read.profile, revision: read.revision, selection: { enabled: false, allowedModels: [] },
  });
  assert.deepEqual(saved.selection, { enabled: false, allowedModels: [] });
  await f.bridge.handle("bridge.initialize");
  assert.equal(writes, 2);
  await f.bridge.shutdown();
});

test("shutdown waits for an in-flight open and releases its owned handle", async () => {
  const f = fixture();
  let release!: () => void;
  f.blockCreate(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const opening = f.bridge.handle("session.open", {
    cwd: "/tmp",
    sessionId: "only-owner",
  });
  await assert.rejects(
    f.bridge.handle("session.open", { cwd: "/tmp", sessionId: "only-owner" }),
    /already open/,
  );
  const rejection = assert.rejects(opening, /shutting down/);
  const shutdown = f.bridge.shutdown();
  release();
  await Promise.all([rejection, shutdown]);
  assert.equal(f.disposeCount, 1);
});

test("approval answers settle once; closing also withdraws pending questions", async () => {
  const f = fixture();
  await f.bridge.handle("session.open", { cwd: "/tmp", sessionId: "owned" });
  const decision = f.listener("approval/request")(
    { agent: f.agent, toolName: "bash" },
    async () => "unavailable",
  );
  const request = f.notifications.find(
    (item) => item.method === "interaction.request",
  )!.params as BridgeNotifications["interaction.request"];
  await assert.rejects(
    f.bridge.handle("interaction.respond", {
      requestId: request.requestId,
      outcome: "allow-always",
    }),
    /Invalid approval/,
  );
  await f.bridge.handle("interaction.respond", {
    requestId: request.requestId,
    outcome: "allowed-once",
  });
  assert.equal(await decision, "allowed-once");
  await assert.rejects(
    f.bridge.handle("interaction.respond", {
      requestId: request.requestId,
      outcome: "allowed-once",
    }),
    /no longer pending/,
  );
  const question = f.listener("user-questions/request")(
    { agent: f.agent, questions: [{ id: "q", question: "Choose" }] },
    async () => ({ answers: [] }),
  );
  const cancelled = assert.rejects(question, /cancelled/);
  const questionRequest = f.notifications
    .filter((item) => item.method === "interaction.request")
    .at(-1)!.params as BridgeNotifications["interaction.request"];
  await f.bridge.handle("interaction.respond", {
    requestId: questionRequest.requestId,
    outcome: "rejected",
  });
  await cancelled;
  const abandonedQuestion = f.listener("user-questions/request")(
    { agent: f.agent, questions: [{ id: "q2", question: "Choose again" }] },
    async () => ({ answers: [] }),
  );
  const abandoned = assert.rejects(abandonedQuestion, /cancelled/);
  await f.bridge.handle("session.close", { sessionId: "owned" });
  await abandoned;
  assert.equal(f.disposeCount, 1);
  await f.bridge.shutdown();
});

test("input validation rejects malformed RPC values without acquiring a session", async () => {
  const f = fixture();
  await assert.rejects(
    f.bridge.handle("session.open", { cwd: "/tmp", resume: "true" }),
    /resume must be boolean/,
  );
  await assert.rejects(
    f.bridge.handle("session.open", {
      cwd: "/tmp",
      model: { provider: "x", model: "y", reasoningEffort: 3 },
    }),
    /Invalid model/,
  );
  assert.equal(f.disposeCount, 0);
  assert.throws(
    () =>
      validateAnswers(
        [{ id: "q", question: "?", options: [{ label: "yes" }] }],
        [{ id: "q", selected: ["forged"] }],
      ),
    /Invalid question answer/,
  );
  validateAnswers(
    [{ id: "q", question: "?" }],
    [{ id: "q", selected: [], custom: "custom answer" }],
  );
  await f.bridge.shutdown();
});

test("a pending durable model choice survives unrelated request headers on restore", () => {
  const events: DshSessionEvent[] = [
    {
      type: "model/selection",
      seq: 0,
      time: 0,
      data: { provider: "p", model: "chosen" },
    },
    {
      type: "request/header",
      seq: 1,
      time: 0,
      data: { header: { config: { provider: "p", model: "earlier" } } },
    },
  ];
  assert.deepEqual(savedModel(events), { provider: "p", model: "chosen" });
});

test("slash commands merge registered commands with user-invocable skills", async () => {
  const executed: string[] = [];
  const f = fixture({
    commands: {
      list: () => [
        { name: "compact", description: "Compact history" },
        { name: "goal", description: "Set a goal", input: { hint: "objective" } },
      ],
      execute: async (_agent, line) => {
        executed.push(line);
        return line.startsWith("/compact")
          ? { result: { kind: "success", text: "Compacted 3 history items." } }
          : undefined;
      },
    },
    skills: {
      list: async () => [
        { name: "review", description: "Review code", invocation: { userInvocable: true } },
        { name: "internal", description: "Model only", invocation: { userInvocable: false } },
        { name: "compact", description: "Shadowed", invocation: { userInvocable: true } },
      ],
    },
  });
  const { sessionId } = await f.bridge.handle("session.open", { cwd: "/tmp" });
  const { commands } = await f.bridge.handle("session.commands", { sessionId });
  assert.deepEqual(commands, [
    { name: "compact", description: "Compact history", kind: "command" },
    { name: "goal", description: "Set a goal", argumentHint: "objective", kind: "command" },
    { name: "review", description: "Review code", kind: "skill" },
  ]);
  assert.deepEqual(
    await f.bridge.handle("session.command", { sessionId, name: "compact", arguments: "" }),
    { kind: "success", text: "Compacted 3 history items.", running: false },
  );
  await assert.rejects(
    f.bridge.handle("session.command", { sessionId, name: "missing", arguments: "x y" }),
    /Unknown DSH command: \/missing/,
  );
  assert.deepEqual(executed, ["/compact", "/missing x y"]);
  await f.bridge.shutdown();
});

test("prompt images and files become durable DSH attachment blocks in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-dsh-file-"));
  const file = join(dir, "notes.txt");
  await writeFile(file, "hello");
  const saved: string[] = [];
  const f = fixture({
    attachments: {
      saveImage: async (input) => {
        saved.push(`image:${input.mediaType}:${Buffer.from(input.data).toString()}`);
        return { attachmentId: "img-1" };
      },
      saveFile: async (input) => {
        saved.push(`file:${input.name}:${Buffer.from(input.data).toString()}`);
        return { attachmentId: "file-1", name: input.name };
      },
    },
  });
  const { sessionId } = await f.bridge.handle("session.open", { cwd: "/tmp" });
  await f.bridge.handle("session.prompt", {
    sessionId,
    content: [
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", data: Buffer.from("png").toString("base64") },
      { type: "file", path: file },
    ],
  });
  assert.deepEqual(saved, ["image:image/png:png", "file:notes.txt:hello"]);
  assert.deepEqual((f.followups[0] as { content: unknown }).content, [
    { type: "text", text: "look" },
    { type: "image", attachment: { attachmentId: "img-1" } },
    { type: "file", attachment: { attachmentId: "file-1", name: "notes.txt" } },
  ]);
  await assert.rejects(
    f.bridge.handle("session.prompt", {
      sessionId,
      content: [{ type: "image", mediaType: "image/bmp", data: "AA==" }],
    }),
    /Unsupported image type/,
  );
  await f.bridge.shutdown();
});

test("session options add an agent-scoped system prompt and preapprove named tools", async () => {
  const sections: unknown[] = [];
  const f = fixture({ systemPrompt: { section: (definition) => sections.push(definition) } });
  const { sessionId } = await f.bridge.handle("session.open", {
    cwd: "/tmp",
    systemPrompt: "Paseo rules",
    preapprovedTools: ["mcp__paseo__create_agent"],
  });
  assert.deepEqual(sections, [{ name: "paseo:system-prompt", order: 10100, text: "Paseo rules" }]);
  const approve = f.listener("approval/request");
  const ask = async () => "rejected" as const;
  assert.equal(
    await approve({ agent: f.agent, toolName: "mcp__paseo__create_agent" }, ask),
    "allowed-once",
  );
  const pending = approve({ agent: f.agent, toolName: "bash" }, ask);
  const request = f.notifications.find((n) => n.method === "interaction.request")?.params as { requestId: string };
  assert.ok(request, "an unlisted tool still asks the user");
  await f.bridge.handle("interaction.respond", { requestId: request.requestId, outcome: "rejected" });
  assert.equal(await pending, "rejected");
  await f.bridge.handle("session.close", { sessionId });
  await f.bridge.shutdown();
});

test("the handshake lists host services and methods the DSH does not provide", async () => {
  const f = fixture();
  assert.equal((await f.bridge.handle("bridge.initialize")).missing, undefined);
  const services: Record<string, unknown> = {
    agents: { get() {}, create() {} },
    sessionQuery: { listSessions() {}, readSession() {}, observeSession() {} },
    agentPresets: { list() {}, resolve() {}, mount() {}, select() {} },
  };
  const ctx = { get: (name: string) => services[name], on: () => () => {}, effect: () => undefined };
  const missing = missingHostSurface(ctx as unknown as HostContext);
  assert.deepEqual(missing, ["agents.resume", "llm"]);
  const bridge = new BridgeService(
    ctx as unknown as HostContext,
    () => undefined,
    "/tmp/paseo-dsh-test-images",
  );
  const result = await bridge.handle("bridge.initialize");
  assert.deepEqual(result.missing, missing);
  assert.deepEqual(result.catalog.models, []);
});

test("token projections become session usage without repeating an unchanged fold", async () => {
  const listeners: Array<(session: unknown, key: string) => void> = [];
  let values: Partial<Record<string, unknown>> = {};
  const f = fixture({
    sessionProjections: {
      snapshot: () => ({ values }),
      onChanged: (listener) => {
        listeners.push(listener as (session: unknown, key: string) => void);
        return () => undefined;
      },
    },
  });
  const { sessionId } = await f.bridge.handle("session.open", { cwd: "/tmp" });
  assert.equal(listeners.length, 1, "the bridge subscribes to the projection change feed");
  const fire = (key: string) => listeners[0]!({ id: sessionId }, key);
  const usage = () =>
    f.notifications
      .filter((n) => n.method === "session.usage")
      .map((n) => n.params as { sessionId: string; usage: Record<string, number> });

  // The units materialize at zero before any provider usage lands.
  values = {
    tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    contextPressure: { contextWindow: 262144 },
  };
  fire("tokenUsage");
  assert.deepEqual(usage(), [], "a warm-up fold carrying no measured token is not sent");

  values = {
    tokenUsage: { uncachedInputTokens: 4923, cacheReadTokens: 21120, outputTokens: 51 },
    contextPressure: { contextWindow: 262144, pressureTokens: 13076 },
  };
  fire("tokenUsage");
  assert.deepEqual(usage(), [
    {
      sessionId,
      usage: {
        inputTokens: 4923,
        cachedInputTokens: 21120,
        outputTokens: 51,
        contextWindowUsedTokens: 13076,
        contextWindowMaxTokens: 262144,
      },
    },
  ]);

  fire("contextPressure");
  assert.equal(usage().length, 1, "an unchanged fold is not re-sent");
  fire("sessionStats");
  assert.equal(usage().length, 1, "a projection the bridge does not track publishes nothing");

  values = {
    tokenUsage: { uncachedInputTokens: 5000, cacheReadTokens: 30000, outputTokens: 60 },
    contextPressure: { contextWindow: 262144, pressureTokens: 14000 },
  };
  fire("tokenUsage");
  assert.equal(usage().length, 2, "a changed fold is sent");

  await f.bridge.handle("session.close", { sessionId });
  fire("tokenUsage");
  assert.equal(usage().length, 2, "a closed session publishes nothing");
  await f.bridge.handle("session.open", { cwd: "/tmp", sessionId });
  fire("tokenUsage");
  assert.equal(usage().length, 3, "a reopened session starts from a fresh fold");

  await f.bridge.handle("session.close", { sessionId });
  await f.bridge.shutdown();
});

test("context usage prefers the compaction projection over the raw prompt size", async () => {
  const listeners: Array<(session: unknown, key: string) => void> = [];
  let values: Partial<Record<string, unknown>> = {};
  const f = fixture({
    sessionProjections: {
      snapshot: () => ({ values }),
      onChanged: (listener) => {
        listeners.push(listener as (session: unknown, key: string) => void);
        return () => undefined;
      },
    },
  });
  const { sessionId } = await f.bridge.handle("session.open", { cwd: "/tmp" });
  const fire = (key: string) => listeners[0]!({ id: sessionId }, key);
  const used = () =>
    f.notifications
      .filter((n) => n.method === "session.usage")
      .map(
        (n) =>
          (n.params as { usage: { contextWindowUsedTokens?: number } }).usage
            .contextWindowUsedTokens,
      );

  // After a compaction dsh 0.2.1+ projects the prompt size down without
  // waiting for the next request's provider-reported usage.
  values = {
    tokenUsage: { uncachedInputTokens: 4923, cacheReadTokens: 21120, outputTokens: 51 },
    contextPressure: {
      contextWindow: 262144,
      pressureTokens: 382221,
      projectedTokens: 24979,
    },
  };
  fire("contextPressure");
  assert.deepEqual(used(), [24979]);

  // dsh before 0.2.1 writes no shadow price, so only the raw prompt size exists.
  values = {
    tokenUsage: { uncachedInputTokens: 4923, cacheReadTokens: 21120, outputTokens: 51 },
    contextPressure: { contextWindow: 262144, pressureTokens: 382221 },
  };
  fire("contextPressure");
  assert.deepEqual(used(), [24979, 382221]);

  await f.bridge.handle("session.close", { sessionId });
  await f.bridge.shutdown();
});

test("session.list folds titles only for the rows it returns and caches them", async () => {
  const headers = [
    { id: "old", createdAt: 1, cwd: "/repo" },
    { id: "new", createdAt: 3, cwd: "/repo" },
    { id: "mid", createdAt: 2, cwd: "/elsewhere" },
  ];
  const folds: string[][] = [];
  const f = fixture({
    sessionQuery: {
      listSessions: async () => headers.map((header) => ({ header })),
      readSession: async () => {
        throw new Error("Unexpected read");
      },
      observeSession: async () => {
        throw new Error("Unexpected observation");
      },
      async readTitleSnapshots(ids) {
        folds.push(ids);
        return ids.map((id) => ({
          status: "fulfilled" as const,
          value: { title: { title: `title ${id}` } },
        }));
      },
    },
  });

  // cwd and limit run before the fold, newest first: only the returned row is decoded.
  const listed = await f.bridge.handle("session.list", { cwd: "/repo", limit: 1 });
  assert.deepEqual(listed.sessions, [
    { id: "new", createdAt: 3, cwd: "/repo", title: "title new" },
  ]);
  assert.deepEqual(folds, [["new"]]);

  // The cached title is not decoded again; only unknown rows are read.
  const second = await f.bridge.handle("session.list", { cwd: "/repo", limit: 2 });
  assert.deepEqual(
    second.sessions.map((session) => session.id),
    ["new", "old"],
  );
  assert.deepEqual(folds, [["new"], ["old"]]);
});

test("a title query folds every title once and then filters from the cache", async () => {
  const headers = [
    { id: "old", createdAt: 1, cwd: "/repo" },
    { id: "live", createdAt: 9, cwd: "/repo", title: "Live header" },
    { id: "mid", createdAt: 2, cwd: "/repo" },
  ];
  const folds: string[][] = [];
  const f = fixture({
    sessionQuery: {
      listSessions: async () => headers.map((header) => ({ header })),
      readSession: async () => {
        throw new Error("Unexpected read");
      },
      observeSession: async () => {
        throw new Error("Unexpected observation");
      },
      async readTitleSnapshots(ids) {
        folds.push(ids);
        return ids.map((id) => ({
          status: "fulfilled" as const,
          value: { title: { title: `title ${id}` } },
        }));
      },
    },
  });

  const byTitle = await f.bridge.handle("session.list", { query: "TITLE OLD" });
  assert.deepEqual(
    byTitle.sessions.map((session) => session.id),
    ["old"],
  );
  assert.deepEqual([folds.at(0), folds.at(-1)], [["old", "mid"], ["old", "mid"]], "the live header title is not folded");

  // The second query answers from the cache without touching the logs again.
  const byId = await f.bridge.handle("session.list", { query: "mid" });
  assert.deepEqual(
    byId.sessions.map((session) => session.id),
    ["mid"],
  );
  assert.equal(folds.length, 1);
});

test("session.list rejects a malformed window", async () => {
  const f = fixture();
  await assert.rejects(
    f.bridge.handle("session.list", { limit: 0 }),
    /limit must be a positive integer/,
  );
  await assert.rejects(
    f.bridge.handle("session.list", { query: 42 }),
    /query must be a string/,
  );
});

test("session.can_stop_runtime parses on the wire and tracks bridge interactions and subagent runs", async () => {
  const parsed = parseRequest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session.can_stop_runtime",
      params: { sessionId: "s-1" },
    }),
  );
  assert.equal(parsed.method, "session.can_stop_runtime");

  const f = fixture();
  await f.bridge.handle("session.open", { sessionId: "s-1", cwd: "/tmp" });
  assert.deepEqual(
    await f.bridge.handle("session.can_stop_runtime", { sessionId: "s-1" }),
    { canStop: true },
  );

  // An in-flight subagent run (external or awaiting settlement notice) vetoes stop.
  f.listener("subagent/start")({
    runId: "run-1",
    id: "child-ext",
    local: false,
  });
  assert.deepEqual(
    await f.bridge.handle("session.can_stop_runtime", { sessionId: "s-1" }),
    { canStop: false },
  );
  f.listener("subagent/end")({
    runId: "run-1",
    id: "child-ext",
    local: false,
  });
  assert.deepEqual(
    await f.bridge.handle("session.can_stop_runtime", { sessionId: "s-1" }),
    { canStop: true },
  );

  // A pending approval interaction vetoes stop until answered.
  const approval = f.listener("approval/request")(
    {
      agent: f.agent,
      toolName: "bash",
    },
    async () => "unavailable",
  );
  assert.deepEqual(
    await f.bridge.handle("session.can_stop_runtime", { sessionId: "s-1" }),
    { canStop: false },
  );
  const requestId = (f.notifications.at(-1)?.params as { requestId: string })
    .requestId;
  await f.bridge.handle("interaction.respond", {
    requestId,
    outcome: "allowed-once",
  });
  await approval;
  assert.deepEqual(
    await f.bridge.handle("session.can_stop_runtime", { sessionId: "s-1" }),
    { canStop: true },
  );
});

test("session.can_stop_runtime observes subagent admission while schedule lookup awaits", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: (rows: unknown[]) => void;
  const listed = new Promise<unknown[]>((resolve) => { release = resolve; });
  const f = fixture({ schedule: { list: () => { entered(); return listed; } } });
  await f.bridge.handle("session.open", { sessionId: "s-1", cwd: "/tmp" });
  const query = f.bridge.handle("session.can_stop_runtime", { sessionId: "s-1" });
  await started;
  const run = { runId: "late-external", id: "external", local: false };
  f.listener("subagent/start")(run);
  release([]);
  assert.deepEqual(await query, { canStop: false });
  f.listener("subagent/end")(run);
  assert.deepEqual(
    await f.bridge.handle("session.can_stop_runtime", { sessionId: "s-1" }),
    { canStop: true },
  );
});

test("tool images defer complete notification params while ordinary events stay plain", async () => {
  const f = fixture({
    attachments: {
      saveImage: async () => ({}),
      saveFile: async () => ({}),
      readImage: async () => ({ ref: {}, data: new Uint8Array([1]) }),
    },
  });
  await f.bridge.handle("session.open", { cwd: "/tmp", sessionId: "images" });

  const listener = f.listener("session/event");
  const ordinary = { type: "turn/start", seq: 8, time: 999, data: { turn: 1 } };
  listener(f.agent.session, ordinary);
  assert.deepEqual(f.notifications.at(-1), {
    method: "session.event",
    params: { sessionId: "images", event: ordinary, images: [] },
  });
  listener(f.agent.session, {
    type: "tool/result",
    seq: 9,
    time: 1_000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "call-1",
        source: { kind: "tool", callId: "call-1" },
        content: [
          { type: "text", text: "<type>image</type>" },
          {
            type: "image",
            attachment: {
              attachmentId: `sha256:${"a".repeat(64)}`,
              mediaType: "image/png",
              bytes: 1,
              width: 1,
              height: 1,
            },
          },
        ],
      },
    },
  });

  const notification = f.notifications.at(-1)!;
  assert.equal(notification.method, "session.event");
  assert.ok(notification.params instanceof Promise);
  const params = await notification.params as BridgeNotifications["session.event"];
  assert.equal(params.sessionId, "images");
  assert.equal(params.event.seq, 9);
  assert.ok(Array.isArray(params.images));
  assert.equal(params.images.length, 1);
  await f.bridge.shutdown();
});

test("bridge output resolves image params before serializing and before a later RPC response", { timeout: 5_000 }, async (t) => {
  let releaseImage!: () => void;
  const imageGate = new Promise<void>((resolve) => { releaseImage = resolve; });
  let listCalled!: () => void;
  const listing = new Promise<void>((resolve) => { listCalled = resolve; });
  const f = fixture({
    attachments: {
      saveImage: async () => ({}),
      saveFile: async () => ({}),
      readImage: async () => { await imageGate; return { ref: {}, data: new Uint8Array([1]) }; },
    },
    sessionQuery: {
      listSessions: async () => { listCalled(); return []; },
      readSession: async () => { throw new Error("Unexpected read"); },
      observeSession: async () => { throw new Error("Unexpected observation"); },
    },
  });
  // Reuse the host fixture with apply's own BridgeService and output path.
  await f.bridge.shutdown();
  const imagesDir = await mkdtemp(join(tmpdir(), "paseo-bridge-output-"));
  const input = new PassThrough();
  const records: Array<{ id?: number; method?: string; params?: BridgeNotifications["session.event"] }> = [];
  let opened!: () => void;
  const openResponse = new Promise<void>((resolve) => { opened = resolve; });
  let listed!: () => void;
  const listResponse = new Promise<void>((resolve) => { listed = resolve; });
  const output = new Writable({
    write(chunk, _encoding, done) {
      const record = JSON.parse(chunk.toString());
      records.push(record);
      if (record.id === 1) opened();
      if (record.id === 2) listed();
      done();
    },
  });
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
  const argv = process.argv;
  let ready!: () => void;
  let dispose: (() => void | Promise<void>) | undefined;
  t.after(async () => {
    releaseImage();
    try {
      await dispose?.();
    } finally {
      Object.defineProperty(process, "stdin", stdin);
      Object.defineProperty(process, "stdout", stdout);
      process.argv = argv;
      input.destroy();
      output.destroy();
      await rm(imagesDir, { recursive: true, force: true });
    }
  });
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  // The synthetic host has no installed DSH module closure to resolve.
  process.argv = [];
  await apply({
    ...f.ctx,
    get: ((name: keyof HostServices) => {
      if (name === "appReady") return { onReady: (listener: () => void) => { ready = listener; return () => undefined; } };
      if (name === "appExit") return () => undefined;
      return f.ctx.get(name);
    }) as HostContext["get"],
    effect: (callback) => { dispose = callback(); },
  }, { imagesDir });
  process.argv = argv;
  ready();
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.open", params: { sessionId: "images", cwd: "/tmp" } })}\n`);
  await openResponse;

  f.listener("session/event")(f.agent.session, {
    type: "tool/result", seq: 9, time: 1_000,
    data: { message: { role: "tool", content: [{
      type: "image",
      attachment: { attachmentId: `sha256:${"e".repeat(64)}`, mediaType: "image/png", bytes: 1, width: 1, height: 1 },
    }] } },
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.list", params: {} })}\n`);
  await listing;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(records.some((record) => record.id === 2), false);
  assert.equal(records.some((record) => record.method === "session.event"), false);

  releaseImage();
  await listResponse;
  const event = records.at(-2)!;
  assert.equal(event.method, "session.event");
  assert.equal(event.params?.sessionId, "images");
  assert.equal(event.params?.event.seq, 9);
  assert.ok(Array.isArray(event.params?.images));
  assert.deepEqual(event.params.images, [{ index: 0, status: "ready", path: join(imagesDir, `${"e".repeat(64)}.png`) }]);
  assert.equal(records.at(-1)?.id, 2);
});

test("session.read materializes tool-result images onto historical events", async () => {
  const historicalEvent: DshSessionEvent = {
    type: "tool/result",
    seq: 12,
    time: 1_000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "call-history",
        source: { kind: "tool", callId: "call-history" },
        content: [
          { type: "text", text: "<type>image</type>" },
          {
            type: "image",
            attachment: {
              attachmentId: `sha256:${"b".repeat(64)}`,
              mediaType: "image/png",
              bytes: 1,
              width: 1,
              height: 1,
              name: "history.png",
            },
          },
        ],
      },
    },
  };
  const f = fixture({
    attachments: {
      saveImage: async () => ({}),
      saveFile: async () => ({}),
      readImage: async () => ({ ref: {}, data: new Uint8Array([1]) }),
    },
    sessionQuery: {
      listSessions: async () => [],
      readSession: async (sessionId) => ({
        session: { id: sessionId, createdAt: 1, cwd: "/tmp" },
        events: [historicalEvent],
        inheritedEventCount: 0,
      }),
      observeSession: async () => ({
        projections: { values: { agentPreset: "standard" } },
        [Symbol.dispose]: () => undefined,
      }),
    },
  });

  const snapshot = await f.bridge.handle("session.read", { sessionId: "resumed-1" });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.images?.length, 1);
  assert.equal(snapshot.events[0]?.images?.[0]?.status, "ready");
  if (snapshot.events[0]?.images?.[0]?.status === "ready") {
    assert.equal(snapshot.events[0].images[0].name, "history.png");
  }
  await f.bridge.shutdown();
});

test("tracks subagent child sessions, filters inherited fork events and collects subagent snapshots on resume", async () => {
  const childEvents: DshSessionEvent[] = [
    {
      type: "user/message",
      seq: 0,
      time: 1,
      data: { id: "inherited-parent-msg", source: { kind: "user" }, content: [{ type: "text", text: "parent seed" }] },
    },
    {
      type: "session/end-seed",
      seq: 1,
      time: 2,
      data: { inherited: true },
    },
    {
      type: "agent-preset/selected",
      seq: 2,
      time: 3,
      data: { agentPreset: "explore" },
    },
    {
      type: "subagent/descriptor",
      seq: 3,
      time: 4,
      data: { version: 3, mode: "continuable", provider: "fork", label: "Inspect auth" },
    },
    {
      type: "user/message",
      seq: 4,
      time: 5,
      data: { id: "child-msg", source: { kind: "user" }, content: [{ type: "text", text: "Check auth.ts" }] },
    },
  ];
  const rootHistory: DshSessionEvent[] = [
    {
      type: "subagent/catalog",
      seq: 0,
      time: 10,
      data: { version: 0, childId: "child-persisted", childCreatedAt: 10, mode: "continuable", label: "Inspect auth" },
    },
  ];
  let projectionHook: ((session: HostSession, key: string) => void) | undefined;
  const f = fixture({
    sessionProjections: {
      snapshot: () => ({ values: { tokenUsage: { uncachedInputTokens: 120, outputTokens: 30 } } }),
      onChanged: (listener) => {
        projectionHook = (session, key) => listener(session, key, undefined, 1);
        return () => undefined;
      },
    },
    sessionQuery: {
      listSessions: async () => [],
      readSession: async (sessionId) => {
        if (sessionId === "root-resume") {
          return {
            session: { id: "root-resume", createdAt: 1, cwd: "/tmp" },
            events: rootHistory,
            inheritedEventCount: 0,
          };
        }
        if (sessionId === "child-persisted") {
          return {
            session: {
              id: "child-persisted",
              createdAt: 2,
              cwd: "/tmp/sub",
              parentSession: "root-resume",
              agentPreset: "standard",
            },
            events: childEvents,
            inheritedEventCount: 1,
          };
        }
        throw new Error(`Unexpected session read: ${sessionId}`);
      },
      observeSession: async () => ({
        projections: { values: { agentPreset: "standard" } },
        [Symbol.dispose]: () => undefined,
      }),
    },
  });
  f.ctx.get("agents").resume = async (options) => {
    const handle = await f.ctx.get("agents").create({
      ...options,
      sessionId: options.resumeSessionId,
    });
    handle.agent.session.snapshotEvents = () => rootHistory;
    return handle;
  };

  const opened = await f.bridge.handle("session.open", {
    sessionId: "root-resume",
    resume: true,
    cwd: "/tmp",
  });
  assert.equal(opened.subagents?.length, 1);
  assert.deepEqual(opened.subagents?.[0], {
    sessionId: "child-persisted",
    parentSessionId: "root-resume",
    cwd: "/tmp/sub",
    agentPreset: "explore",
    label: "Inspect auth",
    provider: "fork",
    events: childEvents.slice(1),
  });

  const liveChildSession: HostSession = {
    id: "child-live",
    header: {
      id: "child-live",
      createdAt: 20,
      cwd: "/tmp",
      parentSession: "root-resume",
      agentPreset: "coder",
    },
    inheritedEventCount: 2,
    snapshotEvents: () => [],
    requestHeader: () => undefined,
    append: () => undefined,
  };
  f.listener("session/created")(liveChildSession);
  assert.deepEqual(f.notifications.at(-1), {
    method: "session.child",
    params: {
      sessionId: "child-live",
      parentSessionId: "root-resume",
      cwd: "/tmp",
      agentPreset: "coder",
    },
  });

  // Inherited seed events (seq < inheritedEventCount) are suppressed; child-owned events forward.
  f.listener("session/event")(liveChildSession, {
    type: "user/message",
    seq: 1,
    time: 21,
    data: { id: "seed", source: { kind: "user" }, content: [] },
  });
  assert.notEqual(f.notifications.at(-1)?.method, "session.event");

  const childOwnEvent: DshSessionEvent = {
    type: "subagent/descriptor",
    seq: 2,
    time: 22,
    data: { version: 3, mode: "continuable", provider: "fork", label: "Write tests" },
  };
  f.listener("session/event")(liveChildSession, childOwnEvent);
  assert.deepEqual(f.notifications.at(-1), {
    method: "session.event",
    params: { sessionId: "child-live", event: childOwnEvent, images: [] },
  });

  // Child token usage must not publish as root usage.
  const countBeforeUsage = f.notifications.length;
  projectionHook?.(liveChildSession, "tokenUsage");
  assert.equal(f.notifications.length, countBeforeUsage);

  // Closing the root session stops forwarding child events.
  await f.bridge.handle("session.close", { sessionId: "root-resume" });
  const countAfterClose = f.notifications.length;
  f.listener("session/event")(liveChildSession, {
    type: "turn/start",
    seq: 3,
    time: 23,
    data: { turn: 1 },
  });
  assert.equal(f.notifications.length, countAfterClose);
  await f.bridge.shutdown();
});
