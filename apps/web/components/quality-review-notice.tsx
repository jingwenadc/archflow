"use client";

import type { GenerationJobDetail } from "@/lib/job-contracts";
import { displayCitations } from "@/lib/source-citations";
import { useCitationSources } from "@/lib/use-citation-sources";

export function QualityReviewNotice({ job }: { job: GenerationJobDetail }) {
  const citations = useCitationSources(job.status === "needs_review" ? job.id : null);
  if (job.status !== "needs_review") return null;

  const findings = job.batches.filter(batch => batch.review && !batch.review.passed)
    .map(batch => ({ label: `第 ${batch.start_unit}–${batch.end_unit} ${job.module === "concept" ? "页" : "章"}`, review: batch.review! }));
  if (job.final_review && !job.final_review.passed) findings.push({ label: "整份成果", review: job.final_review });
  const issueCount = findings.reduce((total, finding) => total + finding.review.issues.length, 0);
  const show = (text: string) => displayCitations(text, citations?.sources ?? []);
  const unit = job.module === "concept" ? "页" : "章";

  return <section className="quality-notice" role="status" aria-label="自动审校结果">
    <strong>自动审校尚未通过，当前版本已暂停</strong>
    <p>已通过 {job.completed_units} / {job.target_units} {unit}。下面是系统发现的问题，不需要你逐条填写；未完成的版本不能当作完整成果交付。</p>
    <p>如需继续，请在下方“修改意见”写总体方向，或到右侧对具体文字添加批注，再统一提交。原版会保留。</p>
    {findings.length > 0 && <details><summary>查看审校详情{issueCount ? ` · ${issueCount} 条` : ""}</summary>
      {!citations ? <p>正在读取来源文件名…</p> : citations.error ? <p>来源文件名暂时无法读取，请稍后重试。</p> : findings.map(finding => <div key={finding.label} className="quality-finding"><strong>{finding.label}</strong><p>{show(finding.review.summary)}</p>{finding.review.issues.length > 0 && <ol>{finding.review.issues.map((issue, index) => <li key={index}>{show(issue)}</li>)}</ol>}</div>)}
    </details>}
  </section>;
}
