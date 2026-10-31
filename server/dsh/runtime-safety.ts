import type { HostAgent, HostContext } from "./host.js";

/**
 * Tracks published subagent runs between `subagent/start` and `subagent/end`.
 *
 * The subagent manager emits `subagent/end` only after an activation's
 * teardown finishes, its completion notice is delivered to the parent inbox,
 * and parent ownership is released. While a run is in this table, stopping the
 * bridge would lose an external child or a local child's settlement notice.
 */
export class SubagentRunTracker {
  private readonly activeByRoot = new Map<string, Set<string>>();
  private readonly rootByRun = new Map<string, string | undefined>();

  /**
   * Subscribe inside a root session's `setup(agentCtx)` so direct delegations
   * of that root always resolve to `rootId`, even for external backends whose
   * child id is not in `ctx.agents` or `session/created`.
   */
  observeRootScope(rootId: string, agentCtx: HostContext): void {
    agentCtx.on("subagent/start", (info) => {
      if (typeof info?.runId === "string" && info.runId) {
        this.startRun(rootId, info.runId);
      }
    });
    agentCtx.on("subagent/end", (info) => {
      if (typeof info?.runId === "string" && info.runId) {
        this.endRun(info.runId);
      }
    });
  }

  /**
   * Observe every process-level run, including external children whose parent
   * is outside the bridge-owned session tree.
   */
  observeHost(
    ctx: HostContext,
    resolveRoot: (childId: string) => string | undefined,
  ): Array<() => void> {
    return [
      ctx.on("subagent/start", (info) => {
        if (typeof info?.runId !== "string" || !info.runId) return;
        if (this.rootByRun.has(info.runId)) return;
        const rootId =
          typeof info.id === "string" ? resolveRoot(info.id) : undefined;
        this.startRun(rootId, info.runId);
      }),
      ctx.on("subagent/end", (info) => {
        if (typeof info?.runId === "string" && info.runId) {
          this.endRun(info.runId);
        }
      }),
    ];
  }

  hasActiveRuns(rootId?: string): boolean {
    return rootId === undefined
      ? this.rootByRun.size > 0
      : (this.activeByRoot.get(rootId)?.size ?? 0) > 0;
  }

  clearRoot(rootId: string): void {
    const runs = this.activeByRoot.get(rootId);
    if (runs) {
      for (const runId of runs) this.rootByRun.delete(runId);
      this.activeByRoot.delete(rootId);
    }
  }

  clearAll(): void {
    this.activeByRoot.clear();
    this.rootByRun.clear();
  }

  private startRun(rootId: string | undefined, runId: string): void {
    const existing = this.rootByRun.get(runId);
    if (existing && existing !== rootId) {
      this.activeByRoot.get(existing)?.delete(runId);
    }
    this.rootByRun.set(runId, rootId);
    if (rootId === undefined) return;
    let set = this.activeByRoot.get(rootId);
    if (!set) {
      set = new Set();
      this.activeByRoot.set(rootId, set);
    }
    set.add(runId);
  }

  private endRun(runId: string): void {
    const rootId = this.rootByRun.get(runId);
    this.rootByRun.delete(runId);
    if (!rootId) return;
    const set = this.activeByRoot.get(rootId);
    if (!set) return;
    set.delete(runId);
    if (set.size === 0) this.activeByRoot.delete(rootId);
  }
}

export interface RuntimeSafetyInput {
  ctx: HostContext;
  sessionId: string;
  rootAgent: HostAgent | undefined;
  hasBridgeActivity: () => boolean;
  hasActiveSubagentRuns: () => boolean;
}

/**
 * Decide whether releasing this DSH session runtime loses in-flight work.
 *
 * This query is strictly read-only: it never cancels, disposes, mutates, or
 * leaves behind uncancelled listeners. Any missing required inspection surface
 * or thrown error fails closed (`false`).
 */
export async function canStopSessionRuntime(
  input: RuntimeSafetyInput,
): Promise<boolean> {
  let disposeScheduleObserver: (() => void) | undefined;
  try {
    if (input.hasBridgeActivity() || input.hasActiveSubagentRuns()) return false;
    const root = input.rootAgent;
    if (!root || String(root.id) !== input.sessionId) return false;
    const agents = input.ctx.get("agents");
    const jobs = input.ctx.get("jobs");
    const goals = input.ctx.get("goals");
    const schedule = input.ctx.get("schedule");
    if (
      !agents ||
      typeof agents.get !== "function" ||
      typeof agents.list !== "function" ||
      !jobs ||
      typeof jobs.list !== "function" ||
      (goals && typeof goals.get !== "function") ||
      (schedule && typeof schedule.list !== "function")
    ) {
      return false;
    }

    let scheduleChanged = false;
    if (schedule) {
      disposeScheduleObserver = input.ctx.on("schedule/changed", () => {
        scheduleChanged = true;
      });
    }
    // Stopping the bridge exits the entire DSH process, including agents
    // started by the profile or schedule runtime outside this session's tree.
    const readAgents = (): HostAgent[] => {
      if (agents.get(input.sessionId) !== root) return [];
      const live = agents.list!();
      return Array.isArray(live) && live.includes(root) ? live : [];
    };
    const liveAgents = readAgents();
    if (liveAgents.length === 0 || !(await areAgentsQuiescent(liveAgents))) return false;
    if (schedule) {
      for (const agent of liveAgents) {
        const active = await schedule.list({ sessionId: String(agent.id) });
        if (!Array.isArray(active) || active.length > 0) return false;
      }
    }

    // Schedule reads yield to arbitrary runtime work. Probe maintenance again,
    // then re-read every synchronous veto before returning the decision.
    if (!(await areAgentsQuiescent(liveAgents))) return false;
    const currentAgents = readAgents();
    if (
      scheduleChanged ||
      input.hasBridgeActivity() ||
      input.hasActiveSubagentRuns() ||
      currentAgents.length !== liveAgents.length ||
      currentAgents.some((agent) => !liveAgents.includes(agent))
    ) {
      return false;
    }
    for (const agent of liveAgents) {
      if (!isAgentSynchronouslyIdle(agent)) return false;
      const goal = goals?.get(agent);
      if (goal?.phase === "active" && goal.activation === "armed") return false;
    }
    // No caller filter: jobs can outlive their owner agent's registry entry.
    const views = jobs.list();
    if (
      !Array.isArray(views) || views.some(
        (job) => job?.status === "running" || job?.status === "stopping",
      )
    ) return false;
    return true;
  } catch {
    return false;
  } finally {
    try {
      disposeScheduleObserver?.();
    } catch {
      return false;
    }
  }
}

function isAgentSynchronouslyIdle(agent: HostAgent): boolean {
  if (agent.status !== "idle") return false;
  const inbox = agent.inbox;
  if (
    !inbox ||
    !Array.isArray(inbox.nextTurn) ||
    !Array.isArray(inbox.nextStep)
  ) {
    return false;
  }
  return inbox.nextTurn.length === 0 && inbox.nextStep.length === 0;
}

// Repeated safety queries during a long maintenance job must not attach another
// whenIdle continuation to the same unfinished activity on every request.
const idleObservations = new WeakMap<
  HostAgent,
  { state: "pending" | "idle" | "failed" }
>();

async function areAgentsQuiescent(agents: readonly HostAgent[]): Promise<boolean> {
  const observations = [];
  for (const agent of agents) {
    if (!isAgentSynchronouslyIdle(agent) || typeof agent.whenIdle !== "function") {
      return false;
    }
    let observation = idleObservations.get(agent);
    if (!observation || observation.state !== "pending") {
      observation = { state: "pending" };
      idleObservations.set(agent, observation);
      const current = observation;
      void Promise.resolve(agent.whenIdle()).then(
        () => { current.state = "idle"; },
        () => { current.state = "failed"; },
      );
    }
    observations.push(observation);
  }
  // DSH's async whenIdle awaits activityDone and checks that its identity has
  // not changed. Allow that resolved-promise path to finish without waiting for
  // pending maintenance, timers, or attaching listeners to a long-lived race.
  await Promise.resolve().then(() => undefined).then(() => undefined);
  return observations.every((observation) => observation.state === "idle") &&
    agents.every(isAgentSynchronouslyIdle);
}
