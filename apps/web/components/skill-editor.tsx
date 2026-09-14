"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createSkillDraftPullRequest,
  getSkillDetail,
  getSkillFileUrl,
  type DraftPullRequest,
  type SkillDetail,
  type SkillFile,
} from "@/lib/api";
import { AppHeader } from "./app-header";
import { BranchIcon, CheckIcon, ChevronLeft, EditIcon, EyeOffIcon } from "./icons";
import { SkillFileTree } from "./skill-file-tree";

function fileLabel(file: SkillFile) {
  return file.path.split("/").pop() ?? file.path;
}

export function SkillEditor({ slug, name, category }: { slug: string; name: string; category: string }) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(`docs(skills): update ${name}`);
  const [description, setDescription] = useState("通过 ArchFlow 技能编辑器提交，请审阅内容和流程变更。");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pullRequest, setPullRequest] = useState<DraftPullRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSkillDetail(slug)
      .then((detail) => {
        if (!cancelled) setSkill(detail);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [slug]);

  const selectedFile = skill?.files.find((file) => file.path === selectedPath) ?? null;
  const currentContent = selectedFile?.editable
    ? drafts[selectedPath] ?? selectedFile.content ?? ""
    : "";
  const changes = useMemo(() => {
    if (!skill) return [];
    return Object.entries(drafts)
      .filter(([path, content]) => content !== (skill.files.find((file) => file.path === path)?.content ?? ""))
      .map(([path, content]) => ({ path, content }));
  }, [drafts, skill]);

  function selectFile(path: string) {
    setSelectedPath(path);
    setEditing(false);
    setError(null);
  }

  async function submitDraft() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await createSkillDraftPullRequest(slug, { title, description, changes });
      setPullRequest(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Draft PR 创建失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell skill-editor-shell">
      <AppHeader active="skills" />
      <div className="skill-editor-heading">
        <div className="skill-editor-title">
          <Link href="/skills" aria-label="返回技能库"><ChevronLeft /></Link>
          <div><p className="eyebrow">{category} · SKILL WORKSPACE</p><h1>{name}</h1></div>
        </div>
        <div className="editor-heading-actions">
          <span>{changes.length} 个文件有改动</span>
          <button type="button" disabled={!selectedFile?.editable} onClick={() => setEditing((value) => !value)}>
            <EditIcon />{editing ? "预览" : "编辑"}
          </button>
        </div>
      </div>

      <main className="skill-editor-grid">
        <aside className="skill-files-panel">
          <div className="skill-panel-label"><span>全部内容</span><small>{skill?.files.length ?? 0} 个文件</small></div>
          {loading && <p className="skill-loading">正在读取技能内容…</p>}
          {skill && <SkillFileTree files={skill.files} selectedPath={selectedPath} changedPaths={changes.map((change) => change.path)} onSelect={(file) => selectFile(file.path)} />}
        </aside>

        <section className="skill-document-panel">
          <header className="document-toolbar">
            <div><strong>{selectedFile ? fileLabel(selectedFile) : "技能内容"}</strong><span>{selectedFile?.path}</span></div>
            {selectedFile && <span className="file-mode">{selectedFile.editable ? (editing ? "编辑模式" : "可编辑") : "只读素材"}</span>}
          </header>

          {error && !skill && <div className="skill-error"><strong>无法读取技能内容</strong><p>{error}</p><p>请确认 FastAPI 服务已在 localhost:8000 运行。</p></div>}
          {selectedFile?.editable && editing && (
            <textarea
              className="skill-source-editor"
              aria-label={`编辑 ${selectedFile.path}`}
              value={currentContent}
              spellCheck={false}
              onChange={(event) => setDrafts((current) => ({ ...current, [selectedPath]: event.target.value }))}
            />
          )}
          {selectedFile?.kind === "markdown" && !editing && (
            <article className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]}>{currentContent}</ReactMarkdown></article>
          )}
          {selectedFile?.kind === "code" && !editing && <pre className="code-document"><code>{currentContent}</code></pre>}
          {selectedFile?.kind === "image" && (
            <div className="skill-image-preview"><img src={getSkillFileUrl(slug, selectedFile.path)} alt={fileLabel(selectedFile)} /><p>{selectedFile.path}</p></div>
          )}
          {selectedFile?.kind === "binary" && <div className="skill-empty-file"><EyeOffIcon /><strong>该文件已收录</strong><p>技术或二进制内容暂不作为主要人工审阅内容。</p></div>}
        </section>

        <aside className="draft-panel">
          <div className="skill-panel-label"><span>提交审阅</span><small>GitHub Draft PR</small></div>
          <div className="draft-explanation"><BranchIcon /><p>修改不会直接写入主分支。提交后会创建独立分支和 Draft PR，等待维护者审阅。</p></div>
          <label>PR 标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>变更说明<textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} /></label>

          <div className="change-list">
            <strong>待提交修改</strong>
            {changes.length === 0 ? <p>编辑文件后，改动会出现在这里。</p> : changes.map((change) => <span key={change.path}><i />{change.path}</span>)}
          </div>

          <button className="draft-submit" type="button" disabled={changes.length === 0 || submitting} onClick={() => void submitDraft()}>
            <BranchIcon />{submitting ? "正在创建…" : "创建 Draft PR"}
          </button>
          <p className="github-auth-note">由 ArchFlow 的 GitHub 集成提交，普通编辑者不需要 GitHub 账号。</p>

          {error && skill && <div className="draft-error" role="alert">{error}</div>}
          {pullRequest && (
            <a className="draft-success" href={pullRequest.url} target="_blank" rel="noreferrer">
              <CheckIcon /><span><strong>Draft PR #{pullRequest.number} 已创建</strong><small>{pullRequest.branch}</small></span>
            </a>
          )}
        </aside>
      </main>
    </div>
  );
}
