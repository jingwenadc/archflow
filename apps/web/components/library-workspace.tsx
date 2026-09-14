"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createSkillDraftPullRequest, getSkillDetail, getSkillFileUrl, uploadCaseFile, type DraftPullRequest, type SkillDetail, type SkillFile, type UploadedFile } from "@/lib/api";
import { skills } from "@/lib/workspace-data";
import { CheckIcon, ChevronLeft, ChevronRight, EditIcon, EyeOffIcon, FolderIcon, UploadIcon } from "./icons";
import { SkillFileTree } from "./skill-file-tree";

type LibraryTab = "skills" | "cases";

function fileLabel(file: SkillFile | null) { return file?.path.split("/").pop() ?? "技能内容"; }

export function LibraryWorkspace() {
  const [tab, setTab] = useState<LibraryTab>("skills");
  const [selectedSlug, setSelectedSlug] = useState<string>(skills[0].slug);
  const [details, setDetails] = useState<Record<string, SkillDetail>>({});
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [caseFiles, setCaseFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pullRequest, setPullRequest] = useState<DraftPullRequest | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(skills.map((skill) => getSkillDetail(skill.slug)))
      .then((items) => { if (!cancelled) setDetails(Object.fromEntries(items.map((item) => [item.slug, item]))); })
      .catch((reason: Error) => { if (!cancelled) setSkillError(reason.message); })
      .finally(() => { if (!cancelled) setLoadingSkills(false); });
    return () => { cancelled = true; };
  }, []);

  const selectedSkill = skills.find((skill) => skill.slug === selectedSlug) ?? skills[0];
  const selectedDetail = details[selectedSkill.slug];
  const selectedFile = selectedDetail?.files.find((file) => file.path === selectedPath) ?? null;
  const currentContent = selectedFile?.editable ? drafts[selectedPath] ?? selectedFile.content ?? "" : "";
  const changes = useMemo(() => !selectedDetail ? [] : Object.entries(drafts)
    .filter(([path, content]) => content !== (selectedDetail.files.find((file) => file.path === path)?.content ?? ""))
    .map(([path, content]) => ({ path, content })), [drafts, selectedDetail]);

  function selectSkill(slug: string) {
    setSelectedSlug(slug);
    setSelectedPath("SKILL.md");
    setDrafts({});
    setEditing(false);
    setPullRequest(null);
  }

  async function uploadFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (!selected.length) return;
    setUploading(true); setUploadError(null);
    try {
      const uploaded = await Promise.all(selected.map(uploadCaseFile));
      setCaseFiles((current) => [...uploaded, ...current]);
    } catch (reason) { setUploadError(reason instanceof Error ? reason.message : "案例上传失败"); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function submitDraft() {
    if (!changes.length) return;
    setSubmitting(true); setSkillError(null);
    try {
      setPullRequest(await createSkillDraftPullRequest(selectedSlug, { title: `docs(skills): update ${selectedSkill.name}`, description: "通过 ArchFlow 技能工作区提交，请审阅内容和流程变更。", changes }));
    } catch (reason) { setSkillError(reason instanceof Error ? reason.message : "Draft PR 创建失败"); }
    finally { setSubmitting(false); }
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) { if (event.target.files) void uploadFiles(event.target.files); }
  function handleDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); void uploadFiles(event.dataTransfer.files); }

  return (
    <main className={editing ? "skills-workspace-grid is-editing" : "skills-workspace-grid"}>
      <aside className={leftCollapsed ? "skills-resource-panel is-collapsed" : "skills-resource-panel"} aria-label="技能文件夹">
        {leftCollapsed ? <button className="rail-button" type="button" onClick={() => setLeftCollapsed(false)} aria-label="展开技能文件夹"><FolderIcon /><ChevronRight /></button> : <>
          <div className="panel-title-row"><div><p className="eyebrow">SKILL FILES</p><h2>{tab === "skills" ? "技能库" : "案例资料"}</h2></div><button className="icon-button" type="button" onClick={() => setLeftCollapsed(true)} aria-label="收起技能文件夹"><ChevronLeft /></button></div>
          {tab === "skills" ? <><div className="skills-skill-list" aria-label="选择技能">{skills.map((skill) => <button className={skill.slug === selectedSlug ? "is-active" : ""} key={skill.slug} type="button" onClick={() => selectSkill(skill.slug)}><FolderIcon /><span>{skill.name}</span></button>)}</div>{selectedDetail ? <SkillFileTree files={selectedDetail.files} selectedPath={selectedPath} changedPaths={changes.map((change) => change.path)} onSelect={(file) => { setSelectedPath(file.path); setEditing(false); }} /> : <p className="library-loading">正在读取技能目录…</p>}</> : <div className="skills-resource-empty"><FolderIcon /><p>案例上传后会显示在这里</p></div>}
        </>}
      </aside>

      <section className="skills-center-panel" aria-label="技能与案例工作区">
        <div className="skills-center-heading"><div><p className="eyebrow">CASES &amp; SKILLS</p><h1>案例 / 技能库</h1></div><div className="library-tabs" role="tablist" aria-label="案例与技能"><button className={tab === "skills" ? "is-active" : ""} role="tab" aria-selected={tab === "skills"} type="button" onClick={() => setTab("skills")}>技能 <span>{skills.length}</span></button><button className={tab === "cases" ? "is-active" : ""} role="tab" aria-selected={tab === "cases"} type="button" onClick={() => setTab("cases")}>案例 <span>{caseFiles.length}</span></button></div></div>
        {tab === "skills" ? <div className="skill-document-panel skills-document-panel"><header className="document-toolbar"><div><strong>{fileLabel(selectedFile)}</strong><span>{selectedFile?.path}</span></div>{selectedFile && <button className="document-edit-button" type="button" disabled={!selectedFile.editable} onClick={() => setEditing((value) => !value)}><EditIcon />{editing ? "预览" : "编辑"}</button>}</header>{skillError && !selectedDetail && <p className="library-error" role="alert">{skillError}。请确认 API 服务已启动。</p>}{selectedFile?.editable && editing && <textarea className="skill-source-editor" aria-label={`编辑 ${selectedFile.path}`} value={currentContent} spellCheck={false} onChange={(event) => setDrafts((current) => ({ ...current, [selectedPath]: event.target.value }))} />}{selectedFile?.kind === "markdown" && !editing && <article className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]}>{currentContent}</ReactMarkdown></article>}{selectedFile?.kind === "code" && !editing && <pre className="code-document"><code>{currentContent}</code></pre>}{selectedFile?.kind === "image" && <div className="skill-image-preview"><img src={getSkillFileUrl(selectedSlug, selectedFile.path)} alt={fileLabel(selectedFile)} /><p>{selectedFile.path}</p></div>}{selectedFile?.kind === "binary" && <div className="skill-empty-file"><EyeOffIcon /><strong>该文件已收录</strong><p>技术或二进制内容暂不作为主要人工审阅内容。</p></div>}</div> : <section className="case-library skills-case-library" role="tabpanel" aria-label="案例"><div className="case-upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}><UploadIcon /><h2>上传案例文件</h2><p>历史方案、投标成果、图片或办公文档会保存为团队参考资料。</p><button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? "正在上传…" : "选择文件"}</button><input ref={fileInput} type="file" multiple hidden accept=".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={handleInput} /><small>支持图片、PDF、Word、Excel、PowerPoint；单个文件不超过 50 MB</small></div>{uploadError && <p className="library-error" role="alert">{uploadError}</p>}{caseFiles.length > 0 && <div className="case-file-list"><h3>本次上传</h3>{caseFiles.map((file) => <div key={file.id}><CheckIcon /><span><strong>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB · 已保存到案例库</small></span></div>)}</div>}</section>}
      </section>

      {editing && <aside className="skills-context-panel" aria-label="编辑审阅"><div className="skills-context-heading"><strong>编辑审阅</strong><button className="icon-button" type="button" onClick={() => setEditing(false)} aria-label="关闭编辑审阅"><ChevronRight /></button></div><div className="skills-draft-context"><div className="skill-panel-label"><span>待提交修改</span><small>{changes.length} 个文件</small></div>{changes.length === 0 ? <p>在中央编辑器中修改文件后，改动会出现在这里。</p> : <div className="change-list">{changes.map((change) => <span key={change.path}><i />{change.path}</span>)}</div>}<button className="draft-submit" type="button" disabled={!changes.length || submitting} onClick={() => void submitDraft()}>{submitting ? "正在创建…" : "创建 Draft PR"}</button>{pullRequest && <a className="draft-success" href={pullRequest.url} target="_blank" rel="noreferrer"><CheckIcon /><span><strong>Draft PR #{pullRequest.number} 已创建</strong><small>{pullRequest.branch}</small></span></a>}{skillError && selectedDetail && <div className="draft-error" role="alert">{skillError}</div>}</div></aside>}
    </main>
  );
}
