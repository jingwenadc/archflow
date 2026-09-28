"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import {
  createConversation,
  getConversations,
  getMessages,
  getProjectFiles,
  sendMessage,
  uploadProjectFile,
  type Conversation,
  type Message,
  type UploadedFile,
} from "@/lib/api";
import { type WorkspaceModule } from "@/lib/workspace-data";
import { AppHeader } from "./app-header";
import { GenerationPanel } from "./generation-panel";
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

const allowedExtensions = new Set(["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "file";
}

function toFileItem(file: UploadedFile): FileItem {
  return {
    id: file.id,
    name: file.name,
    detail: `${formatBytes(file.size)} · 已上传`,
    kind: extensionOf(file.name).toUpperCase(),
    status: "ready",
  };
}

export function WorkspaceShell({ module }: { module: WorkspaceModule }) {
  const [leftWidth, setLeftWidth] = useState(264);
  const [rightWidth, setRightWidth] = useState(460);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [projectId, setProjectId] = useState("cold-chain-industrial-park");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [draft, setDraft] = useState("");
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
    const saved = window.localStorage.getItem("archflow.active-project");
    if (saved) setProjectId(saved);
    const onChange = (event: Event) => setProjectId((event as CustomEvent<string>).detail);
    window.addEventListener("archflow:project-changed", onChange);
    return () => window.removeEventListener("archflow:project-changed", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    getProjectFiles(projectId)
      .then((items) => {
        if (!cancelled) setFiles(items.map(toFileItem));
      })
      .catch((reason: Error) => {
        if (!cancelled) setNotice(reason.message);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingConversations(true);
    setConversations([]);
    setActiveConversationId(null);
    setMessages([]);
    setDraft("");
    getConversations(projectId, module.key)
      .then((items) => {
        if (cancelled) return;
        setConversations(items);
        setActiveConversationId(items[0]?.id ?? null);
      })
      .catch((reason: Error) => {
        if (!cancelled) setNotice(reason.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingConversations(false);
      });
    return () => { cancelled = true; };
  }, [module.key, projectId]);

  useEffect(() => {
    let cancelled = false;
    if (!activeConversationId) {
      setLoadingMessages(false);
      setMessages([]);
      return;
    }
    setLoadingMessages(true);
    setMessages([]);
    getMessages(activeConversationId)
      .then((items) => {
        if (!cancelled) setMessages(items);
      })
      .catch((reason: Error) => {
        if (!cancelled) setNotice(reason.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => { cancelled = true; };
  }, [activeConversationId]);

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

  async function addConversation() {
    if (creatingConversation) return;
    setCreatingConversation(true);
    try {
      const defaultTitle = module.conversations[conversations.length]
        ?? `${module.label}对话 ${conversations.length + 1}`;
      const conversation = await createConversation(projectId, module.key, defaultTitle);
      setConversations((current) => [conversation, ...current]);
      setActiveConversationId(conversation.id);
      announce("已新建对话");
    } catch (reason) {
      announce(reason instanceof Error ? reason.message : "新建对话失败");
    } finally {
      setCreatingConversation(false);
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!activeConversationId || !content || sendingMessage) return;
    setSendingMessage(true);
    try {
      const message = await sendMessage(activeConversationId, content);
      setMessages((current) => [...current, message]);
      setDraft("");
    } catch (reason) {
      announce(reason instanceof Error ? reason.message : "消息发送失败");
    } finally {
      setSendingMessage(false);
    }
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
        const uploaded = await uploadProjectFile(file, projectId);
        setFiles((current) => current.map((item) => item.id === temporaryId
          ? toFileItem(uploaded)
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
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

  return (
    <div className="app-shell workspace-shell">
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
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={activeConversationId === conversation.id ? "conversation-tab is-active" : "conversation-tab"}
                type="button"
                role="tab"
                aria-selected={activeConversationId === conversation.id}
                onClick={() => setActiveConversationId(conversation.id)}
              >
                <span>{conversation.title}</span>
              </button>
            ))}
            <button className="new-conversation" type="button" disabled={creatingConversation} onClick={() => void addConversation()}>
              <PlusIcon /><span>{creatingConversation ? "创建中…" : "新建对话"}</span>
            </button>
          </div>

          <div className="conversation-heading">
            <div>
              <p className="eyebrow">{module.eyebrow}</p>
              <h1>{activeConversation?.title ?? module.label}</h1>
            </div>
            <span className="disabled-status"><i />对话已保存 · AI 回复待接入</span>
          </div>

          <div className="chat-thread">
            {loadingConversations || loadingMessages ? (
              <div className="chat-empty"><strong>正在读取项目对话…</strong></div>
            ) : !activeConversation ? (
              <div className="chat-empty"><strong>还没有对话</strong><p>新建一个对话，消息会保存在当前项目中。</p></div>
            ) : messages.length === 0 ? (
              <div className="chat-empty"><strong>开始这段对话</strong><p>你可以先描述目标或引用左侧的项目资料。AI 回复将在模型接入后开放。</p></div>
            ) : (
              <>
                <div className="thread-date"><span>项目对话</span></div>
                {messages.map((message) => message.role === "user" ? (
                  <div className="message-row user-message" key={message.id}>
                    <div className="message-bubble"><p>{message.content}</p></div>
                    <span className="message-avatar user-avatar">我</span>
                  </div>
                ) : (
                  <div className="message-row assistant-message" key={message.id}>
                    <span className="message-avatar archflow-avatar">AF</span>
                    <div className="message-stack">
                      <div className="message-bubble"><p>{message.content}</p></div>
                      <span className="message-meta">ArchFlow</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="composer-area">
            <div className="composer-disabled-note">文字消息会保存到项目；自动对话尚未接入。生成任务请使用右侧成果区。</div>
            <form className="composer-shell" onSubmit={(event) => void submitMessage(event)}>
              <button type="button" disabled aria-label="添加附件" title="请从左侧上传项目资料"><PaperclipIcon /></button>
              <textarea
                rows={2}
                value={draft}
                disabled={!activeConversation || sendingMessage}
                placeholder={activeConversation ? "输入要求，或引用项目资料…" : "请先新建对话"}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button className="send-button" type="submit" disabled={!activeConversation || !draft.trim() || sendingMessage} aria-label="发送消息"><SendIcon /></button>
            </form>
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

              <GenerationPanel projectId={projectId} conversationId={activeConversationId} module={module.key} />
            </>
          )}
        </aside>
      </main>

      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
