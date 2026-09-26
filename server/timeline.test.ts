import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { TimelineProjector } from "./timeline.js";

function timelineItem(event: ProviderEvent) {
  assert.equal(event.type, "timeline.item");
  return event.item;
}

describe("TimelineProjector", () => {
  it("projects compaction cards and abnormal turn ends", () => {
    const projector = new TimelineProjector("paseo-session");
    const items = [
      { type: "compaction/start", seq: 1, time: 1, data: { compactionId: "c1", sourceCommandId: "cmd-1", turn: null } },
      { type: "compaction/summary", seq: 2, time: 2, data: { compactionId: "c1", shadowedTokenCount: 4200 } },
      { type: "compaction/end", seq: 3, time: 3, data: { compactionId: "c1", turn: null } },
      { type: "compaction/start", seq: 4, time: 4, data: { compactionId: "c2", turn: 3 } },
      { type: "compaction/end", seq: 5, time: 5, data: { compactionId: "c2", turn: 3, error: "boom" } },
      { type: "turn/end", seq: 6, time: 6, data: { turn: 3, reason: { kind: "max-tokens" } } },
    ].flatMap((event) => projector.projectEvent(event).map(timelineItem));
    assert.deepEqual(items, [
      { type: "compaction", id: "compaction:c1", status: "loading", trigger: "manual" },
      { type: "compaction", id: "compaction:c1", status: "completed", trigger: "manual", preTokens: 4200 },
      { type: "compaction", id: "compaction:c2", status: "loading", trigger: "auto" },
      { type: "compaction", id: "compaction:c2", status: "completed", trigger: "auto" },
      { type: "notification", id: "compaction:c2:error", level: "error", message: "Compaction failed: boom" },
      {
        type: "notification",
        id: "turn-end:6",
        level: "warning",
        message: "The model reached its output token limit in this turn; the reply may be incomplete.",
      },
    ]);
  });

  it("replays turn failures and marks attachments in user messages", () => {
    const projector = new TimelineProjector("paseo-session");
    const [user] = projector.projectEvent({
      type: "user/message",
      seq: 1,
      time: 1,
      data: {
        id: "u1",
        source: { kind: "user" },
        content: [
          { type: "text", text: "see" },
          { type: "image", attachment: { attachmentId: "a" } },
          { type: "file", attachment: { attachmentId: "b", name: "notes.txt" } },
        ],
      },
    });
    assert.equal(user && timelineItem(user).type === "user_message" && (timelineItem(user) as { text: string }).text, "see\n[image]\n[file: notes.txt]");
    const [error] = projector.projectEvent({
      type: "turn/end",
      seq: 2,
      time: 2,
      data: { turn: 1, reason: { kind: "error", error: { message: "no adapter", code: "NO_ADAPTER" } } },
    });
    assert.deepEqual(error && timelineItem(error), { type: "error", id: "turn-error:2", message: "[NO_ADAPTER] no adapter" });
    assert.deepEqual(
      projector.projectEvent({ type: "turn/end", seq: 3, time: 3, data: { turn: 2, reason: { kind: "completed" } } }),
      [],
    );
  });

  it("uses one cumulative item id from transient chunks through the durable message", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "attempt-1", revision: 0, turn: 2, step: 3 });
    const first = projector.projectStream({
      type: "chunk",
      attemptId: "attempt-1",
      revision: 0,
      index: 10,
      time: 1_000,
      chunk: { type: "text-delta", index: 0, text: "Hel" },
    });
    const second = projector.projectStream({
      type: "chunk",
      attemptId: "attempt-1",
      revision: 0,
      index: 11,
      time: 1_001,
      chunk: { type: "text-delta", index: 0, text: "lo" },
    });
    const durable = projector.projectEvent({
      type: "assistant/message",
      seq: 8,
      time: 1_002,
      data: {
        turn: 2,
        step: 3,
        message: { id: "message-1", content: [{ type: "text", text: "Hello" }] },
      },
    });

    assert.deepEqual(
      [first[0], second[0], durable[0]].map((event) => timelineItem(event!).id),
      [
        "assistant_message:turn:2:step:3:attempt:0:0",
        "assistant_message:turn:2:step:3:attempt:0:0",
        "assistant_message:turn:2:step:3:attempt:0:0",
      ],
    );
    assert.deepEqual(
      [first[0], second[0], durable[0]].map((event) => {
        const item = timelineItem(event!);
        return item.type === "assistant_message" ? item.text : "";
      }),
      ["Hel", "Hello", "Hello"],
    );
  });

  it("keeps retries at the same turn and step in separate timeline items", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "attempt-1", revision: 1, turn: 2, step: 3 });
    const failed = projector.projectStream({
      type: "chunk",
      attemptId: "attempt-1",
      revision: 2,
      index: 0,
      time: 1_000,
      chunk: { type: "text-delta", index: 0, text: "Partial" },
    });
    projector.projectEvent({
      type: "assistant/attempt",
      seq: 8,
      time: 1_001,
      data: { turn: 2, step: 3, stream: [] },
    });
    projector.projectStream({
      type: "end",
      attemptId: "attempt-1",
      revision: 3,
      index: 1,
      outcome: { kind: "committed", eventType: "assistant/attempt", seq: 8 },
    });

    projector.projectStream({ type: "start", attemptId: "attempt-2", revision: 4, turn: 2, step: 3 });
    const retried = projector.projectStream({
      type: "chunk",
      attemptId: "attempt-2",
      revision: 5,
      index: 0,
      time: 1_002,
      chunk: { type: "text-delta", index: 0, text: "Complete" },
    });
    const durable = projector.projectEvent({
      type: "assistant/message",
      seq: 9,
      time: 1_003,
      data: {
        turn: 2,
        step: 3,
        message: { id: "message-2", content: [{ type: "text", text: "Complete" }] },
      },
    });

    assert.equal(timelineItem(failed[0]!).id, "assistant_message:turn:2:step:3:attempt:0:0");
    assert.equal(timelineItem(retried[0]!).id, "assistant_message:turn:2:step:3:attempt:1:0");
    assert.equal(timelineItem(durable[0]!).id, "assistant_message:turn:2:step:3:attempt:1:0");
    const retriedItem = timelineItem(retried[0]!);
    assert.equal(retriedItem.type, "assistant_message");
    assert.equal(retriedItem.text, "Complete");
  });

  it("reconstructs the same retry item id when replaying durable history", () => {
    const failedAttempt = {
      type: "assistant/attempt",
      seq: 7,
      time: 999,
      data: { turn: 2, step: 3, stream: [] },
    } as const;
    const finalMessage = {
      type: "assistant/message",
      seq: 8,
      time: 1_000,
      data: {
        turn: 2,
        step: 3,
        message: { id: "message-1", content: [{ type: "text", text: "Hello" }] },
      },
    } as const;

    const live = new TimelineProjector("paseo-session");
    live.projectStream({ type: "start", attemptId: "attempt-1", revision: 1, turn: 2, step: 3 });
    live.projectEvent(failedAttempt);
    live.projectStream({ type: "start", attemptId: "attempt-2", revision: 4, turn: 2, step: 3 });
    const streamed = live.projectStream({
      type: "chunk",
      attemptId: "attempt-2",
      revision: 5,
      index: 0,
      time: 1_000,
      chunk: { type: "text-delta", index: 0, text: "Hello" },
    });
    const durable = live.projectEvent(finalMessage);

    const replay = new TimelineProjector("paseo-session");
    replay.projectEvent(failedAttempt);
    const replayed = replay.projectEvent(finalMessage);

    assert.deepEqual(
      [streamed[0], durable[0], replayed[0]].map((event) => timelineItem(event!).id),
      [
        "assistant_message:turn:2:step:3:attempt:1:0",
        "assistant_message:turn:2:step:3:attempt:1:0",
        "assistant_message:turn:2:step:3:attempt:1:0",
      ],
    );
  });

  it("settles a running tool card from a tool result", () => {
    const projector = new TimelineProjector("paseo-session");
    const running = projector.projectEvent({
      type: "tool/call",
      seq: 3,
      time: 1_000,
      data: { callId: "call-1", name: "shell", arguments: '{"command":"pwd"}' },
    });
    // DSH 0.1.7 records the call id on the tool message with plain text blocks.
    const completed = projector.projectEvent({
      type: "tool/result",
      seq: 4,
      time: 1_001,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          source: { kind: "tool", callId: "call-1" },
          toolCallId: "call-1",
          content: [{ type: "text", text: "/repo" }],
          isError: false,
        },
      },
    });

    assert.equal(timelineItem(running[0]!).type, "tool_call");
    const result = timelineItem(completed[0]!);
    assert.equal(result.type, "tool_call");
    assert.equal(result.status, "completed");
    assert.equal(result.detail.type, "shell");
    if (result.detail.type === "shell") assert.equal(result.detail.output, "/repo");
  });

  it("settles a tool result that only carries source.callId and marks errors", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectEvent({
      type: "tool/call",
      seq: 3,
      time: 1_000,
      data: { callId: "call-9", name: "bash", arguments: '{"command":"ls"}' },
    });
    // No `toolCallId` field: the fallback reads `source.callId`.
    const errored = projector.projectEvent({
      type: "tool/result",
      seq: 4,
      time: 1_001,
      data: {
        message: {
          role: "tool",
          source: { kind: "tool", callId: "call-9" },
          content: [{ type: "text", text: "boom" }],
          isError: true,
        },
      },
    });

    const item = timelineItem(errored[0]!);
    assert.equal(item.type, "tool_call");
    assert.equal(item.status, "failed");
    if (item.type === "tool_call") assert.equal(item.error, "boom");
  });

  it("still settles the legacy tool-result content block layout", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectEvent({
      type: "tool/call",
      seq: 3,
      time: 1_000,
      data: { callId: "call-legacy", name: "bash", arguments: "{}" },
    });
    const legacy = projector.projectEvent({
      type: "tool/result",
      seq: 4,
      time: 1_001,
      data: {
        message: {
          content: [
            { type: "tool-result", toolCallId: "call-legacy", content: [{ type: "text", text: "ok" }] },
          ],
        },
      },
    });

    const item = timelineItem(legacy[0]!);
    assert.equal(item.type, "tool_call");
    assert.equal(item.status, "completed");
  });

  it("settles still-running tool cards when a turn ends", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectEvent({
      type: "tool/call",
      seq: 3,
      time: 1_000,
      data: { callId: "call-stuck", name: "bash", arguments: '{"command":"sleep 60"}' },
    });
    const settled = projector.projectEvent({
      type: "turn/end",
      seq: 4,
      time: 1_050,
      data: { turn: 1, reason: { kind: "cancelled" } },
    });

    const card = settled.map(timelineItem).find((item) => item.type === "tool_call");
    assert.ok(card, "turn end settles the interrupted tool card");
    assert.equal(card!.type === "tool_call" ? card!.status : "", "failed");
  });

  it("does not expose plugin-injected user messages as chat bubbles", () => {
    const projector = new TimelineProjector("paseo-session");
    const injected = projector.projectEvent({
      type: "user/message",
      seq: 1,
      time: 1_000,
      data: {
        id: "plugin-context",
        role: "user",
        source: { kind: "plugin", plugin: "compact" },
        content: [{ type: "text", text: "Internal plugin context" }],
      },
    });
    const actualUser = projector.projectEvent({
      type: "user/message",
      seq: 2,
      time: 1_001,
      data: {
        id: "user-1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Hello" }],
      },
    });

    assert.deepEqual(injected, []);
    assert.equal(timelineItem(actualUser[0]!).type, "user_message");
  });
});
