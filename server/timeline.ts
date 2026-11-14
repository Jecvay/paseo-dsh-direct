import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { DshSessionEvent, DshStreamFrame, JsonObject } from "../shared/bridge-protocol.js";
import {
  CARD_KINDS,
  CARD_VERSION,
  PLUGIN_ID,
  type GoalCard,
} from "../shared/timeline-cards.js";
import { attachmentLabel } from "./prompt-content.js";
import { classifyTurnEnd } from "./turn-end.js";
import { arrayValue, numberValue, objectValue, stringValue } from "./values.js";

export type SessionEvent = Extract<ProviderEvent, { sessionId: string }>;
export type ToolCallItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;
export const STREAM_BLOCK_SEPARATOR = "#";

export function streamBlockPrefix(id: string): string | undefined {
  const hash = id.lastIndexOf(STREAM_BLOCK_SEPARATOR);
  return hash > 0 ? id.slice(0, hash) : undefined;
}

/** Converts DSH durable events and transient stream frames into Paseo timeline items. */
export class TimelineProjector {
  private readonly compactions = new Map<string, { trigger: "auto" | "manual"; preTokens?: number }>();
  private readonly tools = new Map<string, ToolCallItem>();
  private readonly dirtyTools = new Set<string>();
  private readonly attachedSubagentChildren = new Map<string, string>();
  private readonly settledAttempts = new Map<string, number>();
  private readonly settlementOrdinals = new Map<number, number>();
  private readonly liveAttempts = new Map<
    string,
    { turn: number; step: number; ordinal: number }
  >();
  private readonly liveAttemptByStep = new Map<
    string,
    { attemptId: string; ordinal: number }
  >();
  /**
   * Text already delivered through `projectStream`, grouped by attempt so an
   * attempt that never settles drops exactly its own entries. Within an attempt
   * the key is the block id: a durable message repeats what was streamed, and
   * only the tail the stream did not reach may be sent, or Paseo concatenates
   * both copies.
   */
  private readonly streamedText = new Map<string, Map<string, string>>();

  private planActive = false;
  private lastPreset: string | undefined;
  private readonly goals = new Map<string, { objective?: string; maxRounds?: number }>();
  /** Ids of `/goal` commands between their `command/run` and `command/done`; dsh prints their result itself. */
  private readonly goalCommands = new Set<string>();

  /**
   * @param paseoSessionId Paseo session id stamped on every projected event.
   * @param pluginCards Whether the host negotiated `timeline.plugin`; when false no cards are emitted.
   * @param parentSessionId Native parent session id when projecting a subagent child session.
   */
  constructor(
    private readonly paseoSessionId: string,
    private readonly pluginCards = false,
    private readonly parentSessionId?: string,
  ) {}

  /**
   * Records plan mode, permission preset and goal objectives from history that is
   * not replayed, so the first live change is compared against the right value.
   * @param events DSH durable events of the resumed session, oldest first.
   */
  seed(events: readonly DshSessionEvent[]): void {
    for (const event of events) this.projectCards(event);
  }

  projectEvent(
    event: DshSessionEvent,
    options: { clientMessageId?: string } = {},
  ): SessionEvent[] {
    const timestamp = toTimestamp(event.time);
    // A `/goal` command whose `command/done` never arrived is over once any of these later events appears.
    if (["command/run", "user/message", "turn/start", "turn/end"].includes(event.type)) this.goalCommands.clear();
    switch (event.type) {
      case "user/message":
        return [
          ...this.projectCards(event, timestamp),
          ...this.projectUserMessage(event, timestamp),
        ];
      case "plan/mode":
      case "permission/preset":
      case "goal/change":
        return this.projectCards(event, timestamp);
      case "command/run":
        return this.projectCommandRun(event, options.clientMessageId, timestamp);
      case "command/done":
        return this.projectCommandDone(event, timestamp);
      case "turn/end":
        return this.projectTurnEnd(event, timestamp);
      case "compaction/start":
      case "compaction/summary":
      case "compaction/end":
        return this.projectCompaction(event, timestamp);
      case "assistant/message":
      case "assistant/attempt":
        return this.projectAssistantMessage(event, timestamp);
      case "tool/call":
        return this.projectToolCall(event, timestamp);
      case "tool/result":
        return this.projectToolResult(event, timestamp);
      default:
        return [];
    }
  }

  projectStream(frame: DshStreamFrame, options?: { deferToolDetail?: boolean }): SessionEvent[] {
    if (frame.type === "start") {
      const key = stepKey(frame.turn, frame.step);
      const ordinal = this.settledAttempts.get(key) ?? 0;
      this.liveAttempts.set(frame.attemptId, { turn: frame.turn, step: frame.step, ordinal });
      this.liveAttemptByStep.set(key, { attemptId: frame.attemptId, ordinal });
      return [];
    }
    if (frame.type === "end") {
      // DSH sends `end` after the settled event for every attempt, including an
      // abandoned one, so this is the single point that releases the attempt's
      // streamed text when the settled event never consumed it.
      this.streamedText.delete(frame.attemptId);
      return [];
    }
    if (frame.type !== "chunk") return [];
    const chunk = frame.chunk;
    const kind = stringValue(chunk.type);
    const index = numberValue(chunk.index) ?? frame.index;
    if (kind === "text-delta" || kind === "reasoning-delta") {
      const type = kind === "text-delta" ? "assistant_message" : "reasoning";
      const attempt = this.liveAttempts.get(frame.attemptId);
      const blockId = attempt
        ? assistantItemId(type, attempt.turn, attempt.step, attempt.ordinal, index)
        : transientItemId(type, frame.attemptId, index);
      const delta = stringValue(chunk.text) ?? "";
      if (delta.length === 0) return [];
      const attemptText = this.streamedText.get(frame.attemptId) ?? new Map<string, string>();
      attemptText.set(blockId, (attemptText.get(blockId) ?? "") + delta);
      this.streamedText.set(frame.attemptId, attemptText);
      // Paseo treats same-id assistant text as a cumulative snapshot and slices
      // off the previous text prefix. To avoid sending O(n^2) text across
      // chunks, we send only each delta under its
      // own id (reusing one id for non-cumulative deltas would drop repeated
      // indentation or deltas starting with the previous delta) and share
      // `messageId: blockId` on assistant messages so Paseo merges adjacent
      // chunks into one message.
      return [
        timeline(
          this.paseoSessionId,
          type === "assistant_message"
            ? {
                type,
                id: `${blockId}${STREAM_BLOCK_SEPARATOR}${frame.revision}:${frame.index}`,
                messageId: blockId,
                text: delta,
              }
            : { type, id: `${blockId}${STREAM_BLOCK_SEPARATOR}${frame.revision}:${frame.index}`, text: delta },
          toTimestamp(frame.time),
        ),
      ];
    }
    if (kind === "tool-call-delta") {
      const callId = stringValue(chunk.id) ?? `tool:${frame.attemptId}:${index}`;
      const existing = this.tools.get(callId);
      const argumentDelta = stringValue(chunk.argumentsDelta) ?? "";
      const argumentsText =
        ((existing?.metadata && stringValue(existing.metadata.argumentsText)) ?? "") + argumentDelta;
      const name = stringValue(chunk.name) ?? existing?.name ?? "tool";
      return [
        this.upsertRunningToolCall(callId, name, argumentsText, argumentsText, {
          defer: options?.deferToolDetail === true,
          timestamp: toTimestamp(frame.time),
        }),
      ];
    }
    return [];
  }

  /**
   * Parses accumulated streamed arguments for a deferred `tool_call` once per flush
   * instead of on every `tool-call-delta`. Returns `undefined` when no deferred update is pending.
   */
  materializeToolCall(callId: string, timestamp?: string): SessionEvent | undefined {
    if (!this.dirtyTools.delete(callId)) return undefined;
    const existing = this.tools.get(callId);
    if (!existing) return undefined;
    const argumentsText =
      (existing.metadata && stringValue(existing.metadata.argumentsText)) ?? "";
    const detail = this.buildToolDetail(callId, existing.name, parseArguments(argumentsText));
    const item: ToolCallItem = { ...existing, detail };
    this.tools.set(callId, item);
    return timeline(this.paseoSessionId, item, timestamp);
  }

  /** Returns the authoritative current `tool_call` event (materializing if deferred). */
  latestToolCall(callId: string, timestamp?: string): SessionEvent | undefined {
    const materialized = this.materializeToolCall(callId, timestamp);
    if (materialized) return materialized;
    const existing = this.tools.get(callId);
    return existing ? timeline(this.paseoSessionId, existing, timestamp) : undefined;
  }

  failRunningTools(message: string): SessionEvent[] {
    return this.settleRunningTools(message);
  }

  attachSubagentChild(callId: string, childSessionId: string): SessionEvent | undefined {
    const alreadyAttached = this.attachedSubagentChildren.get(callId) === childSessionId;
    this.attachedSubagentChildren.set(callId, childSessionId);
    const materialized = this.materializeToolCall(callId);
    if (
      !alreadyAttached &&
      materialized?.type === "timeline.item" &&
      materialized.item.type === "tool_call" &&
      materialized.item.detail.type === "sub_agent" &&
      materialized.item.detail.childSessionId === childSessionId
    ) {
      return materialized;
    }
    const existing = this.tools.get(callId);
    if (!existing || existing.detail.type !== "sub_agent") return undefined;
    if (existing.detail.childSessionId === childSessionId) return undefined;
    const updated: ToolCallItem = {
      ...existing,
      detail: { ...existing.detail, childSessionId },
    };
    this.tools.set(callId, updated);
    return timeline(this.paseoSessionId, updated);
  }

  private projectCommandRun(
    event: DshSessionEvent,
    clientMessageId: string | undefined,
    timestamp?: string,
  ): SessionEvent[] {
    const data = event.data;
    const commandId = stringValue(data.commandId);
    const name = stringValue(data.name);
    if (!commandId || !name) return [];
    if (name === "goal") this.goalCommands.add(commandId);
    const id = `command:${commandId}`;
    // `args` keeps DSH's raw separator whitespace after the command name.
    const text = `/${name}${stringValue(data.args) ?? ""}`;
    return [
      timeline(
        this.paseoSessionId,
        { type: "user_message", id, messageId: id, text, ...(clientMessageId ? { clientMessageId } : {}) },
        timestamp,
      ),
    ];
  }

  private projectCommandDone(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const commandId = stringValue(data.commandId);
    const message = stringValue(data.text);
    if (commandId) this.goalCommands.delete(commandId);
    if (!commandId || !message) return [];
    return [
      this.notice(`command-done:${commandId}`, data.kind === "error" ? "error" : "info", message, timestamp),
    ];
  }

  /** Failures (replay only; live failures travel on session.turn) and abnormal ends. */
  private projectTurnEnd(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const terminal = classifyTurnEnd(event.data);
    const projected: SessionEvent[] = [];
    if (terminal.warning) projected.push(this.notice(`turn-end:${event.seq}`, "warning", terminal.warning, timestamp));
    if (terminal.error) {
      projected.push(
        timeline(this.paseoSessionId, { type: "error", id: `turn-error:${event.seq}`, message: terminal.error.message }, timestamp),
      );
    }
    // A turn never emits further tool results: settle whatever is still running
    // so interrupted turns do not leave permanently spinning tool cards.
    projected.push(...this.settleRunningTools(terminal.error?.message ?? terminal.warning ?? "Turn ended", timestamp));
    return projected;
  }

  /** Marks every running tool card failed; used at turn end and bridge failure. */
  private settleRunningTools(message: string, timestamp?: string): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const [callId, current] of this.tools) {
      if (current.status !== "running") continue;
      this.materializeToolCall(callId);
      const item = this.tools.get(callId) ?? current;
      const failed: ToolCallItem = {
        ...item,
        status: "failed",
        error: message,
      };
      this.tools.set(callId, failed);
      events.push(timeline(this.paseoSessionId, failed, timestamp));
    }
    return events;
  }

  private buildToolDetail(callId: string, name: string, args: JsonObject): ProviderToolCallDetail {
    return preserveSubagentChild(toolDetail(name, args), this.attachedSubagentChildren.get(callId));
  }

  private upsertRunningToolCall(
    callId: string,
    name: string,
    argumentsText: string,
    rawArgs: unknown,
    options: { defer?: boolean; timestamp?: string } = {},
  ): SessionEvent {
    const existing = this.tools.get(callId);
    const defer = options.defer === true;
    const detail = defer
      ? (existing?.detail ?? ({ type: "unknown", input: {}, output: {} } as const))
      : this.buildToolDetail(callId, name, parseArguments(rawArgs));
    const item: ToolCallItem = {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name,
      status: "running",
      error: null,
      detail,
      metadata: { argumentsText },
    };
    if (defer) this.dirtyTools.add(callId);
    else this.dirtyTools.delete(callId);
    this.tools.set(callId, item);
    return timeline(this.paseoSessionId, item, options.timestamp);
  }

  private notice(
    id: string,
    level: "info" | "warning" | "error",
    message: string,
    timestamp?: string,
  ): SessionEvent {
    return timeline(this.paseoSessionId, { type: "notification", id, level, message }, timestamp);
  }

  private projectCompaction(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const compactionId = stringValue(event.data.compactionId);
    if (!compactionId) return [];
    const id = `compaction:${compactionId}`;
    const known = this.compactions.get(compactionId);
    const trigger = known?.trigger ?? (stringValue(event.data.sourceCommandId) ? "manual" : "auto");
    if (event.type === "compaction/start") {
      this.compactions.set(compactionId, { trigger });
      return [timeline(this.paseoSessionId, { type: "compaction", id, status: "loading", trigger }, timestamp)];
    }
    if (event.type === "compaction/summary") {
      const tokens = numberValue(event.data.shadowedTokenCount);
      if (known && tokens !== undefined) known.preTokens = tokens;
      return [];
    }
    this.compactions.delete(compactionId);
    const preTokens = known?.preTokens;
    const projected = [
      timeline(
        this.paseoSessionId,
        { type: "compaction", id, status: "completed", trigger, ...(preTokens !== undefined ? { preTokens } : {}) },
        timestamp,
      ),
    ];
    const error = stringValue(event.data.error);
    if (error) projected.push(this.notice(`${id}:error`, "error", `Compaction failed: ${error}`, timestamp));
    return projected;
  }

  /** Updates card state for `event` and returns the plugin cards it produces (none when cards are off). */
  private projectCards(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const cards: Array<{ id: string; kind: string; data: Record<string, string | number | boolean> }> = [];
    const data = event.data;
    if (event.type === "plan/mode" && typeof data.active === "boolean") {
      if (data.active !== this.planActive) {
        this.planActive = data.active;
        cards.push({ id: `plan-mode:${event.seq}`, kind: CARD_KINDS.planMode, data: { active: data.active } });
      }
    } else if (event.type === "permission/preset" && typeof data.preset === "string") {
      const previous = this.lastPreset;
      this.lastPreset = data.preset;
      if (previous !== undefined && previous !== data.preset) {
        cards.push({ id: `permission-preset:${event.seq}`, kind: CARD_KINDS.permissionPreset, data: { preset: data.preset } });
      }
    } else if (event.type === "goal/change") {
      const card = this.goalChangeCard(data);
      // A change made while a `/goal` command runs is already reported by that command's own output.
      if (card && this.goalCommands.size === 0) cards.push({ id: `goal:${event.seq}`, kind: CARD_KINDS.goal, data: { ...card } });
    } else if (event.type === "user/message") {
      const source = objectValue(data.source);
      const round = numberValue(source?.round);
      const goalId = stringValue(source?.goalId);
      if (source?.kind === "goal" && round !== undefined && round >= 1) {
        const known = goalId ? this.goals.get(goalId) : undefined;
        const card: GoalCard = {
          operation: "continue",
          round,
          ...(known?.maxRounds !== undefined ? { maxRounds: known.maxRounds } : {}),
          ...(known?.objective !== undefined ? { objective: known.objective } : {}),
        };
        cards.push({ id: `goal-continue:${event.seq}`, kind: CARD_KINDS.goal, data: { ...card } });
      }
    }
    if (!this.pluginCards) return [];
    return cards.map((card) =>
      timeline(
        this.paseoSessionId,
        { type: "plugin", id: card.id, pluginId: PLUGIN_ID, kind: card.kind, version: CARD_VERSION, data: card.data },
        timestamp,
      ),
    );
  }

  private goalChangeCard(data: JsonObject): GoalCard | undefined {
    const operation = stringValue(data.operation);
    if (
      operation !== "create" && operation !== "edit" && operation !== "pause" &&
      operation !== "resume" && operation !== "complete" && operation !== "block" &&
      operation !== "clear"
    ) {
      return undefined;
    }
    const goal = objectValue(operation === "clear" ? data.cleared : data.goal);
    const goalId = stringValue(goal?.id);
    if (operation !== "clear" && goalId) {
      this.goals.set(goalId, {
        objective: stringValue(goal?.objective),
        maxRounds: numberValue(goal?.maxGoalRounds),
      });
    }
    const objective = stringValue(goal?.objective) ?? (goalId ? this.goals.get(goalId)?.objective : undefined);
    const reason = operation === "block" ? stringValue(objectValue(goal?.blockedReason)?.message) : undefined;
    return {
      operation,
      ...(objective !== undefined ? { objective } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private projectUserMessage(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const source = objectValue(data.source);
    const isUser = source?.kind === "user";
    const isParentRelay =
      this.parentSessionId !== undefined &&
      source?.kind === "agent-message" &&
      stringValue(source.senderSessionId) === this.parentSessionId;
    if (!isUser && !isParentRelay) return [];
    const id = stringValue(data.id) ?? `event:${event.seq}`;
    const rawContent =
      this.parentSessionId !== undefined
        ? stripSubagentBoilerplate(data.content, isParentRelay)
        : data.content;
    const text = userContentText(rawContent);
    if (!text) return [];
    return [timeline(this.paseoSessionId, { type: "user_message", id, messageId: id, text }, timestamp)];
  }

  private projectAssistantMessage(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const message = objectValue(data.message) ?? data;
    const messageId = stringValue(message.id) ?? `event:${event.seq}`;
    const turn = numberValue(data.turn) ?? 0;
    const step = numberValue(data.step) ?? 0;
    const settlement = this.settlementOrdinal(event.seq, turn, step);
    const ordinal = settlement.ordinal;
    const content = arrayValue(message.content);
    const projected: SessionEvent[] = [];
    content.forEach((raw, index) => {
      const block = objectValue(raw);
      if (!block) return;
      const type = stringValue(block.type);
      if (type === "text" || type === "reasoning") {
        const itemType = type === "text" ? "assistant_message" : "reasoning";
        const id = assistantItemId(itemType, turn, step, ordinal, index);
        const text = stringValue(block.text) ?? "";
        const rest = this.remainingText(settlement.attemptId, id, text);
        if (rest.length === 0) return;
        projected.push(
          timeline(
            this.paseoSessionId,
            itemType === "assistant_message"
              ? // The tail must carry the same messageId as the streamed deltas
                // of this block, or Paseo keeps it as a separate message.
                { type: itemType, id, messageId: id, text: rest }
              : { type: itemType, id, text: rest },
            timestamp,
          ),
        );
      } else if (type === "tool-call") {
        const callId = stringValue(block.id) ?? stringValue(block.toolCallId) ?? `${messageId}:${index}`;
        const name = stringValue(block.name) ?? "tool";
        projected.push(
          this.upsertRunningToolCall(callId, name, stringifyValue(block.arguments), block.arguments, { timestamp }),
        );
      }
    });
    // No session.usage here: Paseo replaces `lastUsage` whole, and a per-message
    // reading would overwrite the bridge's complete one with fewer fields.
    return projected;
  }

  /**
   * Content of a settled block that the stream has not delivered yet. The stream
   * and the durable record describe the same text, so the settled message only
   * contributes the tail the stream did not reach.
   */
  private remainingText(attemptId: string | undefined, id: string, settled: string): string {
    if (attemptId === undefined) return settled;
    const attemptText = this.streamedText.get(attemptId);
    if (attemptText === undefined) return settled;
    const streamed = attemptText.get(id);
    if (streamed === undefined) return settled;
    attemptText.delete(id);
    if (attemptText.size === 0) this.streamedText.delete(attemptId);
    return settled.startsWith(streamed) ? settled.slice(streamed.length) : settled;
  }

  /** Ordinal for a settled message plus the live attempt that produced it. */
  private settlementOrdinal(
    seq: number,
    turn: number,
    step: number,
  ): { ordinal: number; attemptId?: string } {
    const known = this.settlementOrdinals.get(seq);
    if (known !== undefined) return { ordinal: known };

    const key = stepKey(turn, step);
    const live = this.liveAttemptByStep.get(key);
    const ordinal = live?.ordinal ?? this.settledAttempts.get(key) ?? 0;
    this.settlementOrdinals.set(seq, ordinal);
    this.settledAttempts.set(key, Math.max(this.settledAttempts.get(key) ?? 0, ordinal + 1));
    if (live) {
      this.liveAttemptByStep.delete(key);
      this.liveAttempts.delete(live.attemptId);
    }
    return live ? { ordinal, attemptId: live.attemptId } : { ordinal };
  }

  private projectToolCall(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const callId = stringValue(event.data.callId) ?? `event:${event.seq}`;
    const name = stringValue(event.data.name) ?? "tool";
    return [
      this.upsertRunningToolCall(
        callId,
        name,
        stringifyValue(event.data.arguments),
        event.data.arguments,
        { timestamp },
      ),
    ];
  }

  private projectToolResult(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const message = objectValue(event.data.message) ?? event.data;
    // DSH tool messages carry the call id next to the content (`toolCallId`,
    // `source.callId`) with plain text blocks inside; a `tool-result` content
    // block is accepted for layouts that embed it instead.
    const direct = objectValue(message.content);
    const block = direct?.type === "tool-result"
      ? direct
      : arrayValue(message.content)
          .map(objectValue)
          .find((candidate) => candidate?.type === "tool-result");
    const source = objectValue(message.source);
    const callId =
      stringValue(message.toolCallId) ??
      stringValue(message.tool_call_id) ??
      (source?.kind === "tool" ? stringValue(source.callId) : undefined) ??
      stringValue(block?.toolCallId) ??
      stringValue(block?.tool_call_id);
    if (!callId) return [];
    this.materializeToolCall(callId);
    const existing: ToolCallItem = this.tools.get(callId) ?? {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name: "tool",
      status: "running",
      error: null,
      detail: { type: "unknown", input: {}, output: {} },
    };
    const payload = block?.content ?? message.content;
    const output = contentText(payload) || stringifyValue(payload);
    const isError =
      message.isError === true || event.data.isError === true || block?.isError === true;
    const detail = withOutput(existing.detail, output);
    if (detail.type === "sub_agent" && detail.childSessionId) {
      this.attachedSubagentChildren.set(callId, detail.childSessionId);
    }
    const item: ToolCallItem = isError
      ? { ...existing, detail, status: "failed", error: output || "Tool failed" }
      : { ...existing, detail, status: "completed", error: null };
    this.tools.set(callId, item);
    return [timeline(this.paseoSessionId, item, timestamp)];
  }
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

function assistantItemId(
  type: string,
  turn: number,
  step: number,
  ordinal: number,
  index: number,
): string {
  return `${type}:turn:${turn}:step:${step}:attempt:${ordinal}:${index}`;
}

function transientItemId(type: string, attemptId: string, index: number): string {
  return `${type}:transient:${attemptId}:${index}`;
}

function timeline(
  sessionId: string,
  item: ProviderTimelineItem,
  timestamp?: string,
): SessionEvent {
  return { type: "timeline.item", sessionId, item, ...(timestamp ? { timestamp } : {}) };
}

function preserveSubagentChild(
  detail: ProviderToolCallDetail,
  childSessionId: string | undefined,
): ProviderToolCallDetail {
  if (!childSessionId || detail.type !== "sub_agent" || detail.childSessionId) return detail;
  return { ...detail, childSessionId };
}

function toolDetail(name: string, args: JsonObject): ProviderToolCallDetail {
  const normalized = name.toLowerCase();

  // DSH's built-in tools are matched by exact name. Substring patterns get the
  // common ones wrong (`todo_write` is not a file write, `read_image` is not a
  // text read), and they would also claim unrelated MCP tools.
  if (normalized === "bash" || normalized === "pwsh") {
    // An empty command during streaming keeps the card from showing the raw
    // half-parsed JSON; the final frame fills it in.
    return {
      type: "shell",
      command: stringValue(args.command) ?? "",
      cwd: stringValue(args.workdir),
    };
  }
  if (normalized === "read" || normalized === "read_image") {
    return {
      type: "read",
      filePath: stringValue(args.file_path) ?? "",
      offset: numberValue(args.offset),
      limit: numberValue(args.limit),
    };
  }
  if (normalized === "write") {
    return {
      type: "write",
      filePath: stringValue(args.file_path) ?? "",
      content: stringValue(args.content),
    };
  }
  if (normalized === "edit") {
    return {
      type: "edit",
      filePath: stringValue(args.file_path) ?? "",
      oldString: stringValue(args.old_string),
      newString: stringValue(args.new_string),
    };
  }
  if (normalized === "grep") {
    return { type: "search", query: stringValue(args.pattern) ?? "", toolName: "grep" };
  }
  if (normalized === "glob") {
    return { type: "search", query: stringValue(args.pattern) ?? "", toolName: "glob" };
  }
  if (normalized === "web_fetch") {
    return { type: "fetch", url: stringValue(args.url) ?? "" };
  }
  if (normalized === "subagent" || normalized === "subagent_fork") {
    const subAgentType =
      stringValue(args.agent_preset) ??
      (normalized === "subagent_fork" ? "Fork" : "Subagent");
    const description =
      stringValue(args.description) ?? stringValue(args.prompt);
    const childSessionId =
      stringValue(args.subagentId) ?? stringValue(args.childSessionId);
    const log = stringValue(args.prompt) ?? "";
    return {
      type: "sub_agent",
      subAgentType,
      ...(description ? { description } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      log,
    };
  }

  // Everything else, including MCP tools, keeps a generic detail carrying the
  // raw arguments. Guessing a card type from the name would render MCP tools as
  // file operations.
  return { type: "unknown", input: { raw: stringifyValue(args) }, output: {} };
}

function withOutput(detail: ProviderToolCallDetail, output: string): ProviderToolCallDetail {
  switch (detail.type) {
    case "shell":
      return { ...detail, output };
    case "read":
      return { ...detail, content: output };
    case "search":
      return { ...detail, content: output };
    case "fetch":
      return { ...detail, result: output };
    case "sub_agent": {
      const childSessionId = extractSubagentId(output) ?? detail.childSessionId;
      return {
        ...detail,
        ...(childSessionId ? { childSessionId } : {}),
        log: output || detail.log,
      };
    }
    case "plain_text":
      return { ...detail, text: output };
    case "unknown":
      return { ...detail, output };
    default:
      return detail;
  }
}

export function extractSubagentId(output: string): string | undefined {
  const match = /^started subagent\s+([^\s"]+)/i.exec(output.trim());
  if (match?.[1]) return match[1];
  const parsed = objectValue(parseArguments(output));
  return (
    stringValue(parsed?.subagentId) ??
    stringValue(parsed?.childSessionId) ??
    stringValue(parsed?.agent_id)
  );
}

const RETURN_GUIDANCE_PATTERN =
  /^Your parent agent id is ".+"\. Before you finish, send your result to that agent with send_message\(/s;
const AGENT_RELAY_PREFIX_PATTERN = /^Agent\s+\S+\s+sent a message:\s*/;

function stripSubagentBoilerplate(value: unknown, isParentRelay: boolean): unknown {
  if (typeof value === "string") {
    return isParentRelay
      ? value.replace(AGENT_RELAY_PREFIX_PATTERN, "")
      : value.replace(
          /\n+Your parent agent id is "[^"]+"\. Before you finish, send your result to that agent with send_message\([\s\S]*$/,
          "",
        );
  }
  if (!Array.isArray(value) || value.length === 0) return value;
  let blocks = [...value];
  if (isParentRelay) {
    const first = objectValue(blocks[0]);
    const firstText = first?.type === "text" ? stringValue(first.text) : undefined;
    if (firstText !== undefined && AGENT_RELAY_PREFIX_PATTERN.test(firstText)) {
      const rest = firstText.replace(AGENT_RELAY_PREFIX_PATTERN, "");
      if (rest) blocks[0] = { ...first, text: rest };
      else if (blocks.length > 1) blocks = blocks.slice(1);
    }
  }
  if (blocks.length > 1) {
    const last = objectValue(blocks.at(-1));
    const lastText = last?.type === "text" ? stringValue(last.text)?.trim() : undefined;
    if (lastText && RETURN_GUIDANCE_PATTERN.test(lastText)) {
      blocks = blocks.slice(0, -1);
    }
  }
  return blocks;
}

function parseArguments(value: unknown): JsonObject {
  if (objectValue(value)) return objectValue(value)!;
  if (typeof value !== "string") return {};
  try {
    return objectValue(JSON.parse(value)) ?? { value };
  } catch {
    return { value };
  }
}

/** User message text with markers for image and file blocks. */
function userContentText(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value)
    .map((raw) => {
      const block = objectValue(raw);
      if (block?.type === "text") return stringValue(block.text) ?? "";
      if (block?.type === "image") return attachmentLabel("image");
      if (block?.type === "file") return attachmentLabel("file", stringValue(objectValue(block.attachment)?.name));
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  return arrayValue(value)
    .map((raw) => {
      const block = objectValue(raw);
      if (!block) return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function toTimestamp(value: unknown): string | undefined {
  const milliseconds = numberValue(value);
  if (milliseconds === undefined) return undefined;
  const date = new Date(milliseconds < 10_000_000_000 ? milliseconds * 1_000 : milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
