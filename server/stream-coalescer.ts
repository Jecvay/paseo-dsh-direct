import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { streamBlockPrefix } from "./timeline.js";

export const DEFAULT_STREAM_COALESCE_WINDOW_MS = 120;
export const DEFAULT_STREAM_COALESCE_MAX_BUFFER_CHARS = 65_536;

export interface StreamCoalescerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface StreamCoalescerOptions {
  windowMs?: number;
  maxBufferChars?: number;
  timers?: StreamCoalescerTimers;
  now?: () => number;
  onFlush: (key: string, event: ProviderEvent) => void;
}

export type StreamCoalesceConfig = Pick<StreamCoalescerOptions, "windowMs" | "timers" | "now">;

type TimelineEvent = Extract<ProviderEvent, { type: "timeline.item" }>;

interface CoalesceBucket {
  entries: TimelineEvent[];
  toolCallIndexes: Map<string, number>;
  bufferedTextChars: number;
  timer: unknown;
  lastFlushAt: number | null;
}

const DEFAULT_TIMERS: StreamCoalescerTimers = {
  setTimeout(callback, ms) {
    const timer = globalThis.setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout(timer) {
    globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

function isCoalescableItem(
  item: ProviderTimelineItem,
): item is Extract<ProviderTimelineItem, { type: "assistant_message" | "reasoning" | "tool_call" }> {
  return item.type === "assistant_message" || item.type === "reasoning" || item.type === "tool_call";
}

function canMergeTextItems(
  prev: TimelineEvent,
  next: TimelineEvent,
): prev is TimelineEvent & { item: Extract<ProviderTimelineItem, { type: "assistant_message" | "reasoning" }> } {
  if (prev.item.type !== next.item.type) return false;
  if (prev.item.type === "assistant_message" && next.item.type === "assistant_message") {
    return next.item.messageId !== undefined && prev.item.messageId === next.item.messageId;
  }
  if (prev.item.type === "reasoning" && next.item.type === "reasoning") {
    const prevPrefix = streamBlockPrefix(prev.item.id);
    const nextPrefix = streamBlockPrefix(next.item.id);
    return prevPrefix !== undefined && prevPrefix === nextPrefix;
  }
  return false;
}

/**
 * Buffers and coalesces high-frequency streaming `timeline.item` events per session key
 * using a leading-edge + fixed trailing window schedule.
 */
export class StreamCoalescer {
  private readonly windowMs: number;
  private readonly maxBufferChars: number;
  private readonly timers: StreamCoalescerTimers;
  private readonly now: () => number;
  private readonly onFlush: (key: string, event: ProviderEvent) => void;
  private readonly buckets = new Map<string, CoalesceBucket>();
  private disposed = false;

  constructor(options: StreamCoalescerOptions) {
    const rawWindow = options.windowMs;
    this.windowMs = rawWindow !== undefined && Number.isFinite(rawWindow)
      ? Math.max(0, rawWindow)
      : DEFAULT_STREAM_COALESCE_WINDOW_MS;
    const rawMax = options.maxBufferChars;
    this.maxBufferChars = rawMax !== undefined && Number.isFinite(rawMax)
      ? Math.max(1, rawMax)
      : DEFAULT_STREAM_COALESCE_MAX_BUFFER_CHARS;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.now = options.now ?? Date.now;
    this.onFlush = options.onFlush;
  }

  enqueue(key: string, event: ProviderEvent): void {
    if (this.disposed) return;
    if (event.type !== "timeline.item" || !isCoalescableItem(event.item)) {
      this.flush(key);
      if (!this.disposed) this.onFlush(key, event);
      return;
    }
    if (
      (event.item.type === "assistant_message" || event.item.type === "reasoning") &&
      event.item.text.length === 0
    ) {
      return;
    }

    const bucket = this.getOrCreateBucket(key);
    this.appendToBucket(bucket, event);

    const terminalToolCall = event.item.type === "tool_call" && event.item.status !== "running";
    if (terminalToolCall || bucket.bufferedTextChars >= this.maxBufferChars || this.windowMs === 0) {
      this.flush(key);
      return;
    }

    if (bucket.timer === null) {
      const remaining = bucket.lastFlushAt === null ? 0 : bucket.lastFlushAt + this.windowMs - this.now();
      if (remaining <= 0) {
        this.flush(key);
        return;
      }
      const delay = Math.min(this.windowMs, Math.max(1, remaining));
      bucket.timer = this.timers.setTimeout(() => {
        if (this.buckets.get(key) !== bucket) return;
        bucket.timer = null;
        this.flush(key);
      }, delay);
    }
  }

  flush(key: string): void {
    if (this.disposed) return;
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.clearTimer(bucket);
    if (bucket.entries.length === 0) return;

    const entries = bucket.entries;
    bucket.entries = [];
    bucket.toolCallIndexes.clear();
    bucket.bufferedTextChars = 0;
    bucket.lastFlushAt = this.now();

    for (const entry of entries) {
      if (this.disposed) break;
      this.onFlush(key, entry);
    }
  }

  discard(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.clearTimer(bucket);
    this.buckets.delete(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bucket of this.buckets.values()) {
      this.clearTimer(bucket);
    }
    this.buckets.clear();
  }

  private getOrCreateBucket(key: string): CoalesceBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        entries: [],
        toolCallIndexes: new Map(),
        bufferedTextChars: 0,
        timer: null,
        lastFlushAt: null,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private appendToBucket(bucket: CoalesceBucket, event: TimelineEvent): void {
    const item = event.item;
    if (item.type === "assistant_message" || item.type === "reasoning") {
      const prev = bucket.entries.at(-1);
      if (prev && canMergeTextItems(prev, event)) {
        const timestamp = event.timestamp ?? prev.timestamp;
        bucket.entries[bucket.entries.length - 1] = {
          ...prev,
          ...(timestamp ? { timestamp } : {}),
          item: {
            ...prev.item,
            text: prev.item.text + item.text,
          },
        };
      } else {
        bucket.entries.push(event);
      }
      bucket.bufferedTextChars += item.text.length;
      return;
    }

    const existingIndex = item.type === "tool_call" ? bucket.toolCallIndexes.get(item.callId) : undefined;
    if (item.type === "tool_call" && existingIndex !== undefined) {
      bucket.entries[existingIndex] = event;
    } else if (item.type === "tool_call") {
      bucket.toolCallIndexes.set(item.callId, bucket.entries.length);
      bucket.entries.push(event);
    }
  }

  private clearTimer(bucket: CoalesceBucket): void {
    if (bucket.timer === null) return;
    this.timers.clearTimeout(bucket.timer);
    bucket.timer = null;
  }
}
