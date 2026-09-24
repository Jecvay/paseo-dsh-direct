import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { DshSessionEvent, DshStreamFrame, JsonObject } from "../shared/bridge-protocol.js";
import { attachmentLabel } from "./prompt-content.js";
import { classifyTurnEnd } from "./turn-end.js";
import { arrayValue, numberValue, objectValue, stringValue } from "./values.js";

export type SessionEvent = Extract<ProviderEvent, { sessionId: string }>;

/** Converts DSH durable events and transient stream frames into Paseo cumulative snapshots. */
export class TimelineProjector {
  private readonly text = new Map<string, string>();
  private readonly compactions = new Map<string, { trigger: "auto" | "manual"; preTokens?: number }>();
  private readonly tools = new Map<string, Extract<ProviderTimelineItem, { type: "tool_call" }>>();
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

  constructor(private readonly paseoSessionId: string) {}

  projectEvent(
    event: DshSessionEvent,
    options: { clientMessageId?: string } = {},
  ): SessionEvent[] {
    const timestamp = toTimestamp(event.time);
    switch (event.type) {
      case "user/message":
        return this.projectUserMessage(event, timestamp);
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

  projectStream(frame: DshStreamFrame): SessionEvent[] {
    if (frame.type === "start") {
      const key = stepKey(frame.turn, frame.step);
      const ordinal = this.settledAttempts.get(key) ?? 0;
      this.liveAttempts.set(frame.attemptId, { turn: frame.turn, step: frame.step, ordinal });
      this.liveAttemptByStep.set(key, { attemptId: frame.attemptId, ordinal });
      return [];
    }
    if (frame.type !== "chunk") return [];
    const chunk = frame.chunk;
    const kind = stringValue(chunk.type);
    const index = numberValue(chunk.index) ?? frame.index;
    if (kind === "text-delta" || kind === "reasoning-delta") {
      const type = kind === "text-delta" ? "assistant_message" : "reasoning";
      const attempt = this.liveAttempts.get(frame.attemptId);
      const id = attempt
        ? assistantItemId(type, attempt.turn, attempt.step, attempt.ordinal, index)
        : transientItemId(type, frame.attemptId, index);
      const cumulative = (this.text.get(id) ?? "") + (stringValue(chunk.text) ?? "");
      this.text.set(id, cumulative);
      return [timeline(this.paseoSessionId, { type, id, text: cumulative }, toTimestamp(frame.time))];
    }
    if (kind === "tool-call-delta") {
      const callId = stringValue(chunk.id) ?? `tool:${frame.attemptId}:${index}`;
      const existing = this.tools.get(callId);
      const argumentDelta = stringValue(chunk.argumentsDelta) ?? "";
      const argumentsText =
        (existing?.metadata && stringValue(existing.metadata.argumentsText)) ?? "";
      const name = stringValue(chunk.name) ?? existing?.name ?? "tool";
      const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
        type: "tool_call",
        id: `tool:${callId}`,
        callId,
        name,
        status: "running",
        error: null,
        detail: toolDetail(name, parseArguments(argumentsText + argumentDelta)),
        metadata: { argumentsText: argumentsText + argumentDelta },
      };
      this.tools.set(callId, item);
      return [timeline(this.paseoSessionId, item, toTimestamp(frame.time))];
    }
    return [];
  }

  failRunningTools(message: string): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const [callId, item] of this.tools) {
      if (item.status !== "running") continue;
      const failed: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
        ...item,
        status: "failed",
        error: message,
      };
      this.tools.set(callId, failed);
      events.push(timeline(this.paseoSessionId, failed));
    }
    return events;
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
    if (!commandId || !message) return [];
    return [
      this.notice(`command-done:${commandId}`, data.kind === "error" ? "error" : "info", message, timestamp),
    ];
  }

  /** Failures (replay only; live failures travel on session.turn) and abnormal ends. */
  private projectTurnEnd(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const terminal = classifyTurnEnd(event.data);
    if (terminal.warning) return [this.notice(`turn-end:${event.seq}`, "warning", terminal.warning, timestamp)];
    if (!terminal.error) return [];
    return [
      timeline(this.paseoSessionId, { type: "error", id: `turn-error:${event.seq}`, message: terminal.error.message }, timestamp),
    ];
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

  private projectUserMessage(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const source = objectValue(data.source);
    if (source?.kind !== "user") return [];
    const id = stringValue(data.id) ?? `event:${event.seq}`;
    const text = userContentText(data.content);
    if (!text) return [];
    return [timeline(this.paseoSessionId, { type: "user_message", id, messageId: id, text }, timestamp)];
  }

  private projectAssistantMessage(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const data = event.data;
    const message = objectValue(data.message) ?? data;
    const messageId = stringValue(message.id) ?? `event:${event.seq}`;
    const turn = numberValue(data.turn) ?? 0;
    const step = numberValue(data.step) ?? 0;
    const ordinal = this.settlementOrdinal(event.seq, turn, step);
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
        this.text.set(id, text);
        projected.push(
          timeline(
            this.paseoSessionId,
            itemType === "assistant_message"
              ? { type: itemType, id, messageId, text }
              : { type: itemType, id, text },
            timestamp,
          ),
        );
      } else if (type === "tool-call") {
        const callId = stringValue(block.id) ?? stringValue(block.toolCallId) ?? `${messageId}:${index}`;
        const name = stringValue(block.name) ?? "tool";
        const args = parseArguments(block.arguments);
        const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
          type: "tool_call",
          id: `tool:${callId}`,
          callId,
          name,
          status: "running",
          error: null,
          detail: toolDetail(name, args),
          metadata: { argumentsText: stringifyValue(block.arguments) },
        };
        this.tools.set(callId, item);
        projected.push(timeline(this.paseoSessionId, item, timestamp));
      }
    });
    const usage = objectValue(data.usage) ?? objectValue(message.usage);
    if (usage) {
      projected.push({
        type: "session.usage",
        sessionId: this.paseoSessionId,
        usage: {
          inputTokens: numberValue(usage.inputTokens) ?? numberValue(usage.input_tokens),
          cachedInputTokens:
            numberValue(usage.cachedInputTokens) ?? numberValue(usage.cached_input_tokens),
          outputTokens: numberValue(usage.outputTokens) ?? numberValue(usage.output_tokens),
          totalCostUsd: numberValue(usage.totalCostUsd) ?? numberValue(usage.total_cost_usd),
        },
      });
    }
    return projected;
  }

  private settlementOrdinal(seq: number, turn: number, step: number): number {
    const known = this.settlementOrdinals.get(seq);
    if (known !== undefined) return known;

    const key = stepKey(turn, step);
    const live = this.liveAttemptByStep.get(key);
    const ordinal = live?.ordinal ?? this.settledAttempts.get(key) ?? 0;
    this.settlementOrdinals.set(seq, ordinal);
    this.settledAttempts.set(key, Math.max(this.settledAttempts.get(key) ?? 0, ordinal + 1));
    if (live) {
      this.liveAttemptByStep.delete(key);
      this.liveAttempts.delete(live.attemptId);
    }
    return ordinal;
  }

  private projectToolCall(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const callId = stringValue(event.data.callId) ?? `event:${event.seq}`;
    const name = stringValue(event.data.name) ?? "tool";
    const args = parseArguments(event.data.arguments);
    const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
      type: "tool_call",
      id: `tool:${callId}`,
      callId,
      name,
      status: "running",
      error: null,
      detail: toolDetail(name, args),
      metadata: { argumentsText: stringifyValue(event.data.arguments) },
    };
    this.tools.set(callId, item);
    return [timeline(this.paseoSessionId, item, timestamp)];
  }

  private projectToolResult(event: DshSessionEvent, timestamp?: string): SessionEvent[] {
    const message = objectValue(event.data.message) ?? event.data;
    const direct = objectValue(message.content);
    const result = direct?.type === "tool-result"
      ? direct
      : arrayValue(message.content)
          .map(objectValue)
          .find((block) => block?.type === "tool-result");
    if (!result) return [];
    const callId = stringValue(result.toolCallId) ?? stringValue(result.tool_call_id);
    if (!callId) return [];
    const existing = this.tools.get(callId) ?? {
      type: "tool_call" as const,
      id: `tool:${callId}`,
      callId,
      name: "tool",
      status: "running" as const,
      error: null,
      detail: { type: "unknown" as const, input: {}, output: {} },
    };
    const output = contentText(result.content) || stringifyValue(result.content);
    const isError = result.isError === true || event.data.isError === true;
    const detail = withOutput(existing.detail, output);
    const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = isError
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

function toolDetail(name: string, args: JsonObject): ProviderToolCallDetail {
  const normalized = name.toLowerCase();
  if (/shell|bash|exec|command/u.test(normalized)) {
    return {
      type: "shell",
      command: stringValue(args.command) ?? stringValue(args.cmd) ?? stringifyValue(args),
      cwd: stringValue(args.cwd),
    };
  }
  const filePath = stringValue(args.filePath) ?? stringValue(args.path) ?? "";
  if (/read/u.test(normalized)) {
    return { type: "read", filePath, offset: numberValue(args.offset), limit: numberValue(args.limit) };
  }
  if (/edit|patch/u.test(normalized)) {
    return {
      type: "edit",
      filePath,
      oldString: stringValue(args.oldString) ?? stringValue(args.old_string),
      newString: stringValue(args.newString) ?? stringValue(args.new_string),
      unifiedDiff: stringValue(args.patch) ?? stringValue(args.diff),
    };
  }
  if (/write/u.test(normalized)) {
    return { type: "write", filePath, content: stringValue(args.content) };
  }
  if (/search|grep|glob/u.test(normalized)) {
    return { type: "search", query: stringValue(args.query) ?? stringValue(args.pattern) ?? "" };
  }
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
    case "plain_text":
      return { ...detail, text: output };
    case "unknown":
      return { ...detail, output };
    default:
      return detail;
  }
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
