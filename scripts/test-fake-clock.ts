import type { StreamCoalescerTimers } from "../server/stream-coalescer.js";

/** Deterministic virtual clock and timer pair for stream-coalescing tests. */
export function createFakeClock(initialMs = 1_000) {
  let nowMs = initialMs;
  let nextId = 1;
  const scheduled = new Map<number, { runAt: number; callback: () => void }>();

  const timers: StreamCoalescerTimers = {
    setTimeout(callback, ms) {
      const id = nextId++;
      scheduled.set(id, { runAt: nowMs + ms, callback });
      return id;
    },
    clearTimeout(timer) {
      scheduled.delete(timer as number);
    },
  };

  function advanceBy(ms: number): void {
    const target = nowMs + ms;
    while (true) {
      let earliestId: number | undefined;
      let earliestAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of scheduled) {
        if (entry.runAt <= target && entry.runAt < earliestAt) {
          earliestAt = entry.runAt;
          earliestId = id;
        }
      }
      if (earliestId === undefined) break;
      const entry = scheduled.get(earliestId)!;
      scheduled.delete(earliestId);
      nowMs = entry.runAt;
      entry.callback();
    }
    nowMs = target;
  }

  return { now: () => nowMs, timers, advanceBy, pendingCount: () => scheduled.size };
}
