"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { getSkillDetail, uploadCaseFile, type SkillDetail, type UploadedFile } from "@/lib/api";
import { skills } from "@/lib/workspace-data";
import { CheckIcon, FolderIcon, UploadIcon } from "./icons";
import { SkillFileTree } from "./skill-file-tree";

type LibraryTab = "skills" | "cases";

export function LibraryWorkspace() {
  const router = useRouter();
  const [tab, setTab] = useState<LibraryTab>("skills");
  const [selectedSlug, setSelectedSlug] = useState<string>(skills[0].slug);
  const [details, setDetails] = useState<Record<string, SkillDetail>>({});
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [caseFiles, setCaseFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(skills.map((skill) => getSkillDetail(skill.slug)))
      .then((items) => {
        if (!cancelled) setDetails(Object.fromEntries(items.map((item) => [item.slug, item])));
      })
      .catch((reason: Error) => { if (!cancelled) setSkillError(reason.message); })
      .finally(() => { if (!cancelled) setLoadingSkills(false); });
    return () => { cancelled = true; };
  }, []);

  async function uploadFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await Promise.all(selected.map(uploadCaseFile));
      setCaseFiles((current) => [...uploaded, ...current]);
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : "案例上传失败");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void uploadFiles(event.target.files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void uploadFiles(event.dataTransfer.files);
  }

  const selectedSkill = skills.find((skill) => skill.slug === selectedSlug) ?? skills[0];
  const selectedDetail = details[selectedSkill.slug];

  return (
    <main className="skills-page">
      <header className="skills-intro">
        <p className="eyebrow">CASES &amp; SKILLS</p>
        <h1>案例 / 技能库</h1>
        <p>技能沉淀团队方法与执行规则；案例保留可复用的项目资料。两者分开管理，在业务流程中按需调用。</p>
      </header>

      <div className="library-tabs" role="tablist" aria-label="案例与技能">
        <button className={tab === "skills" ? "is-active" : ""} role="tab" aria-selected={tab === "skills"} type="button" onClick={() => setTab("skills")}>
          技能 <span>{skills.length}</span>
        </button>
        <button className={tab === "cases" ? "is-active" : ""} role="tab" aria-selected={tab === "cases"} type="button" onClick={() => setTab("cases")}>
          案例 <span>{caseFiles.length}</span>
        </button>
      </div>

      {tab === "skills" ? (
        <div className="library-skill-layout" role="tabpanel" aria-label="技能">
          <section className="library-skill-browser">
            <header>
              <div><p className="skill-browser-category">{selectedSkill.category}</p><h2>{selectedSkill.name}</h2><code>skills/{selectedSkill.slug}</code></div>
              <Link href={`/skills/${selectedSkill.slug}`}>查看并编辑</Link>
            </header>
            <div className="skill-browser-note"><FolderIcon /><p>完整文件目录</p><span>闭眼图标表示技术文件，不作为主要人工审阅内容。</span></div>
            {loadingSkills && <p className="library-loading">正在读取技能目录…</p>}
            {skillError && <p className="library-error" role="alert">{skillError}。请确认 API 服务已启动。</p>}
            {selectedDetail && <SkillFileTree files={selectedDetail.files} onSelect={() => router.push(`/skills/${selectedSkill.slug}`)} />}
          </section>

          <aside className="skill-selector" aria-label="选择技能">
            <header><strong>选择技能</strong><span>{skills.length}</span></header>
            {skills.map((skill, index) => (
              <button className={skill.slug === selectedSkill.slug ? "is-active" : ""} key={skill.slug} type="button" onClick={() => setSelectedSlug(skill.slug)}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><small>{skill.category}</small><strong>{skill.name}</strong><code>{details[skill.slug]?.files.length ?? "—"} 个文件</code></div>
              </button>
            ))}
          </aside>
        </div>
      ) : (
        <section className="case-library" role="tabpanel" aria-label="案例">
          <div className="case-upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
            <UploadIcon />
            <h2>上传案例文件</h2>
            <p>将历史方案、投标成果、图片或办公文档拖到这里，作为后续项目的参考资料。</p>
            <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? "正在上传…" : "选择文件"}</button>
            <input ref={fileInput} type="file" multiple hidden accept=".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={handleInput} />
            <small>支持图片、PDF、Word、Excel、PowerPoint；单个文件不超过 50 MB</small>
          </div>
          {uploadError && <p className="library-error" role="alert">{uploadError}</p>}
          {caseFiles.length > 0 && (
            <div className="case-file-list">
              <h3>本次上传</h3>
              {caseFiles.map((file) => <div key={file.id}><CheckIcon /><span><strong>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB · 已保存到案例库</small></span></div>)}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
