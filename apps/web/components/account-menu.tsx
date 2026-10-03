"use client";

import { useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/api";

import { useAuth } from "./auth-gate";

export function AccountMenu() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return <span className="avatar" aria-label="当前用户">AF</span>;
  async function logout() {
    await apiRequest("/api/v1/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }
  return <div className="account-control">
    <button className="avatar" type="button" aria-label={`账号：${user.username}`} aria-expanded={open} onClick={() => setOpen(!open)}>{user.username.slice(0, 1).toUpperCase()}</button>
    {open && <div className="account-menu"><strong>{user.username}</strong>
      {user.role === "admin" && <Link href="/admin" onClick={() => setOpen(false)}>管理与诊断</Link>}
      <button type="button" onClick={() => void logout()}>退出登录</button>
    </div>}
  </div>;
}
