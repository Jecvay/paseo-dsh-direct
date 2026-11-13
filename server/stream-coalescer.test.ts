import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createFakeClock } from "../scripts/test-fake-clock.js";
import { StreamCoalescer } from "./stream-coalescer.js";

function textEvent(sessionId: string, id: string, messageId: string, text: string, timestamp?: string): ProviderEvent {
  return {
    type: "timeline.item",
    sessionId,
    ...(timestamp ? { timestamp } : {}),
    item: { type: "assistant_message", id, messageId, text },
  };
}

function reasoningEvent(sessionId: string, id: string, text: string, timestamp?: string): ProviderEvent {
  return {
    type: "timeline.item",
    sessionId,
    ...(timestamp ? { timestamp } : {}),
    item: { type: "reasoning", id, text },
  };
}

function toolEvent(
  sessionId: string,
  callId: string,
  rawArgs: string,
  status: "running" | "completed" | "failed" = "running",
  timestamp?: string,
): ProviderEvent {
  const base = {
    type: "tool_call" as const,
    id: `tool:${callId}`,
    callId,
    name: "write",
    detail: { type: "unknown" as const, input: {}, output: {} },
    metadata: { argumentsText: rawArgs },
  };
  return {
    type: "timeline.item",
    sessionId,
    ...(timestamp ? { timestamp } : {}),
    item: status === "failed"
      ? { ...base, status: "failed", error: "failed" }
      : { ...base, status, error: null },
  };
}

describe("StreamCoalescer", () => {
  it("flushes leading edge immediately, merges burst deltas, and preserves cooldown across flushes", () => {
    const clock = createFakeClock();
    const emitted: ProviderEvent[] = [];
    const coalescer = new StreamCoalescer({
      windowMs: 120,
      timers: clock.timers,
      now: clock.now,
      onFlush: (_key, event) => emitted.push(event),
    });

    coalescer.enqueue("s1", textEvent("s1", "b1#0:0", "b1", "A", "2026-11-14T00:00:00.000Z"));
    assert.equal(emitted.length, 1);

    // Subsequent chunks within 120ms stay buffered and merge into one delta with first batch id & latest timestamp.
    clock.advanceBy(10);
    coalescer.enqueue("s1", textEvent("s1", "b1#0:1", "b1", "B", "2026-11-14T00:00:00.010Z"));
    clock.advanceBy(10);
    coalescer.enqueue("s1", textEvent("s1", "b1#0:2", "b1", "C", "2026-11-14T00:00:00.020Z"));
    assert.equal(emitted.length, 1);
    assert.equal(clock.pendingCount(), 1);

    clock.advanceBy(100);
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[1], textEvent("s1", "b1#0:1", "b1", "BC", "2026-11-14T00:00:00.020Z"));

    // Cooldown stays active right after a timer flush (Dora-SSR regression guard).
    clock.advanceBy(10);
    coalescer.enqueue("s1", textEvent("s1", "b1#0:3", "b1", "D"));
    assert.equal(emitted.length, 2);
    clock.advanceBy(110);
    assert.equal(emitted.length, 3);
    assert.deepEqual(emitted[2], textEvent("s1", "b1#0:3", "b1", "D"));

    coalescer.dispose();
  });

  it("merges reasoning deltas only when sharing the # block prefix and never across types", () => {
    const clock = createFakeClock();
    const emitted: ProviderEvent[] = [];
    const coalescer = new StreamCoalescer({
      windowMs: 100,
      timers: clock.timers,
      now: clock.now,
      onFlush: (_key, event) => emitted.push(event),
    });

    coalescer.enqueue("s1", reasoningEvent("s1", "r1#0:0", "lead"));
    assert.equal(emitted.length, 1);

    coalescer.enqueue("s1", reasoningEvent("s1", "r1#0:1", "  step1"));
    coalescer.enqueue("s1", reasoningEvent("s1", "r1#0:2", "  step2"));
    // Un-hashed ids never merge across distinct ids.
    coalescer.enqueue("s1", reasoningEvent("s1", "plain-a", "X"));
    coalescer.enqueue("s1", reasoningEvent("s1", "plain-b", "Y"));
    // Different type breaks adjacency.
    coalescer.enqueue("s1", textEvent("s1", "t1#0:0", "t1", "answer"));
    coalescer.enqueue("s1", reasoningEvent("s1", "r1#0:3", "tail"));

    clock.advanceBy(100);
    assert.equal(emitted.length, 6);
    assert.deepEqual(
      emitted.slice(1).map((event) =>
        event.type === "timeline.item" && (event.item.type === "reasoning" || event.item.type === "assistant_message")
          ? [event.item.type, event.item.id, event.item.text]
          : null,
      ),
      [
        ["reasoning", "r1#0:1", "  step1  step2"],
        ["reasoning", "plain-a", "X"],
        ["reasoning", "plain-b", "Y"],
        ["assistant_message", "t1#0:0", "answer"],
        ["reasoning", "r1#0:3", "tail"],
      ],
    );

    coalescer.dispose();
  });

  it("coalesces repeated tool_call updates in place and flushes immediately on terminal status", () => {
    const clock = createFakeClock();
    const emitted: ProviderEvent[] = [];
    const coalescer = new StreamCoalescer({
      windowMs: 120,
      timers: clock.timers,
      now: clock.now,
      onFlush: (_key, event) => emitted.push(event),
    });

    coalescer.enqueue("s1", textEvent("s1", "t1#0:0", "t1", "start"));
    assert.equal(emitted.length, 1);

    coalescer.enqueue("s1", toolEvent("s1", "c1", '{"path":"a"'));
    coalescer.enqueue("s1", textEvent("s1", "t1#0:1", "t1", "mid"));
    coalescer.enqueue("s1", toolEvent("s1", "c1", '{"path":"a","n":1}'));
    assert.equal(emitted.length, 1);

    clock.advanceBy(120);
    assert.equal(emitted.length, 3);
    assert.equal(emitted[1]?.type === "timeline.item" && emitted[1].item.type === "tool_call" ? emitted[1].item.metadata?.argumentsText : "", '{"path":"a","n":1}');
    assert.equal(emitted[2]?.type === "timeline.item" && emitted[2].item.type === "assistant_message" ? emitted[2].item.text : "", "mid");

    // Terminal tool_call triggers immediate flush.
    coalescer.enqueue("s1", toolEvent("s1", "c2", '{"x":1}', "completed"));
    assert.equal(emitted.length, 4);

    coalescer.dispose();
  });

  it("enforces maxBufferChars on incremental text only, ignoring cumulative tool_call arguments", () => {
    const clock = createFakeClock();
    const emitted: ProviderEvent[] = [];
    const coalescer = new StreamCoalescer({
      windowMs: 120,
      maxBufferChars: 10,
      timers: clock.timers,
      now: clock.now,
      onFlush: (_key, event) => emitted.push(event),
    });

    coalescer.enqueue("s1", textEvent("s1", "b1#0:0", "b1", "lead"));
    assert.equal(emitted.length, 1);

    // Large cumulative tool_call arguments do not trigger maxBufferChars early flush.
    coalescer.enqueue("s1", toolEvent("s1", "c1", "x".repeat(500)));
    assert.equal(emitted.length, 1);

    // Incremental text reaching maxBufferChars flushes immediately along with prior tool_call.
    coalescer.enqueue("s1", textEvent("s1", "b1#0:1", "b1", "1234567890"));
    assert.equal(emitted.length, 3);

    coalescer.dispose();
  });

  it("is reentrancy-safe on flush and clears timers on discard and dispose", () => {
    const clock = createFakeClock();
    const emitted: string[] = [];
    const coalescer = new StreamCoalescer({
      windowMs: 120,
      timers: clock.timers,
      now: clock.now,
      onFlush: (key, event) => {
        if (event.type === "timeline.item" && event.item.type === "assistant_message") {
          emitted.push(`${key}:${event.item.text}`);
        }
        // Reentrant flush of the same key must not duplicate or recurse infinitely.
        coalescer.flush(key);
      },
    });

    coalescer.enqueue("s1", textEvent("s1", "b1#0:0", "b1", "first"));
    coalescer.enqueue("s1", textEvent("s1", "b1#0:1", "b1", "second"));
    coalescer.enqueue("s2", textEvent("s2", "b2#0:0", "b2", "other"));
    coalescer.enqueue("s2", textEvent("s2", "b2#0:1", "b2", "discarded"));
    assert.deepEqual(emitted, ["s1:first", "s2:other"]);
    assert.equal(clock.pendingCount(), 2);

    coalescer.discard("s2");
    assert.equal(clock.pendingCount(), 1);
    clock.advanceBy(120);
    assert.deepEqual(emitted, ["s1:first", "s2:other", "s1:second"]);

    coalescer.enqueue("s1", textEvent("s1", "b1#0:2", "b1", "pending"));
    assert.equal(clock.pendingCount(), 1);
    coalescer.dispose();
    assert.equal(clock.pendingCount(), 0);
    clock.advanceBy(500);
    coalescer.enqueue("s1", textEvent("s1", "b1#0:3", "b1", "after-dispose"));
    assert.deepEqual(emitted, ["s1:first", "s2:other", "s1:second"]);
  });
});
