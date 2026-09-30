"use client";

import { useState, type FormEvent } from "react";
import { apiRequest } from "@/lib/api";

export default function LoginPage() {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await apiRequest(register ? "/api/v1/auth/signup" : "/api/v1/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, ...(register ? { signup_code: code } : {}) }),
      });
      const destination = new URLSearchParams(window.location.search).get("next") || "/";
      window.location.assign(destination.startsWith("/") && !destination.startsWith("//") ? destination : "/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败"); }
    finally { setBusy(false); }
  }
  return <main className="auth-screen"><section className="auth-card" aria-labelledby="auth-title">
    <p className="eyebrow">图策 ARCHFLOW</p><h1 id="auth-title">{register ? "创建个人账号" : "登录 ArchFlow"}</h1>
    <p>项目默认仅你可见。管理员可为故障排查查看对话、项目资料及完整模型调用记录。</p>
    <form onSubmit={submit}>
      <label>用户名<input autoComplete="username" required minLength={3} maxLength={64} value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label>密码<input type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={12} value={password} onChange={event => setPassword(event.target.value)} /></label>
      {register && <label>初始邀请码<input type="password" autoComplete="off" required value={code} onChange={event => setCode(event.target.value)} /></label>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "请稍候…" : register ? "创建账号" : "登录"}</button>
    </form>
    <button className="auth-switch" type="button" onClick={() => { setRegister(!register); setError(""); }}>{register ? "已有账号？登录" : "有初始邀请码？创建账号"}</button>
  </section></main>;
}
