import type { JobCheckpoint } from "./contracts.js";

export type FailureKind = NonNullable<JobCheckpoint["failure_kind"]>;

export class WorkflowError extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); }
}

/** Only transport and temporary provider failures are safe to replay from a checkpoint. */
export function isRetryableProviderError(error: unknown): error is WorkflowError {
  if (!(error instanceof WorkflowError) || error.kind !== "provider") return false;
  const message = error.message;
  if (/insufficient[_ -]?quota|billing|payment|credit|invalid[_ -]?api[_ -]?key|unauthori[sz]ed|authentication|permission|context[_ -]?length/i.test(message)) return false;
  return /\b(?:429|500|502|503|504|520|522|524)\b|rate limit|temporar(?:y|ily)|overloaded|service unavailable|connection (?:error|reset|closed|refused|failed)|network error|fetch failed|socket hang up|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|timed? out|timeout/i.test(message);
}
