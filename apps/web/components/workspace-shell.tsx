"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import {
  createConversation,
  getConversations,
  getMessages,
  getProjectFiles,
  sendMessage,
  uploadProjectFile,
  apiRequest,
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
  processing?: UploadedFile["processing_status"];
  role?: UploadedFile["role"];
  error?: string | null;
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
    detail: `${formatBytes(file.size)} · ${{ queued: "等待解析", processing: "正在解析", ready: `已解析 ${file.page_count} 页`, failed: "解析失败" }[file.processing_status ?? "queued"]}`,
    kind: extensionOf(file.name).toUpperCase(),
    status: "ready",
    processing: file.processing_status,
    role: file.role,
    error: file.processing_error,
  };
}

export function WorkspaceShell({ module }: { module: WorkspaceModule }) {
  const [leftWidth, setLeftWidth] = useState(264);
  const [rightWidth, setRightWidth] = useState(460);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [outputMount, setOutputMount] = useState<HTMLDivElement | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
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
  const scopeKey = `${projectId}:${module.key}:${activeConversationId}`;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const pendingFiles = useRef(new Map<string, File>());
  const pendingMessage = useRef<{ content: string; conversation: string; id: string } | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  useEffect(() => {
    if (followMessages.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages, sendingMessage]);

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
    setRightCollapsed(true);
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
    if (!files.some(file => file.status === "ready" && ["queued", "processing"].includes(file.processing ?? ""))) return;
    let cancelled = false;
    const timer = setTimeout(() => { getProjectFiles(projectId).then(items => { if (!cancelled) setFiles(current => [...current.filter(file => file.status !== "ready"), ...items.map(toFileItem)]); }).catch(() => {}); }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [files, projectId]);

  useEffect(() => { setRightCollapsed(true); setEditingTitle(false); }, [activeConversationId, projectId]);

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
    const scope = currentScope.current;
    try {
      const defaultTitle = "新对话";
      const conversation = await createConversation(projectId, module.key, defaultTitle);
      if (currentScope.current !== scope) return;
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
    if (!content || sendingMessage) return;
    const scope = currentScope.current;
    setSendingMessage(true);
    followMessages.current = true;
    try {
      let conversationId = activeConversationId;
      if (!conversationId) {
        const created = await createConversation(projectId, module.key, "新对话");
        if (currentScope.current !== scope) return;
        conversationId = created.id;
        setConversations(items => [created, ...items]); setActiveConversationId(created.id);
      }
      const targetScope = `${projectId}:${module.key}:${conversationId}`;
      const isCurrent = () => currentScope.current === targetScope || (!activeConversationId && currentScope.current === scope);
      if (pendingMessage.current?.content !== content || pendingMessage.current.conversation !== conversationId) pendingMessage.current = { content, conversation: conversationId, id: crypto.randomUUID() };
      await sendMessage(conversationId, content, pendingMessage.current.id);
      const saved = await getMessages(conversationId);
      if (!isCurrent()) return;
      setMessages(saved);
      const refreshed = await getConversations(projectId, module.key);
      if (!isCurrent()) return;
      setConversations(refreshed);
      pendingMessage.current = null;
      setDraft("");
    } catch (reason) {
      announce(reason instanceof Error ? reason.message : "消息发送失败");
    } finally {
      setSendingMessage(false);
    }
  }

  async function addFiles(selected: FileList | File[]) {
    const scope = currentScope.current;
    for (const file of Array.from(selected)) {
      const ext = extensionOf(file.name);
      if (!allowedExtensions.has(ext)) {
        announce(`${file.name} 暂不支持。第一版不接收 CAD、DXF、SketchUp 或 PKPM 文件。`);
        continue;
      }

      const temporaryId = `upload-${crypto.randomUUID()}`;
      pendingFiles.current.set(temporaryId, file);
      setFiles((current) => [
        { id: temporaryId, name: file.name, detail: `${formatBytes(file.size)} · 正在上传`, kind: ext.toUpperCase(), status: "uploading" },
        ...current,
      ]);

      try {
        const uploaded = await uploadProjectFile(file, projectId);
        if (currentScope.current.split(":")[0] !== scope.split(":")[0]) return;
        setFiles((current) => current.map((item) => item.id === temporaryId
          ? toFileItem(uploaded)
          : item));
        announce(`${file.name} 已上传`);
        pendingFiles.current.delete(temporaryId);
      } catch (cause) {
        setFiles((current) => current.map((item) => item.id === temporaryId
          ? { ...item, detail: `${formatBytes(file.size)} · 上传失败`, status: "error", error: cause instanceof Error ? cause.message : "上传失败，请重试。" }
          : item));
        announce(cause instanceof Error ? cause.message : "上传失败，请重试。");
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
                <span>当前项目 · 对话共享</span>
              </div>
              <div className="file-list">
                {files.map((file) => (
                  <div className="file-row" key={file.id}>
                    <span className={`file-kind file-kind-${file.kind.toLowerCase()}`}>{file.kind.slice(0, 4)}</span>
                    <span className="file-details"><strong>{file.name}</strong><small>{file.detail}</small>
                      {file.status === "ready" && <select aria-label={`${file.name}的资料角色`} value={file.role ?? "source"} onChange={async event => { try { await apiRequest(`/api/v1/files/${file.id}/role?project_id=${encodeURIComponent(projectId)}&role=${event.target.value}`, { method: "POST" }); setFiles((await getProjectFiles(projectId)).map(toFileItem)); } catch { announce("资料角色未保存，请重试。"); } }}><option value="source">当前项目资料</option><option value="reference">参考案例 / 风格</option><option value="image">项目图片</option><option value="excluded">暂不使用</option></select>}
                      {file.error && <small className="generation-error">{file.error}</small>}
                      {file.status === "error" && <button type="button" onClick={() => { const original = pendingFiles.current.get(file.id); if (original) { setFiles(items => items.filter(item => item.id !== file.id)); void addFiles([original]); } }}>重试上传</button>}
                      {file.processing === "failed" && <button type="button" onClick={async () => { try { await apiRequest(`/api/v1/files/${file.id}/retry?project_id=${encodeURIComponent(projectId)}`, { method: "POST" }); setFiles((await getProjectFiles(projectId)).map(toFileItem)); } catch { announce("解析重试失败，请稍后再试。"); } }}>重新解析</button>}
                      {file.status === "ready" && <a href={`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/v1/files/${file.id}/original?project_id=${encodeURIComponent(projectId)}`} target="_blank" rel="noreferrer">查看原文件</a>}
                    </span>
                    {file.status === "uploading" && <span className="loading-dot" aria-label="上传中" />}
                  </div>
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
              {editingTitle ? <form onSubmit={async event => { event.preventDefault(); if (!activeConversationId) return; try { await apiRequest(`/api/v1/conversations/${activeConversationId}/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: titleDraft }) }); setConversations(items => items.map(item => item.id === activeConversationId ? { ...item, title: titleDraft } : item)); setEditingTitle(false); } catch { announce("标题未保存，请重试。"); } }}><input aria-label="对话名称" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={120} /><button>保存</button><button type="button" onClick={() => setEditingTitle(false)}>取消</button></form> : <h1><button className="title-edit-button" onClick={() => { setTitleDraft(activeConversation?.title ?? "新对话"); setEditingTitle(true); }} disabled={!activeConversation}>{activeConversation?.title ?? module.label}</button></h1>}
            </div>
            <span className="disabled-status"><i />项目资料共享 · 对话自动保存</span>
          </div>

          <div className="chat-thread" ref={thread} onScroll={event => { const element = event.currentTarget; followMessages.current = element.scrollHeight-element.scrollTop-element.clientHeight < 100; }}>
            {loadingConversations || loadingMessages ? (
              <div className="chat-empty"><strong>正在读取项目对话…</strong></div>
            ) : !activeConversation ? (
              <div className="chat-empty"><strong>你想完成什么？</strong><p>在左侧上传任务书、参考 PPT 或图片，然后在下方描述要求。发送第一条消息时会自动新建对话。</p></div>
            ) : messages.length === 0 ? (
              <div className="chat-empty"><strong>开始这段对话</strong><p>描述目标即可，例如“参考项目资料，制作 10 页甲方汇报 PPT”。我会先整理提纲，确认后再展开。</p></div>
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
            {sendingMessage && <div className="message-row assistant-message" role="status"><span className="message-avatar archflow-avatar">AF</span><p>正在保存并接收你的要求…</p></div>}
            <GenerationPanel projectId={projectId} conversationId={activeConversationId} module={module.key} messages={messages} outputMount={outputMount} onOutputAvailable={() => setRightCollapsed(false)} materialsReady={files.every(file => file.role === "excluded" || (file.status === "ready" && file.processing === "ready"))} />
          </div>

          <div className="composer-area">
            <div className="composer-disabled-note">项目资料在左侧上传一次即可共享；在这里描述需求或修改成果。</div>
            <form className="composer-shell" onSubmit={(event) => void submitMessage(event)}>
              <textarea
                rows={2}
                value={draft}
                disabled={sendingMessage}
                placeholder="描述需求、补充条件或修改指定页…"
                onChange={(event) => setDraft(event.target.value)}
              />
              <button className="send-button" type="submit" disabled={!draft.trim() || sendingMessage} aria-label={sendingMessage ? "正在发送" : "发送消息"}>{sendingMessage ? "…" : <SendIcon />}</button>
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

              <div ref={setOutputMount} />
            </>
          )}
        </aside>
      </main>

      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
