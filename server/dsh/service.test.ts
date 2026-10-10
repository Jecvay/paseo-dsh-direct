import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeService, missingHostSurface, savedModel, validateAnswers } from "./service.js";
import type {
  HostAgent,
  HostContext,
  HostEvents,
  HostServices,
} from "./host.js";
import type {
  BridgeNotifications,
  DshSessionEvent,
} from "../../shared/bridge-protocol.js";

function fixture(
  options: Pick<Partial<HostServices>, "commands" | "skills" | "attachments" | "systemPrompt"> = {},
) {
  const listeners = new Map<keyof HostEvents, unknown>();
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
    agents: {
      get: () => created,
      async create(options) {
        await createGate;
        const agent: HostAgent = {
          id: options.sessionId!,
          ctx,
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
          whenIdle: async () => undefined,
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
    sessionQuery: {
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
    approval: {},
    permissionPresets: undefined,
    commands: options.commands,
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
      listeners.set(event, listener);
      return () => {
        listeners.delete(event);
      };
    },
    effect: () => undefined,
  };
  const bridge = new BridgeService(ctx, (method, params) =>
    notifications.push({ method, params }),
  );
  return {
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
      return listeners.get(event) as HostEvents[K];
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
  const bridge = new BridgeService(ctx as unknown as HostContext, () => undefined);
  const result = await bridge.handle("bridge.initialize");
  assert.deepEqual(result.missing, missing);
  assert.deepEqual(result.catalog.models, []);
});
