import type { JobCheckpoint } from "./contracts.js";

export type FailureKind = NonNullable<JobCheckpoint["failure_kind"]>;

export class WorkflowError extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); }
}
