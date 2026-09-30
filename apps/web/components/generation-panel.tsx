"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiRequest, jobDownloadUrl, type Message } from "@/lib/api";
import type { GenerationJobCreate, GenerationJobDetail, GenerationJobRecord, ResolvedRequirement } from "@/lib/job-contracts";
import { conversationTimeline, failureHelp, isActiveJob, jobStatuses, orderedJobs, requirementBrief } from "@/lib/workflow";
import { normalizeIntegerInput, parseIntegerInput } from "@/lib/integer-input";
import { ConversationMessage } from "./conversation-message";
import { OutputPreview } from "./output-preview";
import { WorkflowProgress } from "./workflow-progress";
import { useRunSettings } from "./run-settings";
import { ReviewEditor, ReviewProvider } from "./review-controls";
import { QualityReviewNotice } from "./quality-review-notice";

export function GenerationPanel({ projectId, conversationId, module, messages, outputMount, onOutputAvailable, materialsReady, ready, sendingMessage }: {
  projectId: string; conversationId: string | null; module: "concept" | "bid" | "drawing"; messages: Message[];
  outputMount: HTMLElement | null; onOutputAvailable: () => void; materialsReady: boolean; ready: boolean; sendingMessage: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [goal, setGoal] = useState("");
  const [countDraft, setCountDraft] = useState("10");
  const count = parseIntegerInput(countDraft, 1, 500);
  const [job, setJob] = useState<GenerationJobDetail | null>(null);
  const [jobs, setJobs] = useState<GenerationJobRecord[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [annotationEditing, setAnnotationEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [revisionRange, setRevisionRange] = useState("1");
  const { limits, openSettings } = useRunSettings();
  const [manualCount, setManualCount] = useState(false);
  const [resolution, setResolution] = useState<(ResolvedRequirement & { goal: string }) | null>(null);
  const [resolveRetry, setResolveRetry] = useState(0);
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
  const pendingRequirement = hasNewRequest || !!job?.scope_mismatch;
  const generating = !!job && ["queued", "running"].includes(job.status);
  const planningLabel = module === "concept" ? "逐页策划" : "逐章策划";

  function remember(next: GenerationJobDetail) {
    setJob(next);
    setJobs(items => [next, ...items.filter(item => item.id !== next.id)]);
  }

  function selectPreview(id: string) {
    if (annotationEditing && id !== previewId) { setError("请先将右侧批注加入本次反馈，或取消批注后切换版本。"); return; }
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
    lastUsers.current = brief; requestKey.current = null; setGoal(brief); setManualCount(false);
    const range = latest.match(module === "bid" ? /第\s*(\d{1,3})\s*(?:[-–到至]\s*(\d{1,3}))?\s*章/ : /第\s*(\d{1,3})\s*(?:[-–到至]\s*(\d{1,3}))?\s*页/);
    if (range) setRevisionRange(range[2] ? `${range[1]}-${range[2]}` : range[1]);
  }, [brief, latest, loading, ready]);

  useEffect(() => {
    if (!pendingRequirement || loading || !ready || !goal || goal.length > 20000 || manualCount) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void apiRequest<ResolvedRequirement>("/api/v1/requirements/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ module, goal,
        base_goal: job?.scope_mismatch ? "" : job?.goal ?? "", fallback_units: job?.target_units ?? 10 }) })
        .then(value => { if (!cancelled) { setCountDraft(String(value.target_units)); setResolution({ ...value, goal }); } })
        .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法整理需求，请重试。"); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [goal, module, job?.id, job?.goal, job?.scope_mismatch, pendingRequirement, loading, ready, manualCount, resolveRetry]);

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
    if (!conversationId || !goal.trim() || !limits || resolution?.goal !== goal || count === null) return;
    const version = scope.current;
    if (isActiveJob(job) && !await perform(`/api/v1/jobs/${job!.id}/cancel`)) return;
    if (scope.current !== version) return;
    const body: GenerationJobCreate = { project_id: projectId, conversation_id: conversationId, module, goal: goal.trim(), target_units: count,
      count_override: resolution.requested_units !== null && resolution.requested_units !== count, batch_size: 5, max_revision_rounds: 2, ...limits };
    await perform("/api/v1/jobs", body);
  }

  function revise() {
    if (!job || !limits || job.scope_mismatch) return;
    const range = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(revisionRange.trim());
    if (!range) { setError("修改范围请填写 3 或 3-5。"); return; }
    const start = Number(range[1]), end = Number(range[2] ?? range[1]);
    if (start < 1 || end < start || end > job.target_units) { setError("修改范围超出当前文档。"); return; }
    const instruction = goal.startsWith(job.goal) ? goal.slice(job.goal.length).trim() : goal.trim();
    if (!instruction || instruction.length > 4000) { setError("局部修改要求请控制在 4,000 字以内，或选择重新整理提纲。"); return; }
    void perform(`/api/v1/jobs/${job.id}/revise`, { instruction, units: Array.from({ length: end - start + 1 }, (_, index) => start + index), ...limits });
  }

  function confirmedCard(record: GenerationJobRecord, version: number) {
    const current = record.id === job?.id;
    const failure = failureHelp(record);
    return <section className="workflow-card confirmed-requirement" aria-label={`已确认需求 V${version}`} data-job-id={record.id}>
      <div className="requirement-card-heading"><h3>已确认需求 · V{version}</h3><button className="text-button" disabled={annotationEditing && record.id !== previewId} onClick={() => { selectPreview(record.id); onOutputAvailable(); }}>查看 V{version} 成果</button></div>
      <p className="requirement-summary">{record.goal.length > 300 ? `${record.goal.slice(0, 300)}…` : record.goal}</p>
      <p className="generation-note">{record.target_units} {module === "concept" ? "页" : "章"}{!current && ` · ${jobStatuses[record.status]}`}</p>
      {record.scope_mismatch && <p className="generation-error">此旧版本的文字要求与确认数量不一致。原记录保留，请在下方重新确认交付范围。</p>}
      {record.count_override && <p className="generation-note">交付数量以确认时手动设置的 {record.target_units} {module === "concept" ? "页" : "章"}为准。</p>}
      <details><summary>查看完整需求</summary><p>{record.goal}</p></details>
      {record.parent_id && <p className="generation-note">基于 V{versions.findIndex(item => item.id === record.parent_id) + 1} 的审阅反馈修订；原版保留。</p>}
      {current && job && <div className="workflow-task" aria-label={`V${version} 任务状态`} aria-live="polite">
        <WorkflowProgress job={job} />
        {hasNewRequest && !generating && <p className="generation-note">已收到新需求，请确认下方新版本；本版需求与成果保留。</p>}
        {job.status === "failed" && !job.scope_mismatch && <p role="alert">{failure.message}</p>}
        {!pendingRequirement && job.status === "failed" && !job.scope_mismatch && <div className="generation-actions">
          {!pendingRequirement && job.status === "failed" && failure.kind !== "budget" && <button disabled={busy} onClick={() => void perform(`/api/v1/jobs/${job.id}/retry`)}>{failure.retry}</button>}
          {!pendingRequirement && job.status === "failed" && failure.kind === "budget" && <><button disabled={busy || !limits || Math.max(limits.max_total_tokens, job.max_total_tokens) <= job.total_tokens || Math.max(limits.max_model_calls, job.max_model_calls) <= job.model_calls} onClick={() => { if (limits) void perform(`/api/v1/jobs/${job.id}/continue`, { max_model_calls: Math.max(limits.max_model_calls, job.max_model_calls), max_total_tokens: Math.max(limits.max_total_tokens, job.max_total_tokens) }); }}>按顶部运行设置继续</button><button onClick={openSettings}>调整运行设置</button></>}
        </div>}
        <QualityReviewNotice job={job} />
      </div>}
      <ReviewEditor job={record} version={version} current={current}
        approveAction={current && job && !pendingRequirement && ["waiting_outline", "waiting_storyboard", "waiting_review"].includes(job.status) ? <button className="generation-approve" disabled={busy} title={job.status === "waiting_outline" ? `批准提纲，继续${planningLabel}` : job.status === "waiting_storyboard" ? `批准${planningLabel}并授权生成全部内容` : "确认修订稿，继续排版"} onClick={() => void perform(`/api/v1/jobs/${job.id}/approve`)}>{job.status === "waiting_outline" ? "批准提纲" : job.status === "waiting_storyboard" ? `批准策划并生成全部 ${job.target_units} ${job.module === "concept" ? "页" : "章"}` : "确认修订稿"}</button> : undefined}
        cancelAction={current && isActiveJob(job) ? <button disabled={busy} onClick={() => void perform(`/api/v1/jobs/${record.id}/cancel`)}>取消任务</button> : undefined} />
      {current && job && <details><summary>技术诊断与用量</summary>{job.error && <p>{job.error}</p>}<p>{job.model_calls} / {job.max_model_calls} 次调用 · {job.total_tokens.toLocaleString()} / {job.max_total_tokens.toLocaleString()} 累计 tokens</p>{["completed", "needs_review", "failed", "cancelled"].includes(job.status) && <a href={jobDownloadUrl(job.id)}>下载诊断数据（JSON）</a>}</details>}
    </section>;
  }

  const canStart = !loading && (!jobs.length || !!job) && !busy && !sendingMessage && enabled && materialsReady && !generating && !!limits && resolution?.goal === goal && !!goal.trim() && goal.length <= 20000 && count !== null;
  return <ReviewProvider blocked={generating || busy || sendingMessage} annotationEditing={annotationEditing} onRevision={next => { remember(next); if (!previewId) selectPreview(next.id); }}>
    {module !== "drawing" && outputMount && createPortal(<OutputPreview jobs={jobs} selectedId={previewId} onSelect={selectPreview} onOutputAvailable={onOutputAvailable} onAnnotationEditing={setAnnotationEditing} />, outputMount)}
    {ready && conversationTimeline(messages, jobs).map(entry => entry.type === "message"
      ? <ConversationMessage key={`message:${entry.message.id}`} message={entry.message} />
      : <div key={`job:${entry.job.id}`}>{confirmedCard(entry.job, entry.version)}</div>)}
    {sendingMessage && <div className="message-row assistant-message" role="status"><span className="message-avatar archflow-avatar">AF</span><p>正在保存并接收你的要求…</p></div>}
    {error && <p className="generation-error workflow-card" role="alert">{error}{pendingRequirement && resolution?.goal !== goal && <button onClick={() => { setError(null); setResolveRetry(value => value + 1); }}>重新同步需求</button>}</p>}
    {connectionError && <p className="generation-error workflow-card" role="status">暂时无法读取最新进度，正在自动重试。{connectionError}</p>}
    {ready && !loading && module !== "drawing" && pendingRequirement && <section className="workflow-card pending-requirement" aria-label="需求确认">
      <h3>{job ? `确认新版本需求 · V${versions.length + 1}` : "确认这次需求 · V1"}</h3>
      {job && <p className="generation-note">确认后保存为独立版本；原需求卡与成果保留，右侧预览不会自动切换。</p>}
      <label className="requirement-editor">编辑需求摘要<textarea aria-label="需求摘要" rows={3} value={goal} disabled={busy} onChange={event => { setGoal(event.target.value); setManualCount(false); requestKey.current = null; }} /></label>
      {goal.length > 20000 && <p role="alert">需求超过 20,000 字，请精简摘要；原始对话与资料仍保留，不会自动删除前面的要求。</p>}
      <label>{module === "concept" ? "预计页数" : "内容章节数"}<input type="number" required min={1} max={500} value={resolution?.goal === goal ? countDraft : ""} placeholder={resolution?.goal === goal ? "输入数量" : "正在整理"} disabled={busy || resolution?.goal !== goal} onChange={event => { setCountDraft(event.target.value); setManualCount(true); requestKey.current = null; }} onBlur={() => setCountDraft(normalizeIntegerInput(countDraft))} /></label>
      {module === "bid" && <p className="generation-note">章节数不等于 Word 的物理页数；最终页数由排版结果确定。</p>}
      {resolution?.goal !== goal && <p className="generation-note" role="status">正在同步需求与交付数量…</p>}
      {resolution?.goal === goal && count !== null && resolution.requested_units !== null && resolution.requested_units !== count && <p className="generation-note">文字中提到 {resolution.requested_units} {module === "concept" ? "页" : "章"}；本次以此处确认的 {count} {module === "concept" ? "页" : "章"}为准。</p>}
      {resolution?.goal === goal && countDraft !== "" && count === null && <p role="alert">本次内容数量需在 1–500 之间。较长文档请拆分任务，不会自动缩减你的要求。</p>}
      {!limits && <p className="generation-note">运行设置尚未读取，<button onClick={openSettings}>打开运行设置</button>检查连接。</p>}
      {job && ["completed", "needs_review"].includes(job.status) && <><label>基于 V{versions.length} 修改页码 / 内容单元<input value={revisionRange} disabled={busy} onChange={event => { setRevisionRange(event.target.value); requestKey.current = null; }} placeholder="例如 3-5" /></label><button disabled={!canStart || count !== job.target_units} onClick={revise}>确认范围，生成新版本</button>{count !== null && count !== job.target_units && <p className="generation-note">局部修改保留原有 {job.target_units} 个内容单元；调整总数量请使用下方重新整理提纲。</p>}</>}
      <button disabled={!canStart} onClick={() => void start()}>{busy ? "正在保存并创建版本…" : !job ? "确认需求，整理提纲" : `确认 ${count ?? "—"} ${module === "concept" ? "页" : "章"}需求，生成新版本提纲`}</button>
      {generating && <p>当前版本正在执行，补充要求已保存。完成后可确认新版本，也可以先取消当前任务。</p>}
      {!enabled && <p>模型服务尚未启用，需求已保存。管理员配置后可以继续。</p>}
      {!materialsReady && <p>项目资料仍在解析，或有文件失败。请在左侧等待、重试或排除失败文件。</p>}
    </section>}
  </ReviewProvider>;
}
