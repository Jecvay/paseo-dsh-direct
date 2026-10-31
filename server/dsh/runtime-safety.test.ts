import assert from "node:assert/strict";
import test from "node:test";
import type { HostAgent, HostContext, HostEvents, HostServices } from "./host.js";
import { canStopSessionRuntime, SubagentRunTracker } from "./runtime-safety.js";

function makeAgent(
  id: string,
  ctx: HostContext,
  options: {
    status?: "idle" | "running";
    nextTurn?: unknown[];
    nextStep?: unknown[];
    parentSession?: string;
    whenIdle?: () => Promise<void>;
    includeInbox?: boolean;
  } = {},
): HostAgent {
  return {
    id,
    ctx,
    options: { provider: "deepseek", model: "deepseek-chat" },
    status: options.status ?? "idle",
    ...(options.includeInbox === false
      ? {}
      : {
          inbox: {
            nextTurn: options.nextTurn ?? [],
            nextStep: options.nextStep ?? [],
          },
        }),
    session: {
      id,
      header: {
        id,
        createdAt: 1,
        cwd: "/tmp",
        ...(options.parentSession
          ? { parentSession: options.parentSession }
          : {}),
      },
      snapshotEvents: () => [],
      requestHeader: () => undefined,
      append: () => undefined,
    },
    followup: () => undefined,
    steer: () => undefined,
    cancel: () => undefined,
    whenIdle: options.whenIdle ?? (async () => {
      const activityDone = Promise.resolve();
      let activity: Promise<void>;
      do { await (activity = activityDone); } while (activity !== activityDone);
    }),
  };
}

function makeHarness(
  overrides: {
    agents?: Partial<HostServices["agents"]>;
    jobs?: HostServices["jobs"];
    goals?: HostServices["goals"];
    schedule?: HostServices["schedule"];
  } = {},
) {
  const listeners = new Map<keyof HostEvents, Array<(...args: any[]) => unknown>>();
  const live = new Map<string, HostAgent>();
  const ownedBy = new Map<string, HostAgent>();
  const ctx: HostContext = {
    get<K extends keyof HostServices>(name: K): HostServices[K] {
      if (name === "agents") {
        return {
          get: (id: string) => live.get(id),
          list: () => [...live.values()],
          isOwnedBy: (id: string, owner: HostAgent) => ownedBy.get(id) === owner,
          create: async () => {
            throw new Error("not used");
          },
          resume: async () => {
            throw new Error("not used");
          },
          ...overrides.agents,
        } as HostServices[K];
      }
      if (name === "jobs") {
        return ("jobs" in overrides
          ? overrides.jobs
          : {
              list: () => [],
            }) as HostServices[K];
      }
      if (name === "goals") return overrides.goals as HostServices[K];
      if (name === "schedule") return overrides.schedule as HostServices[K];
      return undefined as HostServices[K];
    },
    on(event, listener) {
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
  const root = makeAgent("root-1", ctx);
  live.set(root.id, root);
  return {
    ctx,
    root,
    live,
    ownedBy,
    listenerCount(event: keyof HostEvents) {
      return listeners.get(event)?.length ?? 0;
    },
    emit<K extends keyof HostEvents>(
      event: K,
      ...args: Parameters<HostEvents[K]>
    ) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
}

test("canStopSessionRuntime allows an idle session with empty inbox and no active jobs", async () => {
  const { ctx, root } = makeHarness({
    jobs: {
      list: () => [
        { id: "bash-done", owner: "root-1", status: "completed" },
        { id: "bash-killed", status: "killed" },
      ],
    },
  });
  const canStop = await canStopSessionRuntime({
    ctx,
    sessionId: "root-1",
    rootAgent: root,
    hasBridgeActivity: () => false,
    hasActiveSubagentRuns: () => false,

  });
  assert.equal(canStop, true);
});

test("canStopSessionRuntime vetoes missing required inspection surfaces", async () => {
  const withoutList = makeHarness({
    agents: { list: undefined },
  });
  assert.equal(
    await canStopSessionRuntime({
      ctx: withoutList.ctx,
      sessionId: "root-1",
      rootAgent: withoutList.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );

  const withoutJobs = makeHarness({
    jobs: undefined,
  });
  assert.equal(
    await canStopSessionRuntime({
      ctx: withoutJobs.ctx,
      sessionId: "root-1",
      rootAgent: withoutJobs.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );

  const withoutInbox = makeHarness();
  const rootWithoutInbox = makeAgent("root-1", withoutInbox.ctx, {
    includeInbox: false,
  });
  withoutInbox.live.set("root-1", rootWithoutInbox);
  assert.equal(
    await canStopSessionRuntime({
      ctx: withoutInbox.ctx,
      sessionId: "root-1",
      rootAgent: rootWithoutInbox,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );
});

test("canStopSessionRuntime vetoes running, maintenance, and queued inbox work", async () => {
  const running = makeHarness();
  running.root.status = "running";
  assert.equal(
    await canStopSessionRuntime({
      ctx: running.ctx,
      sessionId: "root-1",
      rootAgent: running.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );

  let releaseMaintenance!: () => void;
  const maintenanceGate = new Promise<void>((resolve) => {
    releaseMaintenance = resolve;
  });
  const inMaintenance = makeHarness();
  const maintenanceRoot = makeAgent("root-1", inMaintenance.ctx, {
    status: "idle",
    whenIdle: () => maintenanceGate,
  });
  inMaintenance.live.set("root-1", maintenanceRoot);
  assert.equal(
    await canStopSessionRuntime({
      ctx: inMaintenance.ctx,
      sessionId: "root-1",
      rootAgent: maintenanceRoot,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );
  releaseMaintenance();
  assert.equal(
    await canStopSessionRuntime({
      ctx: inMaintenance.ctx,
      sessionId: "root-1",
      rootAgent: maintenanceRoot,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    true,
  );

  const queued = makeHarness();
  const queuedRoot = makeAgent("root-1", queued.ctx, {
    nextStep: [{ id: "notice-1" }],
  });
  queued.live.set("root-1", queuedRoot);
  assert.equal(
    await canStopSessionRuntime({
      ctx: queued.ctx,
      sessionId: "root-1",
      rootAgent: queuedRoot,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );
});

test("canStopSessionRuntime checks process jobs including child and unowned jobs", async () => {
  const harness = makeHarness({
    jobs: {
      list: (caller?: string) =>
        caller === undefined
          ? [{ id: "bash-child", owner: "child-1", status: "running" }]
          : [],
    },
  });
  const child = makeAgent("child-1", harness.ctx, {
    parentSession: "root-1",
  });
  harness.live.set(child.id, child);
  assert.equal(
    await canStopSessionRuntime({
      ctx: harness.ctx,
      sessionId: "root-1",
      rootAgent: harness.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );

  const unownedJob = makeHarness({
    jobs: {
      list: () => [{ id: "bash-shared", status: "stopping" }],
    },
  });
  assert.equal(
    await canStopSessionRuntime({
      ctx: unownedJob.ctx,
      sessionId: "root-1",
      rootAgent: unownedJob.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );
});

test("canStopSessionRuntime vetoes armed active goals and active schedules, while allowing paused or absent ones", async () => {
  let goalState: { phase: string; activation: string } | undefined = {
    phase: "active",
    activation: "armed",
  };
  let schedules: unknown[] = [];
  const harness = makeHarness({
    goals: {
      get: () => goalState,
    },
    schedule: {
      list: async () => schedules,
    },
  });

  assert.equal(
    await canStopSessionRuntime({
      ctx: harness.ctx,
      sessionId: "root-1",
      rootAgent: harness.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );

  goalState = { phase: "active", activation: "disarmed" };
  assert.equal(
    await canStopSessionRuntime({
      ctx: harness.ctx,
      sessionId: "root-1",
      rootAgent: harness.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    true,
  );

  schedules = [{ id: "sched-1" }];
  assert.equal(
    await canStopSessionRuntime({
      ctx: harness.ctx,
      sessionId: "root-1",
      rootAgent: harness.root,
      hasBridgeActivity: () => false,
      hasActiveSubagentRuns: () => false,

    }),
    false,
  );
});

test("SubagentRunTracker tracks direct, external, and nested subagent runs through settlement", () => {
  const harness = makeHarness();
  const tracker = new SubagentRunTracker();
  const parentMap = new Map<string, string>([
    ["child-1", "root-1"],
    ["grandchild-1", "child-1"],
  ]);
  const disposers = tracker.observeHost(harness.ctx, (childId) => {
    let cur: string | undefined = childId;
    while (cur) {
      if (cur === "root-1") return cur;
      cur = parentMap.get(cur);
    }
    return undefined;
  });

  assert.equal(tracker.hasActiveRuns("root-1"), false);
  harness.emit("subagent/start", {
    runId: "run-nested",
    id: "grandchild-1",
    local: true,
  });
  assert.equal(tracker.hasActiveRuns("root-1"), true);
  harness.emit("subagent/end", {
    runId: "run-nested",
    id: "grandchild-1",
    local: true,
  });
  assert.equal(tracker.hasActiveRuns("root-1"), false);

  tracker.observeRootScope("root-1", harness.ctx);
  harness.emit("subagent/start", {
    runId: "run-external",
    id: "ext-1",
    local: false,
  });
  assert.equal(tracker.hasActiveRuns("root-1"), true);
  tracker.clearRoot("root-1");
  assert.equal(tracker.hasActiveRuns("root-1"), false);

  for (const dispose of disposers) dispose();
});

function safetyInput(harness: ReturnType<typeof makeHarness>) {
  return {
    ctx: harness.ctx,
    sessionId: harness.root.id,
    rootAgent: harness.root,
    hasBridgeActivity: () => false,
    hasActiveSubagentRuns: () => false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("whenIdle follows DSH activity changes and reuses a pending observation", async () => {
  const harness = makeHarness();
  let activityDone = Promise.resolve();
  let calls = 0;
  // Same do/await/identity loop as ReactLoopAgent.whenIdle in installed DSH.
  harness.root.whenIdle = async () => {
    calls++;
    let activity: Promise<void>;
    do { await (activity = activityDone); } while (activity !== activityDone);
  };
  const input = safetyInput(harness);
  assert.equal(await canStopSessionRuntime(input), true);

  const maintenance = deferred<void>();
  activityDone = maintenance.promise;
  const before = calls;
  for (let i = 0; i < 5; i++) {
    assert.equal(await canStopSessionRuntime(input), false);
  }
  assert.equal(calls, before + 1);
  maintenance.resolve();
  assert.equal(await canStopSessionRuntime(input), true);

  // Activity can change while the initial resolved activity is being awaited.
  const nextMaintenance = deferred<void>();
  activityDone = Promise.resolve();
  queueMicrotask(() => { activityDone = nextMaintenance.promise; });
  assert.equal(await canStopSessionRuntime(input), false);
  nextMaintenance.resolve();
  assert.equal(await canStopSessionRuntime(input), true);
});

test("runtime safety rechecks work admitted during schedule reads", async (t) => {
  for (const kind of ["job", "child", "replacement", "maintenance", "goal", "bridge", "subagent", "schedule"] as const) {
    await t.test(kind, async () => {
      const entered = deferred<void>();
      const listing = deferred<readonly unknown[]>();
      let jobRunning = false;
      let goalArmed = false;
      let bridgeActive = false;
      let subagentActive = false;
      const harness = makeHarness({
        jobs: { list: () => jobRunning ? [{ id: "late", status: "running" }] : [] },
        goals: { get: () => goalArmed ? { phase: "active", activation: "armed" } : undefined },
        schedule: { list: () => { entered.resolve(); return listing.promise; } },
      });
      const input = {
        ...safetyInput(harness),
        hasBridgeActivity: () => bridgeActive,
        hasActiveSubagentRuns: () => subagentActive,
      };
      const query = canStopSessionRuntime(input);
      await entered.promise;
      const maintenance = deferred<void>();
      switch (kind) {
        case "job": jobRunning = true; break;
        case "child": harness.live.set("new-child", makeAgent("new-child", harness.ctx)); break;
        case "replacement": harness.live.set(harness.root.id, makeAgent(harness.root.id, harness.ctx)); break;
        case "maintenance": harness.root.whenIdle = async () => { await maintenance.promise; }; break;
        case "goal": goalArmed = true; break;
        case "bridge": bridgeActive = true; break;
        case "subagent": subagentActive = true; break;
        case "schedule": harness.emit("schedule/changed"); break;
      }
      listing.resolve([]);
      assert.equal(await query, false);
      assert.equal(harness.listenerCount("schedule/changed"), 0);
      maintenance.resolve();
    });
  }
});

test("runtime safety fails closed when optional service lookup throws", async () => {
  const harness = makeHarness();
  const original = harness.ctx.get;
  harness.ctx.get = (name) => {
    if (name === "schedule") throw new Error("service lookup failed");
    return original(name);
  };
  assert.equal(await canStopSessionRuntime(safetyInput(harness)), false);
});

test("runtime inspection protects unrelated agents and permits idle peers", async (t) => {
  for (const kind of ["idle", "running", "maintenance", "goal", "schedule"] as const) {
    await t.test(kind, async () => {
      const maintenance = deferred<void>();
      const harness = makeHarness({
        goals: { get: (agent) => agent.id === "peer" && kind === "goal"
          ? { phase: "active", activation: "armed" } : undefined },
        schedule: { list: async ({ sessionId }) => sessionId === "peer" && kind === "schedule" ? [{ id: "peer-schedule" }] : [] },
      });
      harness.live.set("peer", makeAgent("peer", harness.ctx, {
        status: kind === "running" ? "running" : "idle",
        ...(kind === "maintenance" ? { whenIdle: async () => { await maintenance.promise; } } : {}),
      }));
      assert.equal(await canStopSessionRuntime(safetyInput(harness)), kind === "idle");
      maintenance.resolve();
    });
  }
});

test("global jobs protect other and already detached owners", async () => {
  for (const owner of ["peer", "detached", undefined]) {
    const harness = makeHarness({ jobs: { list: (caller) => {
      assert.equal(caller, undefined);
      return [{ id: "busy", owner, status: "running" }];
    } } });
    assert.equal(await canStopSessionRuntime(safetyInput(harness)), false);
  }
});

test("root-scoped external runs settle only their own root and ignore late ends", () => {
  const rootA = makeHarness();
  const rootB = makeHarness();
  const tracker = new SubagentRunTracker();
  tracker.observeRootScope("root-a", rootA.ctx);
  tracker.observeRootScope("root-b", rootB.ctx);
  const externalA = { runId: "external-a", id: "child-a", local: false };
  const externalB = { runId: "external-b", id: "child-b", local: false };
  rootA.emit("subagent/start", externalA);
  assert.equal(tracker.hasActiveRuns("root-a"), true);
  assert.equal(tracker.hasActiveRuns("root-b"), false);
  rootB.emit("subagent/start", externalB);
  rootA.emit("subagent/end", externalA);
  assert.equal(tracker.hasActiveRuns("root-a"), false);
  assert.equal(tracker.hasActiveRuns("root-b"), true);
  tracker.clearRoot("root-b");
  rootB.emit("subagent/end", externalB);
  assert.equal(tracker.hasActiveRuns("root-b"), false);
  tracker.clearAll();
});

test("host-scoped external runs without a tracked root protect the whole process", () => {
  const harness = makeHarness();
  const tracker = new SubagentRunTracker();
  const disposers = tracker.observeHost(harness.ctx, () => undefined);
  const run = { runId: "unrelated-external", id: "external", local: false };
  harness.emit("subagent/start", run);
  assert.equal(tracker.hasActiveRuns(), true);
  harness.emit("subagent/end", run);
  assert.equal(tracker.hasActiveRuns(), false);
  for (const dispose of disposers) dispose();
});

test("unrelated agent work admitted during schedule reads vetoes process stop", async (t) => {
  for (const kind of ["running", "maintenance", "goal", "schedule"] as const) {
    await t.test(kind, async () => {
      const entered = deferred<void>();
      const listing = deferred<readonly unknown[]>();
      const maintenance = deferred<void>();
      let armed = false;
      const harness = makeHarness({
        goals: { get: (agent) => agent.id === "peer" && armed
          ? { phase: "active", activation: "armed" } : undefined },
        schedule: { list: async ({ sessionId }) => {
          if (sessionId === "root-1") { entered.resolve(); return listing.promise; }
          return kind === "schedule" && armed ? [{ id: "late-peer-schedule" }] : [];
        } },
      });
      const peer = makeAgent("peer", harness.ctx);
      harness.live.set(peer.id, peer);
      const query = canStopSessionRuntime(safetyInput(harness));
      await entered.promise;
      if (kind === "running") peer.status = "running";
      if (kind === "maintenance") peer.whenIdle = async () => { await maintenance.promise; };
      armed = true;
      listing.resolve([]);
      assert.equal(await query, false);
      maintenance.resolve();
    });
  }
});
