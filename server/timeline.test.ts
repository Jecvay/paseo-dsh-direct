import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import {
  CARD_KINDS,
  CARD_VERSION,
  PLUGIN_ID,
  goalCardSchema,
  permissionPresetCardSchema,
  planModeCardSchema,
} from "../shared/timeline-cards.js";
import type { DshSessionEvent } from "../shared/bridge-protocol.js";
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

    // Each delta has its own id; Paseo joins them by adjacency, not by id.
    assert.deepEqual(
      [first[0], second[0]].map((event) => timelineItem(event!).id),
      [
        "assistant_message:turn:2:step:3:attempt:0:0#0:10",
        "assistant_message:turn:2:step:3:attempt:0:0#0:11",
      ],
    );
    assert.deepEqual(
      [first[0], second[0]].map((event) => {
        const item = timelineItem(event!);
        return item.type === "assistant_message" ? item.text : "";
      }),
      ["Hel", "lo"],
    );
    // The settled message repeats what the stream already delivered, so it adds nothing.
    assert.deepEqual(durable, []);
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

    assert.equal(timelineItem(failed[0]!).id, "assistant_message:turn:2:step:3:attempt:0:0#2:0");
    assert.equal(timelineItem(retried[0]!).id, "assistant_message:turn:2:step:3:attempt:1:0#5:0");
    const retriedItem = timelineItem(retried[0]!);
    assert.equal(retriedItem.type, "assistant_message");
    assert.equal(retriedItem.text, "Complete");
    // The retry streamed the whole message, so the settled copy is redundant.
    assert.deepEqual(durable, []);
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

    // The live projector streamed the text, so its settled copy adds nothing.
    assert.deepEqual(durable, []);
    // A fresh projector has no stream state, so replaying history yields the full text
    // under the same item id.
    // The streamed delta has its own id; the replayed durable item keeps the
    // block id because it is a complete message.
    assert.deepEqual(
      [streamed[0], replayed[0]].map((event) => timelineItem(event!).id),
      [
        "assistant_message:turn:2:step:3:attempt:1:0#5:0",
        "assistant_message:turn:2:step:3:attempt:1:0",
      ],
    );
    assert.equal(
      timelineItem(replayed[0]!).type === "assistant_message"
        ? (timelineItem(replayed[0]!) as { text: string }).text
        : "",
      "Hello",
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

const schemas = {
  [CARD_KINDS.planMode]: planModeCardSchema,
  [CARD_KINDS.permissionPreset]: permissionPresetCardSchema,
  [CARD_KINDS.goal]: goalCardSchema,
} as const;

function ev(seq: number, type: string, data: Record<string, unknown>): DshSessionEvent {
  return { type, seq, time: seq, data: data as DshSessionEvent["data"] };
}

function goalEvent(seq: number, operation: string, extra: Record<string, unknown> = {}): DshSessionEvent {
  const goal = { id: "g1", revision: 1, objective: "ship it", phase: "active", maxGoalRounds: 10 };
  return ev(seq, "goal/change", { kind: "goal/change", version: 1, operation, goal, ...extra });
}

function goalUser(seq: number, round: number): DshSessionEvent {
  return ev(seq, "user/message", {
    id: `m${seq}`,
    content: [{ type: "text", text: "continue" }],
    source: { kind: "goal", goalId: "g1", revision: 1, round },
  });
}

/** Projects events and returns plugin cards, validating each against its schema. */
function cards(projector: TimelineProjector, events: DshSessionEvent[]) {
  return events.flatMap((event) =>
    projector.projectEvent(event).flatMap((projected) => {
      const item = timelineItem(projected);
      if (item.type !== "plugin") return [];
      assert.equal(item.pluginId, PLUGIN_ID);
      assert.equal(item.version, CARD_VERSION);
      schemas[item.kind as keyof typeof schemas].parse(item.data);
      return [item];
    }),
  );
}

describe("TimelineProjector plugin cards", () => {
  it("emits plan-mode cards only when the value changes", () => {
    const projector = new TimelineProjector("s", true);
    const items = cards(projector, [
      ev(1, "plan/mode", { active: false }),
      ev(2, "plan/mode", { active: true }),
      ev(3, "plan/mode", { active: true }),
      ev(4, "plan/mode", { active: false }),
    ]);
    assert.deepEqual(items.map((item) => [item.id, item.kind, item.data]), [
      ["plan-mode:2", "plan-mode", { active: true }],
      ["plan-mode:4", "plan-mode", { active: false }],
    ]);
  });

  it("uses the first permission preset only as the baseline", () => {
    const projector = new TimelineProjector("s", true);
    const items = cards(projector, [
      ev(1, "permission/preset", { preset: "read-only" }),
      ev(2, "permission/preset", { preset: "read-only" }),
      ev(3, "permission/preset", { preset: "workspace-write" }),
    ]);
    assert.deepEqual(items.map((item) => [item.id, item.data]), [
      ["permission-preset:3", { preset: "workspace-write" }],
    ]);
  });

  it("emits a goal card per operation, with block reason and remembered objective on clear", () => {
    const projector = new TimelineProjector("s", true);
    const items = cards(projector, [
      goalEvent(1, "create"),
      goalEvent(2, "pause"),
      goalEvent(3, "block", {
        goal: { id: "g1", revision: 2, objective: "ship it", phase: "blocked", maxGoalRounds: 10, blockedReason: { code: "x", message: "needs input" } },
      }),
      goalEvent(4, "complete"),
      ev(5, "goal/change", { operation: "clear", cleared: { id: "g1", revision: 2 }, clearedAt: 5 }),
      ev(6, "goal/change", { operation: "clear", cleared: { id: "unknown" }, clearedAt: 6 }),
    ]);
    assert.deepEqual(items.map((item) => item.data), [
      { operation: "create", objective: "ship it" },
      { operation: "pause", objective: "ship it" },
      { operation: "block", objective: "ship it", reason: "needs input" },
      { operation: "complete", objective: "ship it" },
      { operation: "clear", objective: "ship it" },
      { operation: "clear" },
    ]);
    assert.deepEqual(items.map((item) => item.id), ["goal:1", "goal:2", "goal:3", "goal:4", "goal:5", "goal:6"]);
  });

  it("emits no goal card for changes made while a /goal command runs", () => {
    const projector = new TimelineProjector("s", true);
    const items = cards(projector, [
      ev(1, "command/run", { commandId: "c1", name: "goal", args: " ship it", source: { kind: "user" } }),
      goalEvent(2, "create"),
      ev(3, "command/done", { commandId: "c1", kind: "success", text: "Goal created" }),
      ev(4, "command/run", { commandId: "c2", name: "goal", args: " clear", source: { kind: "user" } }),
      ev(5, "goal/change", { operation: "clear", cleared: { id: "g1", revision: 1 }, clearedAt: 5 }),
      ev(6, "command/done", { commandId: "c2", kind: "success", text: "Goal cleared." }),
      goalEvent(7, "pause"),
      ev(8, "command/run", { commandId: "c3", name: "plan", source: { kind: "user" } }),
      goalEvent(9, "block"),
      ev(10, "command/done", { commandId: "c3", kind: "success" }),
    ]);
    assert.deepEqual(items.map((item) => [item.id, (item.data as { operation: string }).operation]), [
      ["goal:7", "pause"],
      ["goal:9", "block"],
    ]);
  });

  it("stops suppressing goal cards after a /goal command that never reported done", () => {
    const projector = new TimelineProjector("s", true);
    const items = cards(projector, [
      ev(1, "command/run", { commandId: "c1", name: "goal", source: { kind: "user" } }),
      goalEvent(2, "create"),
      ev(3, "turn/start", {}),
      goalEvent(4, "pause"),
    ]);
    assert.deepEqual(items.map((item) => item.id), ["goal:4"]);
  });

  it("remembers the objective of a goal created by a /goal command", () => {
    const projector = new TimelineProjector("s", true);
    const items = cards(projector, [
      ev(1, "command/run", { commandId: "c1", name: "goal", source: { kind: "user" } }),
      goalEvent(2, "create"),
      ev(3, "command/done", { commandId: "c1", kind: "success", text: "Goal created" }),
      goalUser(4, 1),
    ]);
    assert.deepEqual(items.map((item) => item.data), [
      { operation: "continue", round: 1, maxRounds: 10, objective: "ship it" },
    ]);
  });

  it("emits continue cards for goal rounds from 1 and none for round 0", () => {
    const projector = new TimelineProjector("s", true);
    const items = cards(projector, [goalEvent(1, "create"), goalUser(2, 0), goalUser(3, 3)]);
    assert.deepEqual(items.map((item) => [item.id, item.data]), [
      ["goal:1", { operation: "create", objective: "ship it" }],
      ["goal-continue:3", { operation: "continue", round: 3, maxRounds: 10, objective: "ship it" }],
    ]);
  });

  it("emits no cards without the timeline.plugin capability", () => {
    const projector = new TimelineProjector("s", false);
    const events = [
      ev(1, "permission/preset", { preset: "a" }),
      ev(2, "permission/preset", { preset: "b" }),
      ev(3, "plan/mode", { active: true }),
      goalEvent(4, "create"),
      goalUser(5, 1),
    ];
    assert.deepEqual(events.flatMap((event) => projector.projectEvent(event)), []);
  });

  it("seeds state from unreplayed history without emitting", () => {
    const history = [
      ev(1, "permission/preset", { preset: "read-only" }),
      ev(2, "plan/mode", { active: true }),
      goalEvent(3, "create"),
    ];
    const projector = new TimelineProjector("s", true);
    projector.seed(history);
    const items = cards(projector, [
      ev(4, "plan/mode", { active: true }),
      ev(5, "permission/preset", { preset: "read-only" }),
      ev(6, "permission/preset", { preset: "workspace-write" }),
      ev(7, "plan/mode", { active: false }),
      goalUser(8, 2),
    ]);
    assert.deepEqual(items.map((item) => [item.id, item.data]), [
      ["permission-preset:6", { preset: "workspace-write" }],
      ["plan-mode:7", { active: false }],
      ["goal-continue:8", { operation: "continue", round: 2, maxRounds: 10, objective: "ship it" }],
    ]);
  });

  it("produces the same cards on replay as live and does not hide goal user messages", () => {
    const history = [
      ev(1, "permission/preset", { preset: "read-only" }),
      goalEvent(2, "create"),
      goalUser(3, 1),
      ev(4, "plan/mode", { active: true }),
      ev(5, "permission/preset", { preset: "workspace-write" }),
    ];
    const live = new TimelineProjector("s", true);
    const replay = new TimelineProjector("s", true);
    const liveItems = history.flatMap((event) => live.projectEvent(event));
    const replayItems = history.flatMap((event) => replay.projectEvent(event));
    assert.deepEqual(replayItems, liveItems);
    assert.equal(liveItems.length, 4);
    assert.ok(liveItems.every((event) => timelineItem(event).type === "plugin"));
  });
});

describe("TimelineProjector stream payloads", () => {
  const chunk = (attemptId: string, index: number, text: string) => ({
    type: "chunk" as const,
    attemptId,
    revision: 0,
    index,
    time: 1_000 + index,
    chunk: { type: "text-delta", index: 0, text },
  });

  const streamedText = (event: ProviderEvent | undefined) => {
    assert.ok(event);
    const item = timelineItem(event);
    assert.equal(item.type, "assistant_message");
    return item.type === "assistant_message" ? item.text : "";
  };

  it("sends each delta once instead of resending the accumulated text", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });

    const deltas = ["Hel", "lo", ", ", "world"];
    const sent = deltas.map((text, index) => streamedText(projector.projectStream(chunk("a1", 10 + index, text))[0]));

    assert.deepEqual(sent, deltas);
    assert.equal(sent.join(""), "Hello, world");
  });

  it("keeps payload volume linear in the number of deltas", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });

    const deltas = Array.from({ length: 200 }, (_, index) => `chunk-${index};`);
    let sentChars = 0;
    for (const [index, text] of deltas.entries()) {
      sentChars += streamedText(projector.projectStream(chunk("a1", index, text))[0]).length;
    }

    assert.equal(sentChars, deltas.join("").length);
  });

  it("gives every delta its own id so Paseo keeps repeated text", () => {
    // Paseo treats same-id assistant text as a cumulative snapshot and keeps
    // only the difference. Two identical deltas under one id would collapse
    // into one, and a delta starting with the previous one would lose its head.
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });

    const deltas = ["    ", "    ", "x", " ", " foo"];
    const events = deltas.map((text, index) => projector.projectStream(chunk("a1", 10 + index, text))[0]);

    const ids = events.map((event) => {
      assert.ok(event);
      return timelineItem(event).id;
    });
    assert.equal(new Set(ids).size, deltas.length);

    const sent = events.map((event) => {
      assert.ok(event);
      const item = timelineItem(event);
      return item.type === "assistant_message" ? item.text : "";
    });
    assert.deepEqual(sent, deltas);
    assert.equal(sent.join(""), deltas.join(""));
  });

  it("does not emit an item for an empty delta", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });

    assert.deepEqual(projector.projectStream(chunk("a1", 0, "")), []);
  });

  it("sends reasoning deltas the same way", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });

    const reasoning = (index: number, text: string) => ({
      type: "chunk" as const,
      attemptId: "a1",
      revision: 0,
      index,
      time: 1_000 + index,
      chunk: { type: "reasoning-delta", index: 0, text },
    });

    const deltas = ["Think", "ing", " hard"];
    const sent = deltas.map((text, index) => {
      const [event] = projector.projectStream(reasoning(index, text));
      assert.ok(event);
      const item = timelineItem(event);
      assert.equal(item.type, "reasoning");
      return item.type === "reasoning" ? item.text : "";
    });

    assert.deepEqual(sent, deltas);
  });
  it("does not repeat text that the stream already delivered", () => {
    // Reproduces the regression where the settled message re-sent the whole
    // reply next to the streamed deltas, so Paseo showed the text twice.
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });

    const deltas = ["Hel", "lo, ", "wor", "ld"];
    const streamed: string[] = [];
    for (const [index, text] of deltas.entries()) {
      const [event] = projector.projectStream({
        type: "chunk",
        attemptId: "a1",
        revision: 0,
        index: 100 + index,
        time: 1_000 + index,
        chunk: { type: "text-delta", index: 0, text },
      });
      const item = timelineItem(event!);
      assert.equal(item.type, "assistant_message");
      if (item.type === "assistant_message") streamed.push(item.text);
    }

    const durable = projector.projectEvent({
      type: "assistant/message",
      seq: 20,
      time: 2_000,
      data: {
        turn: 1,
        step: 1,
        message: { id: "message-1", content: [{ type: "text", text: "Hello, world" }] },
      },
    });

    assert.deepEqual(streamed, deltas);
    assert.deepEqual(durable, []);
    assert.equal(streamed.join(""), "Hello, world");
  });

  it("sends only the tail when the stream stopped short of the settled text", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });
    projector.projectStream({
      type: "chunk",
      attemptId: "a1",
      revision: 0,
      index: 100,
      time: 1_000,
      chunk: { type: "text-delta", index: 0, text: "Hello" },
    });

    const durable = projector.projectEvent({
      type: "assistant/message",
      seq: 20,
      time: 2_000,
      data: {
        turn: 1,
        step: 1,
        message: { id: "message-1", content: [{ type: "text", text: "Hello, world" }] },
      },
    });

    const item = timelineItem(durable[0]!);
    assert.equal(item.type, "assistant_message");
    assert.equal(item.type === "assistant_message" ? item.text : "", ", world");
  });

  it("replays the full text when no stream reached this projector", () => {
    const projector = new TimelineProjector("paseo-session");
    const durable = projector.projectEvent({
      type: "assistant/message",
      seq: 20,
      time: 2_000,
      data: {
        turn: 1,
        step: 1,
        message: { id: "message-1", content: [{ type: "text", text: "Hello, world" }] },
      },
    });

    const item = timelineItem(durable[0]!);
    assert.equal(item.type, "assistant_message");
    assert.equal(item.type === "assistant_message" ? item.text : "", "Hello, world");
  });
  it("keeps the settled tail in the same message as the streamed deltas", () => {
    // Paseo only merges adjacent items whose messageId matches. The settled
    // tail has to reuse the block id, or the reply splits into two messages.
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 });
    const [streamed] = projector.projectStream({
      type: "chunk",
      attemptId: "a1",
      revision: 0,
      index: 10,
      time: 1_000,
      chunk: { type: "text-delta", index: 0, text: "Hello" },
    });
    const durable = projector.projectEvent({
      type: "assistant/message",
      seq: 20,
      time: 2_000,
      data: {
        turn: 1,
        step: 1,
        message: { id: "message-1", content: [{ type: "text", text: "Hello, world" }] },
      },
    });

    const streamedItem = timelineItem(streamed!);
    const tailItem = timelineItem(durable[0]!);
    assert.equal(streamedItem.type, "assistant_message");
    assert.equal(tailItem.type, "assistant_message");
    assert.equal(
      streamedItem.type === "assistant_message" ? streamedItem.messageId : undefined,
      tailItem.type === "assistant_message" ? tailItem.messageId : null,
    );
  });

  it("drops streamed text when an attempt fails without settling", () => {
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 1, turn: 2, step: 3 });
    projector.projectStream({
      type: "chunk",
      attemptId: "a1",
      revision: 2,
      index: 0,
      time: 1_000,
      chunk: { type: "text-delta", index: 0, text: "Partial" },
    });
    projector.projectEvent({
      type: "assistant/attempt",
      seq: 8,
      time: 1_001,
      data: { turn: 2, step: 3, message: { content: [{ type: "text", text: "Partial" }] }, stream: [] },
    });

    // A later attempt on the same step must not inherit the abandoned tail.
    projector.projectStream({ type: "start", attemptId: "a2", revision: 4, turn: 2, step: 3 });
    const retried = projector.projectStream({
      type: "chunk",
      attemptId: "a2",
      revision: 5,
      index: 0,
      time: 1_002,
      chunk: { type: "text-delta", index: 0, text: "Complete" },
    });
    const item = timelineItem(retried[0]!);
    assert.equal(item.type, "assistant_message");
    assert.equal(item.type === "assistant_message" ? item.text : "", "Complete");
  });
  it("releases an attempt's streamed text when its end frame arrives", () => {
    // DSH sends `end` after the settled event for every attempt, including one
    // that never settles, so this is where an abandoned attempt is released.
    const projector = new TimelineProjector("paseo-session");
    projector.projectStream({ type: "start", attemptId: "a1", revision: 1, turn: 2, step: 3 });
    projector.projectStream({
      type: "chunk",
      attemptId: "a1",
      revision: 2,
      index: 0,
      time: 1_000,
      chunk: { type: "text-delta", index: 0, text: "Partial" },
    });
    projector.projectStream({
      type: "end",
      attemptId: "a1",
      revision: 3,
      index: 1,
      outcome: { kind: "abandoned" },
    });

    // A later attempt on the same step starts from a clean slate.
    projector.projectStream({ type: "start", attemptId: "a2", revision: 4, turn: 2, step: 3 });
    const retried = projector.projectStream({
      type: "chunk",
      attemptId: "a2",
      revision: 5,
      index: 0,
      time: 1_002,
      chunk: { type: "text-delta", index: 0, text: "Complete" },
    });
    const item = timelineItem(retried[0]!);
    assert.equal(item.type, "assistant_message");
    assert.equal(item.type === "assistant_message" ? item.text : "", "Complete");
  });
});
