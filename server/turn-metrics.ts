import type { ProviderMetric } from "@getpaseo/plugin/server/provider";

/** A cache hit at or above this share reads as healthy; Paseo only colors the value. */
const CACHE_HIT_OK_PERCENT = 50;

/** DSH's disjoint token buckets. Cache reads and writes are not part of input. */
export interface TokenCounts {
  /** Uncached prompt tokens. */
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
}

export interface MeasuredTurn extends TokenCounts {
  model?: string;
  elapsedMs?: number;
}

export interface MeasuredSession extends TokenCounts {
  turns: number;
}

function isCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Paseo shows this string verbatim, so keep it readable at a glance. */
export function formatElapsed(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds < 50) return "<0.1s";
  const tenths = Math.round(milliseconds / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  const count = Math.round(tokens);
  if (count < 1000) return String(count);
  const tenthsOfThousands = Math.round(count / 100);
  if (tenthsOfThousands < 10_000) return `${(tenthsOfThousands / 10).toFixed(1)}K`;
  return `${(Math.round(count / 100_000) / 10).toFixed(1)}M`;
}

function tokenPair(counts: TokenCounts): ProviderMetric[] {
  const { inputTokens, outputTokens } = counts;
  if (!isCount(inputTokens) || !isCount(outputTokens)) return [];
  if (inputTokens + outputTokens <= 0) return [];
  return [
    {
      label: "Tokens",
      value: `${formatTokens(inputTokens)} ↑ · ${formatTokens(outputTokens)} ↓`,
    },
  ];
}

/**
 * The share of prompt tokens served from cache. DSH reports uncached input and
 * cache reads/writes as disjoint buckets, so their sum is the prompt size. A
 * missing bucket would shrink the denominator and inflate the result, so the
 * whole row is omitted instead.
 */
export function cacheHitPercent(counts: TokenCounts): number | undefined {
  const { inputTokens, cachedInputTokens, cacheWriteTokens } = counts;
  if (!isCount(inputTokens) || !isCount(cachedInputTokens) || !isCount(cacheWriteTokens)) {
    return undefined;
  }
  const prompt = inputTokens + cachedInputTokens + cacheWriteTokens;
  return prompt > 0 ? Math.round((cachedInputTokens / prompt) * 100) : undefined;
}

function cacheMetric(counts: TokenCounts): ProviderMetric[] {
  const percent = cacheHitPercent(counts);
  if (percent === undefined) return [];
  return [
    {
      label: "Cache",
      value: `${percent}%`,
      ...(percent >= CACHE_HIT_OK_PERCENT ? { tone: "ok" as const } : {}),
    },
  ];
}

/** Metrics shown in a completed turn's footer; empty rows are left out. */
export function turnMetrics(turn: MeasuredTurn): ProviderMetric[] {
  const elapsed = turn.elapsedMs === undefined ? undefined : formatElapsed(turn.elapsedMs);
  return [
    ...(turn.model ? [{ label: "Model", value: turn.model }] : []),
    ...(elapsed ? [{ label: "Elapsed", value: elapsed }] : []),
    ...tokenPair(turn),
    ...cacheMetric(turn),
  ];
}

/** Metrics shown in the session's context details; each report replaces the last. */
export function sessionMetrics(session: MeasuredSession): ProviderMetric[] {
  return [
    { label: "Turns", value: String(session.turns) },
    ...tokenPair(session),
    ...cacheMetric(session),
  ];
}
