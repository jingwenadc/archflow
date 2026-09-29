"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiRequest, jobDownloadUrl, type Message } from "@/lib/api";
import type { GenerationJobCreate, GenerationJobDetail, GenerationJobRecord } from "@/lib/job-contracts";
import { conversationTimeline, failureHelp, isActiveJob, jobStatuses, orderedJobs, requestedUnitCount, requirementBrief } from "@/lib/workflow";
import { ConversationMessage } from "./conversation-message";
import { OutputPreview } from "./output-preview";
import { WorkflowProgress } from "./workflow-progress";

export function GenerationPanel({ projectId, conversationId, module, messages, outputMount, onOutputAvailable, materialsReady, ready, sendingMessage }: {
  projectId: string; conversationId: string | null; module: "concept" | "bid" | "drawing"; messages: Message[];
  outputMount: HTMLElement | null; onOutputAvailable: () => void; materialsReady: boolean; ready: boolean; sendingMessage: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [goal, setGoal] = useState("");
  const [count, setCount] = useState(10);
  const [job, setJob] = useState<GenerationJobDetail | null>(null);
  const [jobs, setJobs] = useState<GenerationJobRecord[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [revisionRange, setRevisionRange] = useState("1");
  const [tokenBudget, setTokenBudget] = useState(250000);
  const scope = useRef(0);
  const performing = useRef(false);
  const requestKey = useRef<string | null>(null);
  const lastUsers = useRef("");
  const brief = requirementBrief(messages, job);
  const latestUser = messages.filter(message => message.role === "user").at(-1);
  const latest = latestUser?.content ?? "";
  const previewKey = `archflow.preview:${projectId}:${module}:${conversationId}`;
  const versions = orderedJobs(jobs);
  const hasNewRequest = !!latestUser && (!job || Date.parse(latestUser.created_at) > Date.parse(job.created_at));
  const generating = !!job && ["queued", "running"].includes(job.status);
  const planningLabel = module === "concept" ? "逐页策划" : "逐章策划";

  function remember(next: GenerationJobDetail) {
    setJob(next);
    setJobs(items => [next, ...items.filter(item => item.id !== next.id)]);
  }

  function selectPreview(id: string) {
    setPreviewId(id);
    try { localStorage.setItem(previewKey, id); } catch { /* Preview works without browser storage. */ }
  }

  useEffect(() => {
    const version = ++scope.current;
    if (!conversationId || module === "drawing") { setLoading(false); return; }
    const query = new URLSearchParams({ project_id: projectId, conversation_id: conversationId });
    Promise.all([apiRequest<{ generation: boolean }>("/api/v1/capabilities"), apiRequest<GenerationJobRecord[]>(`/api/v1/jobs?${query}`)])
      .then(async ([capability, records]) => {
        if (scope.current !== version) return;
        const matching = records.filter(item => item.module === module);
        const newest = orderedJobs(matching).at(-1);
        setEnabled(capability.generation); setJobs(matching);
        let saved: string | null = null;
        try { saved = localStorage.getItem(previewKey); } catch { /* Optional preference. */ }
        const selected = matching.some(item => item.id === saved) ? saved : newest?.id ?? null;
        setPreviewId(selected);
        try { if (selected) localStorage.setItem(previewKey, selected); } catch { /* Optional preference. */ }
        if (newest) {
          const detail = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${newest.id}`);
          if (scope.current === version) remember(detail);
        }
      }).catch(cause => { if (scope.current === version) setError(cause instanceof Error ? cause.message : "服务暂时无法连接，请刷新重试。"); })
      .finally(() => { if (scope.current === version) setLoading(false); });
    return () => { scope.current++; };
  }, [projectId, conversationId, module]);

  useEffect(() => {
    if (loading || !ready || !brief || brief === lastUsers.current) return;
    lastUsers.current = brief; requestKey.current = null; setGoal(brief);
    const requested = [...messages].reverse().filter(message => message.role === "user" && (!job || Date.parse(message.created_at) > Date.parse(job.created_at)))
      .map(message => requestedUnitCount(message.content, module)).find(value => value !== undefined);
    setCount(requested ?? job?.target_units ?? 10);
    const range = latest.match(module === "bid" ? /第\s*(\d{1,3})\s*(?:[-–到至]\s*(\d{1,3}))?\s*章/ : /第\s*(\d{1,3})\s*(?:[-–到至]\s*(\d{1,3}))?\s*页/);
    if (range) setRevisionRange(range[2] ? `${range[1]}-${range[2]}` : range[1]);
  }, [brief, latest, loading, ready]);

  useEffect(() => {
    if (!job || !generating) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = job.id;
    async function refresh() {
      try {
        const next = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${id}`);
        if (cancelled) return;
        remember(next); setConnectionError(null);
        if (["queued", "running"].includes(next.status)) timer = setTimeout(refresh, 2000);
      } catch (cause) { if (!cancelled) { setConnectionError(cause instanceof Error ? cause.message : "暂时无法读取进度，正在重试。"); timer = setTimeout(refresh, 5000); } }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.id, generating]);

  async function perform(path: string, body: unknown = {}) {
    if (performing.current) return null;
    const version = scope.current;
    performing.current = true; setBusy(true); setError(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const created = await apiRequest<GenerationJobDetail>(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey.current }, body: JSON.stringify(body) });
      if (scope.current !== version) return null;
      remember(created); requestKey.current = null;
      if (!previewId) selectPreview(created.id);
      return created;
    } catch (cause) { if (scope.current === version) setError(cause instanceof Error ? cause.message : "操作失败"); return null; }
    finally { performing.current = false; if (scope.current === version) setBusy(false); }
  }

  async function start() {
    if (!conversationId || !goal.trim()) return;
    const version = scope.current;
    if (isActiveJob(job) && !await perform(`/api/v1/jobs/${job!.id}/cancel`)) return;
    if (scope.current !== version) return;
    const body: GenerationJobCreate = { project_id: projectId, conversation_id: conversationId, module, goal: goal.trim(), target_units: count, batch_size: 5, max_revision_rounds: 2, max_model_calls: 400, max_total_tokens: tokenBudget };
    await perform("/api/v1/jobs", body);
  }

  function revise() {
    if (!job) return;
    const range = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(revisionRange.trim());
    if (!range) { setError("修改范围请填写 3 或 3-5。"); return; }
    const start = Number(range[1]), end = Number(range[2] ?? range[1]);
    if (start < 1 || end < start || end > job.target_units) { setError("修改范围超出当前文档。"); return; }
    const instruction = goal.startsWith(job.goal) ? goal.slice(job.goal.length).trim() : goal.trim();
    if (!instruction || instruction.length > 4000) { setError("局部修改要求请控制在 4,000 字以内，或选择重新整理提纲。"); return; }
    void perform(`/api/v1/jobs/${job.id}/revise`, { instruction, units: Array.from({ length: end - start + 1 }, (_, index) => start + index), max_model_calls: 400, max_total_tokens: tokenBudget });
  }

  function confirmedCard(record: GenerationJobRecord, version: number) {
    const current = record.id === job?.id;
    const failure = failureHelp(record);
    return <section className="workflow-card confirmed-requirement" aria-label={`已确认需求 V${version}`} data-job-id={record.id}>
      <div className="requirement-card-heading"><h3>已确认需求 · V{version}</h3><button className="text-button" onClick={() => { selectPreview(record.id); onOutputAvailable(); }}>查看 V{version} 成果</button></div>
      <p className="requirement-summary">{record.goal.length > 300 ? `${record.goal.slice(0, 300)}…` : record.goal}</p>
      <p className="generation-note">{record.target_units} {module === "concept" ? "页" : "章"}{!current && ` · ${jobStatuses[record.status]}`}</p>
      <details><summary>查看完整需求</summary><p>{record.goal}</p></details>
      {current && job && <div className="workflow-task" aria-label={`V${version} 任务状态`} aria-live="polite">
        <WorkflowProgress job={job} />
        {hasNewRequest && !generating && <p className="generation-note">已收到新需求，请确认下方新版本；本版需求与成果保留。</p>}
        {job.status === "failed" && <p role="alert">{failure.message}</p>}
        <div className="generation-actions">
          {!hasNewRequest && ["waiting_outline", "waiting_storyboard"].includes(job.status) && <button disabled={busy} onClick={() => void perform(`/api/v1/jobs/${job.id}/approve`)}>{job.status === "waiting_outline" ? `批准 V${version} 提纲，继续${planningLabel}` : `批准 V${version} ${planningLabel}并授权生成全部内容`}</button>}
          {isActiveJob(job) && <button disabled={busy} onClick={() => void perform(`/api/v1/jobs/${job.id}/cancel`)}>取消任务</button>}
          {!hasNewRequest && job.status === "failed" && failure.kind !== "budget" && <button disabled={busy} onClick={() => void perform(`/api/v1/jobs/${job.id}/retry`)}>{failure.retry}</button>}
        </div>
        {job.batches.filter(batch => batch.review && !batch.review.passed).map(batch => <p className="generation-error" key={batch.batch_index}>{batch.review?.summary} {batch.review?.issues.join("；")}</p>)}
        {job.final_review && !job.final_review.passed && <p className="generation-error">{job.final_review.summary} {job.final_review.issues.join("；")}</p>}
        <details><summary>技术诊断与用量</summary>{job.error && <p>{job.error}</p>}<p>{job.model_calls} / {job.max_model_calls} 次调用 · {job.total_tokens.toLocaleString()} / {job.max_total_tokens.toLocaleString()} 累计 tokens</p>{["completed", "needs_review", "failed", "cancelled"].includes(job.status) && <a href={jobDownloadUrl(job.id)}>下载诊断数据（JSON）</a>}</details>
        {!hasNewRequest && job.status === "failed" && failure.kind === "budget" && <details open><summary>批准运行额度后继续</summary><label>新的累计 token 总上限<input type="number" min={job.total_tokens + 1} max={10000000} value={tokenBudget} onChange={event => setTokenBudget(Number(event.target.value))} /></label><p>将继续产生模型费用，不会自动增加额度。</p><button disabled={busy || tokenBudget <= job.total_tokens} onClick={() => void perform(`/api/v1/jobs/${job.id}/continue`, { max_model_calls: Math.min(1000, Math.max(job.max_model_calls, job.model_calls + 100)), max_total_tokens: tokenBudget })}>批准新上限并继续</button></details>}
      </div>}
    </section>;
  }

  const canStart = !loading && (!jobs.length || !!job) && !busy && !sendingMessage && enabled && materialsReady && !generating && !!goal.trim() && goal.length <= 20000 && Number.isInteger(count) && count >= 1 && count <= 500 && Number.isInteger(tokenBudget) && tokenBudget >= 1000 && tokenBudget <= 10000000;
  return <>
    {module !== "drawing" && outputMount && createPortal(<OutputPreview jobs={jobs} selectedId={previewId} onSelect={selectPreview} onOutputAvailable={onOutputAvailable} />, outputMount)}
    {ready && conversationTimeline(messages, jobs).map(entry => entry.type === "message"
      ? <ConversationMessage key={`message:${entry.message.id}`} message={entry.message} />
      : <div key={`job:${entry.job.id}`}>{confirmedCard(entry.job, entry.version)}</div>)}
    {sendingMessage && <div className="message-row assistant-message" role="status"><span className="message-avatar archflow-avatar">AF</span><p>正在保存并接收你的要求…</p></div>}
    {error && <p className="generation-error workflow-card" role="alert">{error}</p>}
    {connectionError && <p className="generation-error workflow-card" role="status">暂时无法读取最新进度，正在自动重试。{connectionError}</p>}
    {ready && !loading && module !== "drawing" && hasNewRequest && <section className="workflow-card pending-requirement" aria-label="需求确认">
      <h3>{job ? `确认新版本需求 · V${versions.length + 1}` : "确认这次需求 · V1"}</h3>
      {job && <p className="generation-note">确认后保存为独立版本；原需求卡与成果保留，右侧预览不会自动切换。</p>}
      <label className="requirement-editor">编辑需求摘要<textarea aria-label="需求摘要" rows={3} value={goal} disabled={busy} onChange={event => { setGoal(event.target.value); requestKey.current = null; }} /></label>
      {goal.length > 20000 && <p role="alert">需求超过 20,000 字，请精简摘要；原始对话与资料仍保留，不会自动删除前面的要求。</p>}
      <label>{module === "concept" ? "预计页数" : "内容章节数"}<input type="number" min={1} max={500} value={count} disabled={busy} onChange={event => { setCount(Number(event.target.value)); requestKey.current = null; }} /></label>
      {(!Number.isInteger(count) || count < 1 || count > 500) && <p role="alert">本次内容数量需在 1–500 之间。较长文档请拆分任务，不会自动缩减你的要求。</p>}
      <details><summary>运行上限与费用控制</summary><label>累计 token 上限<input type="number" min={1000} max={10000000} value={tokenBudget} disabled={busy} onChange={event => { setTokenBudget(Number(event.target.value)); requestKey.current = null; }} /></label><p>含输入和输出，非美元预算。最多 400 次调用；达到上限会停止并保留检查点，不会自动提高预算。单次已启动的请求可能使 token 总量超出上限。</p></details>
      {job && ["completed", "needs_review"].includes(job.status) && <><label>基于 V{versions.length} 修改页码 / 内容单元<input value={revisionRange} disabled={busy} onChange={event => { setRevisionRange(event.target.value); requestKey.current = null; }} placeholder="例如 3-5" /></label><button disabled={!canStart || count !== job.target_units} onClick={revise}>确认范围，生成新版本</button>{count !== job.target_units && <p className="generation-note">局部修改保留原有 {job.target_units} 个内容单元；调整总数量请使用下方重新整理提纲。</p>}</>}
      <button disabled={!canStart} onClick={() => void start()}>{busy ? "正在保存并创建版本…" : !job ? "确认需求，整理提纲" : `确认 ${count} ${module === "concept" ? "页" : "章"}需求，生成新版本提纲`}</button>
      {generating && <p>当前版本正在执行，补充要求已保存。完成后可确认新版本，也可以先取消当前任务。</p>}
      {!enabled && <p>模型服务尚未启用，需求已保存。管理员配置后可以继续。</p>}
      {!materialsReady && <p>项目资料仍在解析，或有文件失败。请在左侧等待、重试或排除失败文件。</p>}
    </section>}
  </>;
}
