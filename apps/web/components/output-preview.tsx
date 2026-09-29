"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api";
import type { ArtifactUnit, GenerationJobDetail, GenerationJobRecord } from "@/lib/job-contracts";
import { jobStatuses, orderedJobs } from "@/lib/workflow";

type ExportState = { status: string; requested: boolean; error: string | null; result: { page_count: number; format: string; missing_facts: number } | null };
const url = (path: string) => `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}${path}`;

// Read-only preview state is deliberately independent of the current workflow.
export function OutputPreview({ jobs, selectedId, onSelect, onOutputAvailable }: {
  jobs: GenerationJobRecord[]; selectedId: string | null; onSelect: (id: string) => void; onOutputAvailable: () => void;
}) {
  const [detail, setDetail] = useState<GenerationJobDetail | null>(null);
  const [units, setUnits] = useState<ArtifactUnit[]>([]);
  const [exported, setExported] = useState<ExportState | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const available = useRef(onOutputAvailable);
  available.current = onOutputAvailable;
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const versions = orderedJobs(jobs);
  const current = jobs.find(job => job.id === selectedId);
  const latest = versions.at(-1);
  const version = versions.findIndex(job => job.id === selectedId) + 1;
  const kind = current?.stage === "storyboarding" || current?.status === "waiting_storyboard" ? "storyboard" : "draft";

  useEffect(() => { setDetail(null); setUnits([]); setExported(null); setPage(0); setError(null); }, [selectedId]);
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

  return <div className="output-preview">
    {versions.length > 0 && <div className="output-version-bar">
      <label htmlFor="output-version">成果版本</label>
      <select id="output-version" value={selectedId ?? ""} onChange={event => onSelect(event.target.value)}>
        {versions.map((job, index) => <option key={job.id} value={job.id}>V{index + 1} · {job.target_units} {job.module === "concept" ? "页" : "章"} · {jobStatuses[job.status]}</option>)}
      </select>
      {latest && selectedId !== latest.id && <p className="generation-note">当前查看 V{version}；新版本 V{versions.length} · {jobStatuses[latest.status]}。<button onClick={() => onSelect(latest.id)}>查看 V{versions.length}</button></p>}
    </div>}
    <div className="generation-panel output-only">
      {error && <p className="generation-error" role="status">{error}</p>}
      {!selectedId ? <p className="generation-note">提纲与成果会显示在这里。请从中间的项目对话开始。</p> : !detail ? <p role="status">正在读取 V{version} 成果…</p> : <>
        <p className="generation-note">V{version} · {jobStatuses[detail.status]}。切换这里只改变预览，不会改变对话或启动任务。</p>
        {!detail.outline && <p className="generation-note">此版本尚无提纲或成果；已确认需求仍保留在对话中。</p>}
        {detail.outline && <details open={!exported?.result}><summary>章节提纲 · V{version}</summary><p>{detail.outline.summary}</p><ol>{detail.outline.sections.map(section => <li key={section.start_unit}><strong>{section.start_unit}–{section.end_unit} · {section.title}</strong><p>{section.objective}</p></li>)}</ol></details>}
        {exported?.requested && ["queued", "processing"].includes(exported.status) && <p role="status">正在排版和渲染可编辑文件…</p>}
        {exported?.status === "failed" && <div role="alert"><p>{exported.error}</p><button onClick={() => void requestExport(`/api/v1/jobs/${selectedId}/export/retry`)}>重试排版</button></div>}
        {["completed", "needs_review"].includes(detail.status) && exported && !exported.requested && <button onClick={() => void requestExport(`/api/v1/jobs/${selectedId}/export`)}>排版为可编辑审阅文件</button>}
        {exported?.status === "ready" && exported.result && <>
          <div className="generation-actions"><a href={url(`/api/v1/jobs/${selectedId}/export/${exported.result.format}`)}>下载 {exported.result.format.toUpperCase()}</a><a href={url(`/api/v1/jobs/${selectedId}/export/pdf`)}>下载 PDF</a></div>
          <p className="generation-note">{exported.result.page_count} 页 · 可编辑审阅版{exported.result.missing_facts ? ` · ${exported.result.missing_facts} 项资料待补充` : ""}</p>
          <img className="artifact-page" src={url(`/api/v1/jobs/${selectedId}/preview/${Math.min(page + 1, exported.result.page_count)}`)} alt={`V${version} 文档第 ${page + 1} 页`} loading="lazy" />
          <div className="generation-actions"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page + 1} / {exported.result.page_count}</span><button disabled={page + 1 >= exported.result.page_count} onClick={() => setPage(value => value + 1)}>下一页</button></div>
        </>}
        {exported?.status !== "ready" && units.map(unit => <article className="generation-unit" key={unit.unit_index}><p className="eyebrow">{kind === "storyboard" ? "逐页策划" : "内容草稿"} · {unit.unit_index}</p><h3>{unit.title}</h3><p className="generation-body">{unit.body}</p>{unit.missing_facts.length > 0 && <p className="generation-error">待确认：{unit.missing_facts.join("；")}</p>}</article>)}
        {exported?.status !== "ready" && units.length > 0 && <div className="generation-actions"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一组</button><span>第 {page * 5 + 1} 页起</span><button disabled={(page + 1) * 5 >= (kind === "storyboard" ? detail.storyboard_units : detail.target_units)} onClick={() => setPage(value => value + 1)}>下一组</button></div>}
      </>}
    </div>
  </div>;
}
