"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiRequest, getProjects, type Conversation, type Message, type Project, type TrashedConversation } from "@/lib/api";

type User = { id: string; username: string; role: string; created_at: number };
type Job = { id: string; conversation_id: string | null; status: string; stage: string; goal: string; model: string; created_at: string };
type Call = { call_id: string; model: string; total_tokens: number | null };

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<User[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [trash, setTrash] = useState<TrashedConversation[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [moreMessages, setMoreMessages] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [moreCalls, setMoreCalls] = useState(false);
  const [trace, setTrace] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const currentConversation = useRef<string | null>(null);
  const currentJob = useRef<string | null>(null);
  currentConversation.current = conversation?.id ?? null;
  currentJob.current = job?.id ?? null;

  useEffect(() => {
    let alive = true;
    Promise.all([apiRequest<{ role: string }>("/api/v1/auth/me"), apiRequest<User[]>("/api/v1/admin/users"), getProjects()])
      .then(([me, people, items]) => { if (!alive) return; if (me.role !== "admin") throw new Error("仅管理员可访问。"); setUsers(people); setProjects(items); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "读取失败"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    setConversations([]); setTrash([]); setMembers([]); setConversation(null); setJobs([]); setJob(null); setTrace(null);
    apiRequest<User[]>(`/api/v1/admin/projects/${project.id}/members`)
      .then(items => { if (alive) setMembers(items); })
      .catch(cause => { if (alive) setError(String(cause)); });
    Promise.all(["concept", "bid", "drawing"].map(module => apiRequest<Conversation[]>(`/api/v1/conversations?project_id=${encodeURIComponent(project.id)}&module=${module}`)))
      .then(groups => { if (alive) setConversations(groups.flat()); })
      .catch(cause => { if (alive) setError(String(cause)); });
    apiRequest<Job[]>(`/api/v1/jobs?project_id=${encodeURIComponent(project.id)}`)
      .then(items => { if (alive) setJobs(items); })
      .catch(cause => { if (alive) setError(String(cause)); });
    apiRequest<TrashedConversation[]>(`/api/v1/projects/${project.id}/trash`)
      .then(items => { if (alive) setTrash(items); })
      .catch(cause => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [project]);
  useEffect(() => {
    if (!conversation) return;
    let alive = true;
    setMessages([]); setMoreMessages(false);
    apiRequest<Message[]>(`/api/v1/admin/conversations/${conversation.id}/messages?limit=100`)
      .then(items => { if (alive) { setMessages(items); setMoreMessages(items.length === 100); } })
      .catch(cause => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [conversation]);
  useEffect(() => {
    if (!job) return;
    let alive = true;
    setCalls([]); setMoreCalls(false); setTrace(null);
    apiRequest<Call[]>(`/api/v1/jobs/${job.id}/model-calls?limit=100`)
      .then(items => { if (alive) { setCalls(items); setMoreCalls(items.length === 100); } })
      .catch(cause => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [job]);
  async function viewCall(callId: string) {
    if (!job) return;
    setTrace(null);
    try {
      const result = await apiRequest(`/api/v1/jobs/${job.id}/model-calls/${callId}`);
      if (currentJob.current === job.id) setTrace(result);
    }
    catch (cause) { setError(String(cause)); }
  }
  async function loadMoreMessages() {
    if (!conversation) return;
    try {
      const items = await apiRequest<Message[]>(`/api/v1/admin/conversations/${conversation.id}/messages?limit=100&offset=${messages.length}`);
      if (currentConversation.current !== conversation.id) return;
      setMessages(current => current.concat(items)); setMoreMessages(items.length === 100);
    } catch (cause) { setError(String(cause)); }
  }
  async function loadMoreCalls() {
    if (!job) return;
    try {
      const items = await apiRequest<Call[]>(`/api/v1/jobs/${job.id}/model-calls?limit=100&offset=${calls.length}`);
      if (currentJob.current !== job.id) return;
      setCalls(current => current.concat(items)); setMoreCalls(items.length === 100);
    } catch (cause) { setError(String(cause)); }
  }
  return <main className="admin-screen">
    <header><Link href="/">← 返回工作台</Link><h1>管理与诊断</h1><p>管理员可查看所有用户、项目、对话和完整模型调用。请勿复制或公开其中的私有资料。</p></header>
    {loading && <p role="status">正在加载…</p>}{error && <p role="alert" className="auth-error">{error}</p>}
    <div className="admin-grid">
      <section><h2>用户 · {users.length}</h2><ul>{users.map(user => <li key={user.id}>{user.username} · {user.role}</li>)}</ul>
        <h2>项目 · {projects.length}</h2><ul>{projects.map(item => <li key={item.id}><button className={project?.id === item.id ? "selected" : ""} onClick={() => setProject(item)}>{item.name}</button></li>)}</ul></section>
      <section><h2>项目成员</h2><ul>{members.map(item => <li key={item.id}>{item.username} · {item.role}</li>)}</ul><h2>对话</h2>{project && !conversations.length && <p>暂无对话。</p>}<ul>{conversations.map(item => <li key={item.id}><button className={conversation?.id === item.id ? "selected" : ""} onClick={() => setConversation(item)}>{item.title} · {item.module}</button></li>)}</ul>
        <h2>回收站</h2><ul>{trash.map(item => <li key={item.id}><button className={conversation?.id === item.id ? "selected" : ""} onClick={() => setConversation(item)}>{item.title} · 已删除</button></li>)}</ul>
        <h2>生成任务</h2><ul>{jobs.map(item => <li key={item.id}><button className={job?.id === item.id ? "selected" : ""} onClick={() => setJob(item)}>{item.goal.slice(0, 35)} · {item.status}</button></li>)}</ul></section>
      <section><h2>{conversation ? `消息 · ${conversation.title}` : "消息"}</h2><div className="admin-scroll">{messages.map(item => <article key={item.id}><strong>{item.role === "user" ? "用户" : "ArchFlow"}</strong><p>{item.content}</p></article>)}</div>{moreMessages && <button type="button" onClick={() => void loadMoreMessages()}>加载更多消息</button>}</section>
      <section><h2>{job ? `模型调用 · ${job.model}` : "模型调用"}</h2><ul>{calls.map(item => <li key={item.call_id}><button onClick={() => void viewCall(item.call_id)}>{item.call_id.slice(0, 8)} · {item.total_tokens ?? "未结算"} tokens</button></li>)}</ul>{moreCalls && <button type="button" onClick={() => void loadMoreCalls()}>加载更多调用</button>}
        {trace !== null && <details open><summary>完整请求与响应</summary><pre className="admin-trace">{JSON.stringify(trace, null, 2)}</pre></details>}</section>
    </div>
  </main>;
}
