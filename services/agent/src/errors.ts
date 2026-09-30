import type { JobCheckpoint } from "./contracts.js";

export type FailureKind = NonNullable<JobCheckpoint["failure_kind"]>;

export class WorkflowError extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); }
}

/** Bounded, content-free error label for downloadable diagnostics. Full provider detail is admin-only. */
export function diagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/(?:^|:\s*)terminated$/i.test(message.trim())) return "stream_terminated";
  if (/timed? out|timeout|ETIMEDOUT|AbortError/i.test(message)) return "timeout";
  if (/ECONNRESET|socket hang up|connection reset/i.test(message)) return "connection_reset";
  if (/connection|network error|fetch failed|EAI_AGAIN|ECONNREFUSED/i.test(message)) return "connection_error";
  if (/\b429\b|rate limit/i.test(message)) return "rate_limited";
  const status = /\b(5\d\d|4\d\d)\b/.exec(message);
  if (status) return `http_${status[1]}`;
  return error instanceof WorkflowError ? `${error.kind}_error` : "unexpected_error";
}

/** Only transport and temporary provider failures are safe to replay from a checkpoint. */
export function isRetryableProviderError(error: unknown): error is WorkflowError {
  if (!(error instanceof WorkflowError) || error.kind !== "provider") return false;
  const message = error.message;
  if (/insufficient[_ -]?quota|billing|payment|credit|invalid[_ -]?api[_ -]?key|unauthori[sz]ed|authentication|permission|context[_ -]?length/i.test(message)) return false;
  return /(?:^|:\s*)terminated$/i.test(message.trim()) || /\b(?:429|500|502|503|504|520|522|524)\b|rate limit|temporar(?:y|ily)|overloaded|service unavailable|connection (?:error|reset|closed|refused|failed)|network error|fetch failed|socket hang up|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|timed? out|timeout/i.test(message);
}
