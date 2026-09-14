"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { uploadProjectFile } from "@/lib/api";
import { type WorkspaceModule } from "@/lib/workspace-data";
import { AppHeader } from "./app-header";
import {
  ChevronLeft,
  ChevronRight,
  FileIcon,
  MoreIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  UploadIcon,
} from "./icons";

type FileItem = {
  id: string;
  name: string;
  detail: string;
  kind: string;
  status?: "uploading" | "ready" | "local" | "error";
};

const initialFiles: FileItem[] = [
  { id: "sample-brief", name: "设计任务书.pdf", detail: "2.8 MB · 示例文件", kind: "PDF", status: "ready" },
  { id: "sample-site", name: "场地航拍图.jpg", detail: "4.1 MB · 示例文件", kind: "JPG", status: "ready" },
];

const allowedExtensions = new Set(["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "file";
}

export function WorkspaceShell({ module }: { module: WorkspaceModule }) {
  const [leftWidth, setLeftWidth] = useState(264);
  const [rightWidth, setRightWidth] = useState(460);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [activeConversation, setActiveConversation] = useState(0);
  const [files, setFiles] = useState(initialFiles);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("archflow-workspace");
    const compactLayout = window.matchMedia("(max-width: 1000px)").matches;
    let state: Partial<{ leftWidth: number; rightWidth: number; leftCollapsed: boolean; rightCollapsed: boolean }> = {};

    if (saved) {
      try {
        state = JSON.parse(saved);
      } catch {
        window.localStorage.removeItem("archflow-workspace");
      }
    }

    if (typeof state.leftWidth === "number") setLeftWidth(state.leftWidth);
    if (typeof state.rightWidth === "number") setRightWidth(state.rightWidth);
    setLeftCollapsed(compactLayout ? true : state.leftCollapsed ?? false);
    setRightCollapsed(compactLayout ? true : state.rightCollapsed ?? false);
    setHydrated(true);
  }, []);

  useEffect(() => {
    const compactLayout = window.matchMedia("(max-width: 1000px)");
    const collapsePanels = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setLeftCollapsed(true);
        setRightCollapsed(true);
      }
    };
    compactLayout.addEventListener("change", collapsePanels);
    return () => compactLayout.removeEventListener("change", collapsePanels);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem("archflow-workspace", JSON.stringify({ leftWidth, rightWidth, leftCollapsed, rightCollapsed }));
  }, [hydrated, leftWidth, rightWidth, leftCollapsed, rightCollapsed]);

  useEffect(() => {
    setActiveConversation(0);
  }, [module.key]);

  function resizePanel(side: "left" | "right", event: PointerEvent<HTMLButtonElement>) {
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    event.currentTarget.setPointerCapture(event.pointerId);

    function onMove(moveEvent: globalThis.PointerEvent) {
      const delta = moveEvent.clientX - startX;
      if (side === "left") setLeftWidth(Math.min(380, Math.max(220, startWidth + delta)));
      else setRightWidth(Math.min(620, Math.max(360, startWidth - delta)));
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function announce(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2600);
  }

  async function addFiles(selected: FileList | File[]) {
    for (const file of Array.from(selected)) {
      const ext = extensionOf(file.name);
      if (!allowedExtensions.has(ext)) {
        announce(`${file.name} 暂不支持。第一版不接收 CAD、DXF、SketchUp 或 PKPM 文件。`);
        continue;
      }

      const temporaryId = `upload-${crypto.randomUUID()}`;
      setFiles((current) => [
        { id: temporaryId, name: file.name, detail: `${formatBytes(file.size)} · 正在上传`, kind: ext.toUpperCase(), status: "uploading" },
        ...current,
      ]);

      try {
        const uploaded = await uploadProjectFile(file);
        setFiles((current) => current.map((item) => item.id === temporaryId
          ? { ...item, id: uploaded.id, detail: `${formatBytes(uploaded.size)} · 已上传`, status: "ready" }
          : item));
        announce(`${file.name} 已上传`);
      } catch {
        setFiles((current) => current.map((item) => item.id === temporaryId
          ? { ...item, detail: `${formatBytes(file.size)} · 本地界面预览`, status: "local" }
          : item));
        announce("后端未连接，文件仅显示在本地界面中。");
      }
    }
  }

  const workspaceStyle = {
    "--left-width": leftCollapsed ? "48px" : `${leftWidth}px`,
    "--right-width": rightCollapsed ? "48px" : `${rightWidth}px`,
  } as CSSProperties;

  return (
    <div className="app-shell">
      <AppHeader active={module.key} />

      <main className="workspace-grid" style={workspaceStyle}>
        <aside className={leftCollapsed ? "side-panel resource-panel is-collapsed" : `side-panel resource-panel${hydrated ? " is-expanded" : ""}`} aria-label="项目资料">
          {leftCollapsed ? (
            <button className="rail-button" type="button" onClick={() => setLeftCollapsed(false)} aria-label="展开项目资料">
              <FileIcon /><ChevronRight />
            </button>
          ) : (
            <>
              <div className="panel-title-row">
                <div><p className="eyebrow">PROJECT RESOURCES</p><h2>项目资料</h2></div>
                <button className="icon-button" type="button" onClick={() => setLeftCollapsed(true)} aria-label="收起项目资料"><ChevronLeft /></button>
              </div>

              <label
                className="upload-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files); }}
              >
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                  onChange={(event) => event.target.files && void addFiles(event.target.files)}
                />
                <UploadIcon />
                <strong>上传项目资料</strong>
                <span>图片、PDF、Word、Excel、PPT</span>
              </label>

              <div className="resource-section-heading">
                <span>当前项目</span><button type="button" aria-label="项目资料操作"><MoreIcon /></button>
              </div>
              <div className="file-list">
                {files.map((file) => (
                  <button className="file-row" type="button" key={file.id}>
                    <span className={`file-kind file-kind-${file.kind.toLowerCase()}`}>{file.kind.slice(0, 4)}</span>
                    <span className="file-details"><strong>{file.name}</strong><small>{file.detail}</small></span>
                    {file.status === "uploading" && <span className="loading-dot" aria-label="上传中" />}
                  </button>
                ))}
              </div>

              <p className="file-support-note">CAD、DXF、SketchUp 与 PKPM 文件将在后续版本接入。</p>
            </>
          )}
        </aside>

        <button className="resize-handle" type="button" onPointerDown={(event) => resizePanel("left", event)} aria-label="调整项目资料宽度" />

        <section className="conversation-panel" aria-label="项目对话">
          <div className="mobile-panel-controls">
            <button type="button" onClick={() => setLeftCollapsed(false)}><FileIcon />资料</button>
            <button type="button" onClick={() => setRightCollapsed(false)}>成果<ChevronRight /></button>
          </div>

          <div className="conversation-tabs" role="tablist" aria-label={`${module.label}对话`}>
            {module.conversations.map((conversation, index) => (
              <button
                key={conversation}
                className={activeConversation === index ? "conversation-tab is-active" : "conversation-tab"}
                type="button"
                role="tab"
                aria-selected={activeConversation === index}
                onClick={() => setActiveConversation(index)}
              >
                <span>{conversation}</span>
                {index === 0 && <i>示例</i>}
              </button>
            ))}
            <button className="new-conversation" type="button" disabled title="新建对话将在 AI 服务接入后开放"><PlusIcon /><span>新建对话</span></button>
          </div>

          <div className="conversation-heading">
            <div>
              <p className="eyebrow">{module.eyebrow}</p>
              <h1>{module.conversations[activeConversation]}</h1>
            </div>
            <span className="disabled-status"><i />AI 功能待接入</span>
          </div>

          <div className="chat-thread">
            <div className="thread-date"><span>界面对话示例</span></div>
            <div className="message-row user-message">
              <div className="message-bubble"><p>{module.userExample}</p></div>
              <span className="message-avatar user-avatar">我</span>
            </div>
            <div className="message-row assistant-message">
              <span className="message-avatar archflow-avatar">AF</span>
              <div className="message-stack">
                <div className="message-bubble"><p>{module.assistantExample}</p></div>
                <span className="message-meta">ArchFlow · 静态示例</span>
              </div>
            </div>
          </div>

          <div className="composer-area">
            <div className="composer-disabled-note">对话、生成和技能调用将在后端工作流确定后接入。</div>
            <div className="composer-shell is-disabled" aria-disabled="true">
              <button type="button" disabled aria-label="添加附件"><PaperclipIcon /></button>
              <textarea disabled rows={2} placeholder="输入要求，或引用项目资料…" />
              <button className="send-button" type="button" disabled aria-label="发送消息"><SendIcon /></button>
            </div>
            <p className="professional-note">AI 生成内容需由设计师或相应专业工程师复核</p>
          </div>
        </section>

        <button className="resize-handle" type="button" onPointerDown={(event) => resizePanel("right", event)} aria-label="调整成果预览宽度" />

        <aside className={rightCollapsed ? "side-panel output-panel is-collapsed" : `side-panel output-panel${hydrated ? " is-expanded" : ""}`} aria-label="成果预览">
          {rightCollapsed ? (
            <button className="rail-button" type="button" onClick={() => setRightCollapsed(false)} aria-label="展开成果预览">
              <ChevronLeft /><span className="vertical-label">成果</span>
            </button>
          ) : (
            <>
              <div className="panel-title-row output-title-row">
                <div><p className="eyebrow">CURRENT OUTPUT</p><h2>{module.previewTitle}</h2></div>
                <button className="icon-button" type="button" onClick={() => setRightCollapsed(true)} aria-label="收起成果预览"><ChevronRight /></button>
              </div>

              <div className="output-empty">
                <div className={`output-glyph output-glyph-${module.key}`} aria-hidden="true">
                  <span /><span /><span />
                </div>
                <p className="output-state">尚未生成</p>
                <h3>{module.previewTitle}将在这里出现</h3>
                <p>{module.previewDescription}</p>
              </div>

              <ol className="recommended-flow">
                {module.workflow.map((step, index) => (
                  <li key={step}><span>{String(index + 1).padStart(2, "0")}</span><p>{step}</p></li>
                ))}
              </ol>

              <button className="disabled-primary" type="button" disabled>生成能力尚未连接</button>
            </>
          )}
        </aside>
      </main>

      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
