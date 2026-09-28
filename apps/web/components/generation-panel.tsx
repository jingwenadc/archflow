"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiRequest, jobDownloadUrl, type Message } from "@/lib/api";
import type { ArtifactUnit, GenerationJobCreate, GenerationJobDetail, GenerationJobRecord } from "@/lib/job-contracts";

type ExportState = { status: string; requested: boolean; error: string | null; result: { page_count: number; format: string; missing_facts: number } | null };
const statuses: Record<string, string> = { queued: "排队中", running: "正在处理资料与生成内容", waiting_outline: "提纲已准备好，等待你确认", waiting_storyboard: "逐页策划已准备好，等待你确认", needs_review: "内容有待确认项，请复核", completed: "内容审校完成", failed: "任务失败，可从检查点重试", cancelled: "任务已取消" };
const active = (job: GenerationJobDetail | null) => !!job && ["queued", "running", "waiting_outline", "waiting_storyboard"].includes(job.status);
const url = (path: string) => `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}${path}`;

export function GenerationPanel({ projectId, conversationId, module, messages, outputMount, onOutputAvailable, materialsReady }: {
  projectId: string; conversationId: string | null; module: "concept" | "bid" | "drawing"; messages: Message[];
  outputMount: HTMLElement | null; onOutputAvailable: () => void; materialsReady: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [goal, setGoal] = useState("");
  const [count, setCount] = useState(10);
  const [job, setJob] = useState<GenerationJobDetail | null>(null);
  const [recent, setRecent] = useState<GenerationJobRecord[]>([]);
  const [units, setUnits] = useState<ArtifactUnit[]>([]);
  const [exported, setExported] = useState<ExportState | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [revisionRange, setRevisionRange] = useState("1");
  const [editing, setEditing] = useState(false);
  const [tokenBudget, setTokenBudget] = useState(250000);
  const scope = useRef(0);
  const requestKey = useRef<string | null>(null);
  const lastUsers = useRef("");
  const users = messages.filter(message => message.role === "user");
  const brief = users.map(message => message.content).join("\n补充要求：").slice(-20000);
  const latest = users.at(-1)?.content ?? "";
  const kind = job?.stage === "storyboarding" || job?.status === "waiting_storyboard" ? "storyboard" : "draft";
  const hasOutput = !!job?.outline;

  useEffect(() => {
    const version = ++scope.current;
    setJob(null); setUnits([]); setRecent([]); setGoal(""); setPage(0); setError(null); setBusy(false); setExported(null); setEditing(false);
    setConnectionError(null);
    lastUsers.current = ""; requestKey.current = null;
    if (!conversationId) return;
    const query = new URLSearchParams({ project_id: projectId, conversation_id: conversationId });
    Promise.all([apiRequest<{ generation: boolean }>("/api/v1/capabilities"), apiRequest<GenerationJobRecord[]>(`/api/v1/jobs?${query}`)])
      .then(async ([capability, jobs]) => {
        if (scope.current !== version) return;
        setEnabled(capability.generation); setRecent(jobs.filter(item => item.module === module));
        if (jobs[0]) { const detail = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${jobs[0].id}`); if (scope.current === version) setJob(detail); }
      }).catch(cause => { if (scope.current === version) setError(cause instanceof Error ? cause.message : "服务暂时无法连接，请刷新重试。"); });
    return () => { scope.current++; };
  }, [projectId, conversationId, module]);

  useEffect(() => {
    if (!brief || brief === lastUsers.current) return;
    lastUsers.current = brief;
    setGoal(brief); requestKey.current = null;
    const match = latest.match(/(\d{1,3})\s*页/);
    if (match) setCount(Math.min(500, Math.max(1, Number(match[1]))));
    const range = latest.match(/第?\s*(\d{1,3})\s*(?:[-–到至]\s*(\d{1,3}))?\s*页/);
    if (range) setRevisionRange(range[2] ? `${range[1]}-${range[2]}` : range[1]);
  }, [brief, latest, conversationId]);

  useEffect(() => { if (hasOutput) onOutputAvailable(); }, [job?.id, hasOutput]);

  useEffect(() => {
    if (!job) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = job.id;
    async function refresh() {
      try {
        const [detail, content, result] = await Promise.all([
          apiRequest<GenerationJobDetail>(`/api/v1/jobs/${id}`),
          apiRequest<ArtifactUnit[]>(`/api/v1/jobs/${id}/units?kind=${kind}&offset=${page * 5}&limit=5`),
          apiRequest<ExportState>(`/api/v1/jobs/${id}/export`),
        ]);
        if (cancelled) return;
        setJob(detail); setUnits(content); setExported(result);
        setConnectionError(null);
        if (["queued", "running"].includes(detail.status) || (result.requested && ["queued", "processing"].includes(result.status))) timer = setTimeout(refresh, 2000);
      } catch (cause) { if (!cancelled) { setConnectionError(cause instanceof Error ? cause.message : "暂时无法读取进度，正在重试。"); timer = setTimeout(refresh, 5000); } }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.id, job?.status, page, kind, exported?.status]);

  useEffect(() => { if (exported?.status === "ready") setPage(0); }, [job?.id, exported?.status]);

  async function perform(path: string, body: unknown = {}) {
    if (busy) return false;
    const version = scope.current;
    setBusy(true); setError(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const created = await apiRequest<GenerationJobDetail>(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey.current }, body: JSON.stringify(body) });
      if (scope.current !== version) return false;
      if (created.id !== job?.id) { setUnits([]); setExported(null); }
      setJob(created); setPage(0); setRecent(items => [created, ...items.filter(item => item.id !== created.id)]); requestKey.current = null;
      return true;
    } catch (cause) { if (scope.current === version) setError(cause instanceof Error ? cause.message : "操作失败"); return false; }
    finally { if (scope.current === version) setBusy(false); }
  }

  function start() {
    if (!conversationId || !goal.trim()) return;
    const body: GenerationJobCreate = { project_id: projectId, conversation_id: conversationId, module, goal: goal.trim(), target_units: count, batch_size: 5, max_revision_rounds: 2, max_model_calls: 400, max_total_tokens: tokenBudget };
    void perform("/api/v1/jobs", body);
  }

  function revise() {
    if (!job) return;
    const range = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(revisionRange.trim());
    if (!range) { setError("修改范围请填写 3 或 3-5。"); return; }
    const start = Number(range[1]), end = Number(range[2] ?? range[1]);
    if (start < 1 || end < start || end > job.target_units) { setError("修改范围超出当前文档。"); return; }
    void perform(`/api/v1/jobs/${job.id}/revise`, { instruction: latest, units: Array.from({ length: end-start+1 }, (_, index) => start+index) });
  }

  async function replan() {
    const version = scope.current;
    if (job && active(job) && !await perform(`/api/v1/jobs/${job.id}/cancel`)) return;
    if (scope.current === version) start();
  }

  // A deliberately edited summary need not quote the original message verbatim.
  const hasNewRequest = !!latest && (!job || Date.parse(users.at(-1)!.created_at) > Date.parse(job.created_at));
  const output = <div className="generation-panel output-only">
    {!hasOutput && <p className="generation-note">提纲与成果会显示在这里。请从中间的项目对话开始。</p>}
    {job?.outline && <details open={!exported?.result}><summary>章节提纲</summary><p>{job.outline.summary}</p><ol>{job.outline.sections.map(section => <li key={section.start_unit}><strong>{section.start_unit}–{section.end_unit} · {section.title}</strong><p>{section.objective}</p></li>)}</ol></details>}
    {exported?.requested && ["queued", "processing"].includes(exported.status) && <p role="status">正在排版和渲染可编辑文件…</p>}
    {exported?.status === "failed" && <div role="alert"><p>{exported.error}</p><button onClick={async () => { if (!job) return; try { await apiRequest(`/api/v1/jobs/${job.id}/export/retry`, { method: "POST" }); setExported({ ...exported, status: "queued" }); } catch { setError("排版重试失败，请稍后再试。"); } }}>重试排版</button></div>}
    {exported?.status === "ready" && exported.result && job && <>
      <div className="generation-actions"><a href={url(`/api/v1/jobs/${job.id}/export/${exported.result.format}`)}>下载 {exported.result.format.toUpperCase()}</a><a href={url(`/api/v1/jobs/${job.id}/export/pdf`)}>下载 PDF</a></div>
      <p className="generation-note">{exported.result.page_count} 页 · 可编辑审阅版{exported.result.missing_facts ? ` · ${exported.result.missing_facts} 项资料待补充` : ""}</p>
      <img className="artifact-page" src={url(`/api/v1/jobs/${job.id}/preview/${Math.min(page+1, exported.result.page_count)}`)} alt={`文档第 ${page+1} 页`} loading="lazy" />
      <div className="generation-actions"><button disabled={page === 0} onClick={() => setPage(value => value-1)}>上一页</button><span>{page+1} / {exported.result.page_count}</span><button disabled={page+1 >= exported.result.page_count} onClick={() => setPage(value => value+1)}>下一页</button></div>
    </>}
    {exported?.status !== "ready" && units.map(unit => <article className="generation-unit" key={unit.unit_index}><p className="eyebrow">{kind === "storyboard" ? "逐页策划" : "内容草稿"} · {unit.unit_index}</p><h3>{unit.title}</h3><p className="generation-body">{unit.body}</p>{unit.missing_facts.length > 0 && <p className="generation-error">待确认：{unit.missing_facts.join("；")}</p>}</article>)}
    {exported?.status !== "ready" && units.length > 0 && <div className="generation-actions"><button disabled={page === 0} onClick={() => setPage(value => value-1)}>上一组</button><span>第 {page*5+1} 页起</span><button disabled={(page+1)*5 >= (kind === "storyboard" ? job?.storyboard_units ?? 0 : job?.target_units ?? 0)} onClick={() => setPage(value => value+1)}>下一组</button></div>}
  </div>;

  if (module === "drawing") return null;
  return <>
    {outputMount && createPortal(output, outputMount)}
    {error && <p className="generation-error workflow-card" role="alert">{error}</p>}
    {connectionError && <p className="generation-error workflow-card" role="status">暂时无法读取最新进度，正在自动重试。{connectionError}</p>}
    {!!brief && (!job || hasNewRequest || editing) && !["queued", "running"].includes(job?.status ?? "") && <section className="workflow-card" aria-label="需求确认">
      <h3>{job ? "确认补充要求" : "确认这次需求"}</h3>
      <p>{job ? latest : goal}</p>
      {(!job || ["waiting_outline", "waiting_storyboard", "cancelled", "failed"].includes(job.status)) && <>
        <button className="text-button" onClick={() => setEditing(value => !value)}>{editing ? "收起编辑" : "编辑需求摘要"}</button>
        {editing && <textarea aria-label="需求摘要" rows={4} value={goal} onChange={event => { setGoal(event.target.value); requestKey.current = null; }} />}
        <label>{module === "concept" ? "预计页数" : "内容章节数"}<input type="number" min={1} max={500} value={count} onChange={event => { setCount(Number(event.target.value)); requestKey.current = null; }} /></label>
        <details><summary>运行上限与费用控制</summary><label>累计 token 上限<input type="number" min={1000} max={10000000} value={tokenBudget} onChange={event => { setTokenBudget(Number(event.target.value)); requestKey.current = null; }} /></label><p>含输入和输出，非美元预算。最多 400 次调用；达到上限会停止并保留检查点，不会自动提高预算。单次已启动的请求可能使 token 总量超出上限。</p></details>
        <p className="generation-note">本次上限：{tokenBudget.toLocaleString()} 累计 tokens。长文档或复杂参考资料可能需要批准追加上限。</p>
        <button disabled={busy || !enabled || !materialsReady || !goal.trim()} onClick={() => void replan()}>{busy ? "正在创建任务…" : job ? "按补充要求重新整理提纲" : "确认需求，整理提纲"}</button>
      </>}
      {job && ["completed", "needs_review"].includes(job.status) && <><label>修改页码 / 内容单元<input value={revisionRange} onChange={event => { setRevisionRange(event.target.value); requestKey.current = null; }} placeholder="例如 3-5" /></label><button disabled={busy || !enabled} onClick={revise}>{busy ? "正在创建版本…" : "确认范围，生成新版本"}</button><button disabled={busy || !enabled || !materialsReady} onClick={start}>不沿用当前成果，重新整理提纲</button></>}
      {!enabled && <p>模型服务尚未启用，需求已保存。管理员配置后可以继续。</p>}
      {!materialsReady && <p>项目资料仍在解析，或有文件失败。请在左侧等待、重试或排除失败文件。</p>}
    </section>}
    {job && <section className="workflow-card" aria-label="任务状态" aria-live="polite">
      <strong>{statuses[job.status]}</strong>
      <progress max={job.target_units} value={job.completed_units} aria-label="已审校内容进度" />
      <p>{job.completed_units} / {job.target_units} 个内容单元已通过文字审校。你可以离开此对话，任务会继续保存。</p>
      {job.error && <p role="alert">{job.error}</p>}
      <div className="generation-actions">
        {["waiting_outline", "waiting_storyboard"].includes(job.status) && <button disabled={busy || hasNewRequest} onClick={() => void perform(`/api/v1/jobs/${job.id}/approve`)}>{job.status === "waiting_outline" ? "批准提纲，继续逐页策划" : "批准逐页策划并授权生成全部页面"}</button>}
        {active(job) && <button disabled={busy} onClick={() => void perform(`/api/v1/jobs/${job.id}/cancel`)}>取消任务</button>}
        {job.status === "failed" && <button disabled={busy} onClick={() => void perform(`/api/v1/jobs/${job.id}/retry`)}>从检查点重试</button>}
      </div>
      {job.batches.filter(batch => batch.review && !batch.review.passed).map(batch => <p className="generation-error" key={batch.batch_index}>{batch.review?.summary} {batch.review?.issues.join("；")}</p>)}
      {job.final_review && !job.final_review.passed && <p className="generation-error">{job.final_review.summary} {job.final_review.issues.join("；")}</p>}
      {["completed", "needs_review"].includes(job.status) && !exported?.requested && <button onClick={async () => { try { setExported(await apiRequest(`/api/v1/jobs/${job.id}/export`, { method: "POST" })); } catch (cause) { setError(cause instanceof Error ? cause.message : "导出失败"); } }}>排版为可编辑审阅文件</button>}
      <details><summary>运行详情与诊断草稿</summary><p>{job.model_calls} 次模型调用 · {job.total_tokens.toLocaleString()} tokens</p><a href={jobDownloadUrl(job.id)}>下载 JSON 诊断草稿</a></details>
      {job.status === "failed" && <details><summary>调整总上限并从检查点继续</summary><label>累计 token 上限<input type="number" min={job.total_tokens+1} max={10000000} value={tokenBudget} onChange={event => setTokenBudget(Number(event.target.value))} /></label><p>这是新的总上限，不是额外赠送额度；将继续产生模型费用。</p><button disabled={busy || tokenBudget <= job.total_tokens} onClick={() => void perform(`/api/v1/jobs/${job.id}/continue`, { max_model_calls: Math.min(1000, Math.max(job.max_model_calls, job.model_calls+100)), max_total_tokens: tokenBudget })}>批准新上限并继续</button></details>}
    </section>}
    {recent.length > 1 && <label className="workflow-card">成果版本<select value={job?.id ?? ""} onChange={async event => { const version = scope.current; try { const detail = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${event.target.value}`); if (scope.current === version) { setJob(detail); setUnits([]); setExported(null); setPage(0); } } catch { setError("版本无法读取，请重试。"); } }}>{recent.map((item, index) => <option key={item.id} value={item.id}>版本 {recent.length-index} · {statuses[item.status]}</option>)}</select></label>}
  </>;
}
