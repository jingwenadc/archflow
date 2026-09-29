import type { GenerationJobDetail } from "@/lib/job-contracts";
import { workflowState, workflowSteps } from "@/lib/workflow";

export function WorkflowProgress({ job }: { job: GenerationJobDetail }) {
  const state = workflowState(job);
  return <div className="workflow-progress">
    <ol aria-label="文档制作步骤">{workflowSteps.map((label, index) => <li key={label}
      className={index < state.index ? "done" : index === state.index ? "current" : ""}
      aria-current={index === state.index ? "step" : undefined}><span>{index < state.index ? "✓" : index + 1}</span>{label}</li>)}</ol>
    <p role="status">{state.label}</p>
    {["generating", "final_review"].includes(job.stage) && <p className="generation-note">{job.completed_units} / {job.target_units} {job.module === "concept" ? "页" : "章"}已通过内容审校</p>}
    {job.stage === "storyboarding" && <p className="generation-note">{job.storyboard_units} / {job.target_units} {job.module === "concept" ? "页" : "章"}已完成策划</p>}
  </div>;
}
