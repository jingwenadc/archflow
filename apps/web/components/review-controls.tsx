"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { apiRequest } from "@/lib/api";
import type { ArtifactKind, CommentAnchor, GenerationJobDetail, GenerationJobRecord, ReviewComment } from "@/lib/job-contracts";

export const reviewLabels: Record<ArtifactKind, string> = { outline: "提纲", storyboard: "内容策划", draft: "正文" };
type ReviewState = { comments?: ReviewComment[]; error?: string };
type Reviews = {
  records: Record<string, ReviewState>; blocked: boolean; annotationEditing: boolean; submitting: string | null; opened: string | null;
  open: (id: string) => void; load: (id: string) => Promise<void>;
  add: (id: string, kind: ArtifactKind, anchor: CommentAnchor, body: string, key: string) => Promise<void>;
  remove: (id: string, commentId: string) => Promise<void>;
  submit: (id: string, kind: ArtifactKind, overall: string, ids: string[], key: string) => Promise<void>;
};
const ReviewContext = createContext<Reviews | null>(null);
export function useReviews() {
  const context = useContext(ReviewContext);
  if (!context) throw new Error("Review controls require ReviewProvider.");
  return context;
}

// Portaled output and timeline share one review draft and one submission path.
export function ReviewProvider({ children, blocked, annotationEditing, onRevision }: { children: ReactNode; blocked: boolean; annotationEditing: boolean; onRevision: (job: GenerationJobDetail) => void }) {
  const [records, setRecords] = useState<Record<string, ReviewState>>({});
  const [opened, setOpened] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const epochs = useRef(new Map<string, number>());
  const loading = useRef(new Map<string, Promise<void>>());
  const submittingRef = useRef(false);
  const open = useCallback((id: string) => {
    setOpened(id);
    document.querySelector<HTMLElement>(`[data-job-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);
  const load = useCallback((id: string) => {
    const existing = loading.current.get(id);
    if (existing) return existing;
    const epoch = epochs.current.get(id) ?? 0;
    const request = apiRequest<ReviewComment[]>(`/api/v1/jobs/${id}/comments`).then(comments => {
      if (epoch === (epochs.current.get(id) ?? 0)) setRecords(previous => ({ ...previous, [id]: { comments } }));
    }).catch(cause => setRecords(previous => ({ ...previous, [id]: { ...previous[id], error: cause instanceof Error ? cause.message : "无法读取批注" } })))
      .finally(() => loading.current.delete(id));
    loading.current.set(id, request);
    return request;
  }, []);
  const changed = (id: string) => epochs.current.set(id, (epochs.current.get(id) ?? 0) + 1);
  async function add(id: string, kind: ArtifactKind, anchor: CommentAnchor, body: string, key: string) {
    // Finish the initial read before a mutation so a slow response cannot drop
    // older pending comments from the combined submission.
    if (!records[id]?.comments) await load(id);
    const comment = await apiRequest<ReviewComment>(`/api/v1/jobs/${id}/comments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ kind, anchor, body }) });
    changed(id);
    setRecords(previous => ({ ...previous, [id]: { comments: [...(previous[id]?.comments ?? []).filter(item => item.id !== comment.id), comment] } }));
    setOpened(id);
    await load(id);
  }
  async function remove(id: string, commentId: string) {
    await apiRequest(`/api/v1/jobs/${id}/comments/${commentId}`, { method: "DELETE" });
    changed(id);
    setRecords(previous => ({ ...previous, [id]: { comments: (previous[id]?.comments ?? []).filter(item => item.id !== commentId) } }));
  }
  async function submit(id: string, kind: ArtifactKind, overall: string, ids: string[], key: string) {
    if (annotationEditing) throw new Error("请先将右侧批注加入本次反馈，或取消批注后统一提交。");
    if (blocked || submittingRef.current) throw new Error("请等待当前任务结束或暂停后提交；批注可以先保存。");
    submittingRef.current = true; setSubmitting(id);
    try {
      const job = await apiRequest<GenerationJobDetail>(`/api/v1/jobs/${id}/feedback`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ kind, overall, comment_ids: ids }) });
      changed(id);
      setRecords(previous => ({ ...previous, [id]: { comments: (previous[id]?.comments ?? []).map(comment => ids.includes(comment.id) ? { ...comment, submitted_job_id: job.id } : comment) } }));
      onRevision(job);
      setOpened(null);
      void load(id);
    } finally { submittingRef.current = false; setSubmitting(null); }
  }
  return <ReviewContext.Provider value={{ records, blocked, annotationEditing, submitting, opened, open, load, add, remove, submit }}>{children}</ReviewContext.Provider>;
}

export function ReviewEditor({ job, version, current, approveAction, cancelAction }: {
  job: GenerationJobRecord; version: number; current: boolean; approveAction?: ReactNode; cancelAction?: ReactNode;
}) {
  const reviews = useReviews();
  const state = reviews.records[job.id];
  const comments = state?.comments ?? [];
  const pending = comments.filter(comment => !comment.submitted_job_id);
  const submitted = comments.filter(comment => comment.submitted_job_id);
  const defaultKind: ArtifactKind = ["generating", "final_review"].includes(job.stage) ? "draft" : job.storyboard_units ? "storyboard" : "outline";
  const reviewReady = current && !job.scope_mismatch && ["waiting_outline", "waiting_storyboard", "waiting_review", "needs_review", "completed"].includes(job.status);
  const [kind, setKind] = useState(defaultKind);
  const [overall, setOverall] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [expanded, setExpanded] = useState(reviewReady);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [sent, setSent] = useState(false);
  const key = useRef<string | null>(null);
  const storageKey = `archflow.review:${job.id}`;
  useEffect(() => { if ((current || expanded) && !state?.comments && !state?.error) void reviews.load(job.id); }, [current, expanded, job.id, reviews.load, !!state?.comments, !!state?.error]);
  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { overall?: string; kind?: ArtifactKind } | null;
      if (draft?.overall) setOverall(draft.overall);
      if (draft?.kind && draft.kind in reviewLabels) setKind(draft.kind);
    } catch { /* Draft editing works without storage. */ }
    setHydrated(true);
  }, [storageKey]);
  useEffect(() => { if (hydrated) { try { localStorage.setItem(storageKey, JSON.stringify({ overall, kind })); } catch { /* Optional draft persistence. */ } } }, [hydrated, storageKey, overall, kind]);
  useEffect(() => { key.current = null; setSent(false); }, [kind, overall, pending.map(comment => comment.id).join(",")]);
  useEffect(() => { if (reviews.opened === job.id || pending.length) setExpanded(true); }, [reviews.opened, job.id, pending.length]);
  // Entering any human-review phase opens the same editor. Polling the same
  // phase does not undo a user's collapse; empty historical editors collapse.
  useEffect(() => {
    if (reviewReady) setExpanded(true);
    else if (!pending.length && !overall.trim()) setExpanded(false);
  }, [reviewReady, current, defaultKind]);
  useEffect(() => { if (!overall) setKind(defaultKind); }, [defaultKind]);
  async function submit() {
    setError(null); key.current ??= crypto.randomUUID();
    try { await reviews.submit(job.id, kind, overall.trim(), pending.map(comment => comment.id), key.current); setOverall(""); setExpanded(false); key.current = null; setSent(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "反馈提交失败，草稿保留。请重试。"); }
  }
  return <div className="review-editor">
    <div className="generation-actions review-actions" role="group" aria-label={`V${version} 审阅操作`}>
      {approveAction}
      <button className="review-toggle" aria-expanded={expanded} aria-controls={`review-draft-${job.id}`} onClick={() => setExpanded(value => !value)}>修改意见</button>
      {cancelAction}
    </div>
    {expanded && <div className="review-draft" id={`review-draft-${job.id}`}>
      <label>整体反馈针对<select aria-label={`V${version} 反馈阶段`} value={kind} disabled={reviews.submitting !== null} onChange={event => setKind(event.target.value as ArtifactKind)}>
        <option value="outline">提纲</option>{job.storyboard_units > 0 && <option value="storyboard">内容策划</option>}{["generating", "final_review"].includes(job.stage) && <option value="draft">正文</option>}
      </select></label>
      <label className="requirement-editor">整体意见<textarea aria-label={`V${version} 整体意见`} placeholder="例如：保留结构，突出设计构思，减少背景介绍。可与右侧批注一起提交。" rows={3} maxLength={4000} value={overall} disabled={reviews.submitting !== null} onChange={event => setOverall(event.target.value)} /></label>
      {pending.map(comment => <div className="review-comment" key={comment.id}>
        <div className="review-comment-heading"><strong>{reviewLabels[comment.kind]} · {comment.anchor?.unit_index === 0 ? "摘要" : `位置 ${comment.anchor?.unit_index}`}</strong><button aria-label="移除批注" disabled={removing || reviews.submitting !== null} onClick={async () => { setRemoving(true); setError(null); try { await reviews.remove(job.id, comment.id); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法移除批注"); } finally { setRemoving(false); } }}>移除</button></div>
        {comment.anchor && <blockquote>{comment.anchor.quote}</blockquote>}<p>{comment.body}</p>
      </div>)}
      <p className="generation-note">右侧选中文字可添加批注；与整体意见一次提交，保存为新版本。涉及多个阶段时从最早阶段修订，仍需重新确认。</p>
      {reviews.blocked && <p className="generation-note">当前任务仍在执行，可以先记录批注；结束或暂停后再提交修订。</p>}
      {reviews.annotationEditing && <p className="generation-note">请先将右侧批注加入本次反馈，再一起提交。</p>}
      {pending.length > 100 && <p role="alert">单次修订最多包含 100 条批注，请精简重复意见后一起提交。</p>}
      {(error || state?.error) && <p role="alert" className="generation-error">{error ?? state?.error}{state?.error && <button onClick={() => void reviews.load(job.id)}>重新读取批注</button>}</p>}
      <button className="review-submit" disabled={!hydrated || !state?.comments || !!state.error || (!overall.trim() && !pending.length) || pending.length > 100 || reviews.blocked || reviews.annotationEditing || reviews.submitting !== null || removing || !!job.scope_mismatch} onClick={() => void submit()}>{reviews.submitting === job.id ? "正在提交反馈…" : "提交反馈，生成修订稿"}</button>
      {sent && <p role="status">反馈已提交，修订任务已创建；原版本保留。</p>}
    </div>}
    {submitted.length > 0 && <details><summary>已提交反馈 · {submitted.length} 条</summary>{submitted.map(comment => <div className="review-comment" key={comment.id}><strong>{reviewLabels[comment.kind]}</strong>{comment.anchor && <blockquote>{comment.anchor.quote}</blockquote>}<p>{comment.body}</p></div>)}</details>}
  </div>;
}
