"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import type { ArtifactKind, ArtifactUnit, CommentAnchor, GenerationJobDetail, GenerationJobRecord } from "@/lib/job-contracts";
import { jobStatuses, orderedJobs, workflowState } from "@/lib/workflow";
import { useReviews } from "./review-controls";
import { displayCitations } from "@/lib/source-citations";
import { useCitationSources } from "@/lib/use-citation-sources";

type ExportState = { status: string; requested: boolean; error: string | null; result: { page_count: number; format: string; missing_facts: number } | null };
const url = (path: string) => `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}${path}`;

// Read-only preview state is deliberately independent of the current workflow.
export function OutputPreview({ jobs, selectedId, onSelect, onOutputAvailable, onAnnotationEditing }: {
  jobs: GenerationJobRecord[]; selectedId: string | null; onSelect: (id: string) => void; onOutputAvailable: () => void; onAnnotationEditing: (editing: boolean) => void;
}) {
  const [detail, setDetail] = useState<GenerationJobDetail | null>(null);
  const [units, setUnits] = useState<ArtifactUnit[]>([]);
  const [exported, setExported] = useState<ExportState | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const reviews = useReviews();
  const [textView, setTextView] = useState(false);
  const [textKind, setTextKind] = useState<"storyboard" | "draft" | null>(null);
  const [annotation, setAnnotation] = useState<{ jobId: string; kind: ArtifactKind; anchor: CommentAnchor } | null>(null);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const commentKey = useRef<string | null>(null);
  const contentRoot = useRef<HTMLDivElement>(null);
  const available = useRef(onOutputAvailable);
  available.current = onOutputAvailable;
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const versions = orderedJobs(jobs);
  const citations = useCitationSources(selectedId);
  const show = (text: string) => displayCitations(text, citations?.sources ?? []);
  const current = jobs.find(job => job.id === selectedId);
  const latest = versions.at(-1);
  const version = versions.findIndex(job => job.id === selectedId) + 1;
  const kind = textKind ?? (current?.stage === "storyboarding" || current?.status === "waiting_storyboard" ? "storyboard" : "draft");
  const pending = (selectedId ? reviews.records[selectedId]?.comments ?? [] : []).filter(item => !item.submitted_job_id);
  useEffect(() => { onAnnotationEditing(editing || saving); return () => onAnnotationEditing(false); }, [editing, saving, onAnnotationEditing]);
  useEffect(() => { if (selectedId) void reviews.load(selectedId); }, [selectedId, reviews.load]);

  useEffect(() => { setDetail(null); setUnits([]); setExported(null); setPage(0); setError(null); setAnnotation(null); setEditing(false); setComment(""); setTextView(false); setTextKind(null); }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [next, content, result] = await Promise.all([
          apiRequest<GenerationJobDetail>(`/api/v1/jobs/${selectedId}`),
          apiRequest<ArtifactUnit[]>(`/api/v1/jobs/${selectedId}/units?kind=${kind}&offset=${page * 5}&limit=5`),
          apiRequest<ExportState>(`/api/v1/jobs/${selectedId}/export`),
        ]);
        if (cancelled) return;
        setDetail(next); setUnits(content); setExported(result); setError(null);
        if (["queued", "running"].includes(next.status) || (result.requested && ["queued", "processing"].includes(result.status))) timer = setTimeout(refresh, 2000);
      } catch (cause) {
        if (!cancelled) { setError(cause instanceof Error ? cause.message : "无法读取成果，正在重试。"); timer = setTimeout(refresh, 5000); }
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedId, kind, page, current?.updated_at, retry]);

  useEffect(() => { if (detail?.outline) available.current(); }, [detail?.id, !!detail?.outline]);
  useEffect(() => { if (exported?.status === "ready") setPage(0); }, [selectedId, exported?.status]);

  async function requestExport(path: string) {
    const id = selectedId;
    try { await apiRequest(path, { method: "POST" }); if (selection.current === id) setRetry(value => value + 1); }
    catch (cause) { if (selection.current === id) setError(cause instanceof Error ? cause.message : "排版失败，请重试。"); }
  }

  function captureSelection() {
    if (editing || !selectedId || !contentRoot.current) return;
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed) { setAnnotation(null); return; }
    const range = selected.getRangeAt(0);
    const anchorFor = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-review-index]");
    const start = anchorFor(range.startContainer), end = anchorFor(range.endContainer);
    if (!start || start !== end || !contentRoot.current.contains(start)) { setAnnotation(null); return; }
    const fragment = range.cloneContents();
    fragment.querySelectorAll("[data-review-exclude]").forEach(node => node.remove());
    const quote = fragment.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!quote || quote.length > 4000) { setAnnotation(null); return; }
    setAnnotation({ jobId: selectedId, kind: start.dataset.reviewKind as ArtifactKind, anchor: { unit_index: Number(start.dataset.reviewIndex), quote } });
    setCommentError(null); commentKey.current = null;
  }

  async function saveAnnotation() {
    if (!annotation || saving || !comment.trim()) return;
    setSaving(true); setCommentError(null); commentKey.current ??= crypto.randomUUID();
    try {
      await reviews.add(annotation.jobId, annotation.kind, annotation.anchor, comment.trim(), commentKey.current);
      setAnnotation(null); setEditing(false); setComment(""); commentKey.current = null;
    } catch (cause) { setCommentError(cause instanceof Error ? cause.message : "批注保存失败，文字保留。请重试。"); }
    finally { setSaving(false); }
  }

  return <div className="output-preview">
    {versions.length > 0 && <div className="output-version-bar">
      <label htmlFor="output-version">成果版本</label>
      <select id="output-version" value={selectedId ?? ""} disabled={editing || saving} onChange={event => onSelect(event.target.value)}>
        {versions.map((job, index) => <option key={job.id} value={job.id}>V{index + 1} · {job.target_units} {job.module === "concept" ? "页" : "章"} · {jobStatuses[job.status]}</option>)}
      </select>
      {latest && selectedId !== latest.id && <p className="generation-note">当前查看 V{version}；新版本 V{versions.length} · {jobStatuses[latest.status]}。<button disabled={editing || saving} onClick={() => onSelect(latest.id)}>查看 V{versions.length}</button></p>}
    </div>}
    {selectedId && detail?.outline && <div className="review-toolbar">
      {pending.length ? <button onClick={() => reviews.open(selectedId)}>本次反馈 · {pending.length} 条批注 · 去确认卡统一提交</button> : <p className="generation-note">选中同一段文字可添加批注，与确认卡里的整体意见一起提交。</p>}
      {annotation && !editing && <button className="selection-comment-button" onClick={() => { setEditing(true); setComment(""); }}>批注所选文字</button>}
      {annotation && editing && <div className="annotation-composer" role="group" aria-label="选文批注">
        <strong>V{version} · 所选文字</strong><blockquote>{annotation.anchor.quote}</blockquote>
        <textarea aria-label="批注意见" autoFocus rows={3} maxLength={4000} placeholder="希望这段如何修改？" value={comment} disabled={saving} onChange={event => { setComment(event.target.value); commentKey.current = null; }} />
        {commentError && <p className="generation-error" role="alert">{commentError}</p>}
        <div className="generation-actions"><button disabled={saving || !comment.trim()} onClick={() => void saveAnnotation()}>{saving ? "正在保存…" : "加入本次反馈"}</button><button disabled={saving} onClick={() => { setEditing(false); setAnnotation(null); setComment(""); }}>取消批注</button></div>
        <p className="generation-note">这里只保存批注，不会启动修订。请在确认卡统一提交。</p>
      </div>}
    </div>}
    <div className="generation-panel output-only">
      {error && <p className="generation-error" role="status">{error}</p>}
      {!selectedId ? <p className="generation-note">提纲与成果会显示在这里。请从中间的项目对话开始。</p> : !detail || !citations ? <p role="status">正在读取 V{version} 成果与来源文件名…</p> : <>
        {citations.error && <p role="alert" className="generation-error">来源文件名暂时无法读取，引用仍显示原始编号。{citations.error}</p>}
        {!detail.outline && <div className="output-empty"><strong>{workflowState(detail).label}</strong><p className="generation-note">提纲准备好后会显示在这里，确认操作在对话中。</p>{versions.some(item => item.id !== selectedId) && <p className="generation-note">也可以从上方选择已有版本继续查看。</p>}</div>}
        {detail.scope_mismatch && <p className="generation-error">此旧版本的提纲与交付数量需要重新确认；保留原成果供参考，不应按此范围继续生成。</p>}
        <div ref={contentRoot} onPointerUp={captureSelection} onKeyUp={captureSelection}>
        {detail.outline && <details open={!exported?.result}><summary>章节提纲 · V{version}</summary><p className="generation-note">{detail.outline.sections.length} 个{detail.module === "concept" ? "章节" : "分组"} · 已确认交付 {detail.target_units} {detail.module === "concept" ? "页" : "章"}</p><p data-review-kind="outline" data-review-index={0}>{show(detail.outline.summary)}</p><ol>{detail.outline.sections.map((section, index) => <li key={section.start_unit} data-review-kind="outline" data-review-index={index + 1}><strong><span data-review-exclude>第{section.start_unit === section.end_unit ? section.start_unit : `${section.start_unit}–${section.end_unit}`}{detail.module === "concept" ? "页" : "章"} · </span>{show(section.title)}</strong>{"\n"}<p>{show(section.objective)}</p></li>)}</ol></details>}
        {exported?.requested && ["queued", "processing"].includes(exported.status) && <p role="status">正在排版和渲染可编辑文件…</p>}
        {exported?.status === "failed" && <div role="alert"><p>{exported.error}</p><button onClick={() => void requestExport(`/api/v1/jobs/${selectedId}/export/retry`)}>重试排版</button></div>}
        {["completed", "needs_review"].includes(detail.status) && exported && !exported.requested && <button onClick={() => void requestExport(`/api/v1/jobs/${selectedId}/export`)}>排版为可编辑审阅文件</button>}
        {exported?.status === "ready" && exported.result && <>
          <div className="generation-actions"><a href={url(`/api/v1/jobs/${selectedId}/export/${exported.result.format}`)}>下载 {exported.result.format.toUpperCase()}</a><a href={url(`/api/v1/jobs/${selectedId}/export/pdf`)}>下载 PDF</a></div>
          <p className="generation-note">{exported.result.page_count} 页 · 可编辑审阅版{exported.result.missing_facts ? ` · ${exported.result.missing_facts} 项资料待补充` : ""}</p>
          <div className="generation-actions"><button aria-pressed={!textView} disabled={editing} onClick={() => { setTextView(false); setPage(0); }}>页面预览</button><button aria-pressed={textView} disabled={editing} onClick={() => { setTextView(true); setPage(0); }}>文字审阅与批注</button></div>
          {!textView && <><img className="artifact-page" src={url(`/api/v1/jobs/${selectedId}/preview/${Math.min(page + 1, exported.result.page_count)}`)} alt={`V${version} 文档第 ${page + 1} 页`} loading="lazy" />
          <div className="generation-actions"><button disabled={page === 0 || editing} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page + 1} / {exported.result.page_count}</span><button disabled={page + 1 >= exported.result.page_count || editing} onClick={() => setPage(value => value + 1)}>下一页</button></div></>}
        </>}
        {(exported?.status !== "ready" || textView) && <>
          {detail.storyboard_units > 0 && ["generating", "final_review"].includes(detail.stage) && <label className="artifact-text-kind">审阅内容<select aria-label="审阅内容" value={kind} disabled={editing} onChange={event => { setTextKind(event.target.value as "storyboard" | "draft"); setPage(0); }}><option value="draft">正文</option><option value="storyboard">内容策划</option></select></label>}
          {units.map(unit => <article className="generation-unit" key={unit.unit_index}><p className="eyebrow">{kind === "storyboard" ? detail.module === "concept" ? "逐页策划" : "逐章策划" : "内容草稿"} · {unit.unit_index}</p><div data-review-kind={kind} data-review-index={unit.unit_index}><h3>{show(unit.title)}</h3>{"\n"}<p className="generation-body">{show(unit.body)}</p></div>{unit.missing_facts.length > 0 && <p className="generation-error">待确认：{unit.missing_facts.map(show).join("；")}</p>}</article>)}
          {units.length > 0 && <div className="generation-actions"><button disabled={page === 0 || editing} onClick={() => setPage(value => value - 1)}>上一组</button><span>第 {page * 5 + 1} {detail.module === "concept" ? "页" : "章"}起</span><button disabled={(page + 1) * 5 >= detail.target_units || editing} onClick={() => setPage(value => value + 1)}>下一组</button></div>}
        </>}
        </div>
      </>}
    </div>
  </div>;
}
