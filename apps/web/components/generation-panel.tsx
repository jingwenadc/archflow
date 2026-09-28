"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest, jobDownloadUrl } from "@/lib/api";
import type { ArtifactUnit, GenerationJobCreate, GenerationJobDetail, GenerationJobRecord } from "@/lib/job-contracts";

const statusLabels: Record<string, string> = {
  queued: "排队中", running: "执行中", waiting_outline: "请确认提纲", waiting_storyboard: "请确认逐页策划",
  needs_review: "需要人工复核", completed: "内容草稿完成", failed: "执行失败", cancelled: "已取消",
};
const stageLabels: Record<string, string> = { planning: "制定提纲", storyboarding: "逐页策划", generating: "分批生成与审校", final_review: "跨章节一致性审校" };

export function GenerationPanel({ projectId, conversationId, module }: { projectId: string; conversationId: string | null; module: "concept" | "bid" | "drawing" }) {
  const [enabled, setEnabled] = useState(false);
  const [goal, setGoal] = useState("");
  const [count, setCount] = useState(10);
  const [job, setJob] = useState<GenerationJobDetail | null>(null);
  const [recent, setRecent] = useState<GenerationJobRecord[]>([]);
  const [units, setUnits] = useState<ArtifactUnit[]>([]);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ key: string; body: GenerationJobCreate } | null>(null);
  const scope = useRef(0);
  const unitKind = job?.stage === "storyboarding" || job?.status === "waiting_storyboard" ? "storyboard" : "draft";

  useEffect(() => {
    const version = ++scope.current;
    setJob(null); setUnits([]); setRecent([]); setGoal(""); setPage(0); setError(null); setBusy(false); request.current = null;
    const query = new URLSearchParams({ project_id: projectId, ...(conversationId ? { conversation_id: conversationId } : {}) });
    Promise.all([
      apiRequest<{ generation: boolean }>("/api/v1/capabilities"),
      apiRequest<GenerationJobRecord[]>(`/api/v1/jobs?${query}`),
    ]).then(([capabilities, jobs]) => {
      if (scope.current !== version) return;
      setEnabled(capabilities.generation); setRecent(jobs.filter(item => item.module === module));
    }).catch(() => { if (scope.current === version) setEnabled(false); });
    return () => { scope.current++; };
  }, [projectId, conversationId, module]);

  useEffect(() => {
    if (!job) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = job.id;
    async function refresh() {
      try {
        const detail = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${id}`);
        const content = await apiRequest<ArtifactUnit[]>(`/api/v1/jobs/${id}/units?kind=${unitKind}&offset=${page * 5}&limit=5`);
        if (cancelled) return;
        setJob(detail); setUnits(content); setError(null);
        setRecent(items => items.map(item => item.id === id ? detail : item));
        if (["queued", "running"].includes(detail.status)) timer = setTimeout(refresh, 2000);
      } catch { if (!cancelled) { setError("任务状态暂时无法读取，正在重试。"); timer = setTimeout(refresh, 5000); } }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.id, job?.status, page, unitKind]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (busy || !goal.trim()) return;
    const version = scope.current;
    const body: GenerationJobCreate = { project_id: projectId, conversation_id: conversationId, module, goal: goal.trim(), target_units: count, batch_size: 5, max_revision_rounds: 2, max_model_calls: 1000, max_total_tokens: 1_000_000 };
    if (!request.current || JSON.stringify(request.current.body) !== JSON.stringify(body)) request.current = { key: crypto.randomUUID(), body };
    setBusy(true); setError(null);
    try {
      const created = await apiRequest<GenerationJobDetail>("/api/v1/jobs", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": request.current.key }, body: JSON.stringify(body) });
      if (scope.current !== version) return;
      request.current = null; setJob(created); setPage(0); setRecent(items => [created, ...items.filter(item => item.id !== created.id)]);
    } catch (cause) { if (scope.current === version) setError(cause instanceof Error ? cause.message : "任务创建失败"); }
    finally { if (scope.current === version) setBusy(false); }
  }

  async function control(action: "approve" | "cancel" | "retry") {
    if (!job || busy) return;
    const version = scope.current;
    setBusy(true); setError(null);
    try {
      const updated = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${job.id}/${action}`, { method: "POST" });
      if (scope.current === version) { setJob(updated); setPage(0); }
    } catch (cause) { if (scope.current === version) setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { if (scope.current === version) setBusy(false); }
  }

  if (module === "drawing") return <div className="generation-panel"><p>施工图协同暂未接入生成能力。</p></div>;
  const total = unitKind === "storyboard" ? job?.storyboard_units ?? 0 : job?.batches.filter(item => item.status !== "pending").reduce((sum, item) => sum + item.end_unit - item.start_unit + 1, 0) ?? 0;
  return <div className="generation-panel">
    <p className="generation-note">分批生成内容草稿 · 非最终 PPT / Word。当前仅使用下方项目文字；上传文件尚未接入解析。</p>
    <form onSubmit={start}>
      <label htmlFor="generation-goal">项目条件与目标</label>
      <textarea id="generation-goal" value={goal} onChange={event => setGoal(event.target.value)} maxLength={20000} rows={4} placeholder="填写已确认的条件、目标与缺失资料。不要只写上传文件名。" disabled={busy} required />
      <div className="generation-form-row"><label htmlFor="generation-count">{module === "concept" ? "页数" : "内容块数"}</label><input id="generation-count" type="number" min={1} max={500} value={count} onChange={event => setCount(Number(event.target.value))} required disabled={busy} /><button type="submit" disabled={!enabled || busy || !goal.trim() || ["queued", "running"].includes(job?.status ?? "")}>开始任务</button></div>
      <p className="generation-note">每批 5 个单元，最多修订 2 次。上限：1,000 次调用 / 100 万累计 tokens（含输入，非美元预算；最后一次可能超出）。</p>
      {!enabled && <p className="generation-note">需由管理员配置模型 endpoint 和 Worker 后启用。</p>}
    </form>
    {recent.length > 0 && <label className="generation-selector">历史任务<select value={job?.id ?? ""} disabled={busy} onChange={async event => {
      const version = scope.current; const id = event.target.value;
      if (!id) { setJob(null); setUnits([]); return; }
      setBusy(true);
      try { const detail = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${id}`); if (scope.current === version) { setJob(detail); setPage(0); } } catch { if (scope.current === version) setError("无法打开任务"); }
      finally { if (scope.current === version) setBusy(false); }
    }}><option value="">选择任务</option>{recent.map(item => <option key={item.id} value={item.id}>{item.goal.slice(0, 26)} · {statusLabels[item.status]}</option>)}</select></label>}
    {error && <p className="generation-error" role="alert">{error}</p>}
    {job && <section aria-label="生成任务进度">
      <div className="generation-status"><strong>{statusLabels[job.status]}</strong><span>{stageLabels[job.stage]}</span></div>
      <progress max={job.target_units} value={job.completed_units} aria-label="已通过审校的内容数量" />
      <p className="generation-note">已通过 {job.completed_units}/{job.target_units} · {job.model_calls} 次调用 · {job.total_tokens.toLocaleString()} tokens</p>
      {job.error && <p className="generation-error">{job.error}</p>}
      {job.outline && <details open={job.status === "waiting_outline"}><summary>章节提纲 · {job.outline.skill_slug}</summary><p>{job.outline.summary}</p><ol>{job.outline.sections.map(item => <li key={item.start_unit}><strong>{item.start_unit}–{item.end_unit} · {item.title}</strong><p>{item.objective}</p></li>)}</ol></details>}
      <div className="generation-actions">
        {["waiting_outline", "waiting_storyboard"].includes(job.status) && <button className="generation-approve" type="button" disabled={busy} onClick={() => void control("approve")}>{job.status === "waiting_outline" ? "确认提纲，继续逐页策划" : "确认全部逐页策划，开始生成"}</button>}
        {!["completed", "cancelled", "needs_review"].includes(job.status) && <button type="button" disabled={busy} onClick={() => void control("cancel")}>取消任务</button>}
        {job.status === "failed" && <button type="button" disabled={busy} onClick={() => void control("retry")}>从检查点重试</button>}
        {["completed", "needs_review", "failed", "cancelled"].includes(job.status) && <a href={jobDownloadUrl(job.id)}>下载 JSON 草稿</a>}
      </div>
      {job.status === "needs_review" && <p className="generation-note">自动修订已停止。请复核问题、补充条件后新建任务；已有草稿会保留。</p>}
      {job.batches.some(item => item.review && !item.review.passed) && <details open><summary>批次待解决问题</summary>{job.batches.filter(item => item.review && !item.review.passed).map(item => <p key={item.batch_index}>{item.start_unit}–{item.end_unit}：{item.review?.summary} {item.review?.issues.join("；")}</p>)}</details>}
      {job.final_review && <details open><summary>跨章节审校</summary><p>{job.final_review.summary}</p><ul>{job.final_review.issues.map(item => <li key={item}>{item}</li>)}</ul></details>}
      {units.map(unit => <article className="generation-unit" key={`${unitKind}-${unit.unit_index}`}><p className="eyebrow">{unitKind === "storyboard" ? "逐页策划" : "内容草稿"} · {unit.unit_index}</p><h3>{unit.title}</h3><p className="generation-body">{unit.body}</p>{unit.missing_facts.length > 0 && <p className="generation-error">待补资料：{unit.missing_facts.join("；")}</p>}</article>)}
      {total > 0 && <div className="generation-actions"><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一组</button><span>{page * 5 + 1}–{Math.min(total, (page + 1) * 5)} / {total}</span><button type="button" disabled={(page + 1) * 5 >= total} onClick={() => setPage(value => value + 1)}>下一组</button></div>}
    </section>}
  </div>;
}
