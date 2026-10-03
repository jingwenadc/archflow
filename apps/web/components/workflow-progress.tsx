import type { GenerationJobDetail } from "@/lib/job-contracts";
import { workflowState, workflowSteps } from "@/lib/workflow";
import { LoadingIcon } from "./icons";

export function WorkflowProgress({ job }: { job: GenerationJobDetail }) {
  const state = workflowState(job);
  return <div className="workflow-progress">
    <ol aria-label="文档制作步骤">{workflowSteps(job.module).map((label, index) => <li key={label}
      className={index < state.index ? "done" : index === state.index ? "current" : ""}
      aria-current={index === state.index ? "step" : undefined}><span>{index < state.index ? "✓" : index + 1}</span>{label}</li>)}</ol>
    <p className={`workflow-activity${state.working ? " is-working" : ""}`} role="status" aria-atomic="true">
      {state.working && <LoadingIcon className="loading-icon" />}<span>{state.label}</span>
    </p>
    {state.saved && <p className="generation-note">{state.saved}</p>}
  </div>;
}
