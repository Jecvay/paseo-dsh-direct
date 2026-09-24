import type { ProviderError } from "@getpaseo/plugin/server/provider";
import { numberValue, objectValue, stringValue } from "./values.js";

export type TurnState = "completed" | "failed" | "canceled";
export interface TurnTerminal {
  state: TurnState;
  error?: ProviderError;
  /** Notice for turns that completed abnormally. */
  warning?: string;
}

const WARNINGS: Record<string, string> = {
  "max-tokens": "The model reached its output token limit in this turn; the reply may be incomplete.",
  blocked: "A DSH plugin blocked this turn before the model ran.",
  interrupted: "This turn did not finish: the DSH process stopped before it ended.",
};

/** Classify DSH `turn/end` data; failures carry DSH's LlmFailure (message, code, status, request id). */
export function classifyTurnEnd(data: Record<string, unknown>): TurnTerminal {
  const reason = objectValue(data.reason);
  const kind = stringValue(reason?.kind) ?? "";
  if (kind === "aborted" || kind === "canceled" || kind === "cancelled") return { state: "canceled" };
  if (kind === "error" || kind === "failed") return { state: "failed", error: failure(objectValue(reason?.error)) };
  return WARNINGS[kind] ? { state: "completed", warning: WARNINGS[kind] } : { state: "completed" };
}

function failure(error: Record<string, unknown> | undefined): ProviderError {
  const message = stringValue(error?.message)?.trim() ? String(error?.message) : "DSH turn failed";
  const code = stringValue(error?.code);
  const status = numberValue(error?.status);
  const requestId = stringValue(error?.requestId);
  const diagnostic = [
    status !== undefined ? `HTTP ${status}` : undefined,
    requestId ? `request ${requestId}` : undefined,
  ].filter(Boolean).join(", ");
  return {
    message: code ? `[${code}] ${message}` : message,
    ...(code ? { code } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}
