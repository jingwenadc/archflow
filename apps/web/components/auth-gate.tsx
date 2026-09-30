"use client";

import { useEffect, useState } from "react";
import { apiBaseUrl } from "@/lib/api";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    if (window.location.pathname === "/login") { setState("ready"); return; }
    const controller = new AbortController();
    async function check() {
      try {
        const status = await fetch(`${apiBaseUrl}/api/v1/auth/status`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!status.ok) throw new Error("无法检查账号状态");
        if (!(await status.json()).enabled) { setState("ready"); return; }
        const me = await fetch(`${apiBaseUrl}/api/v1/auth/me`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (me.status === 401) {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        if (!me.ok) throw new Error("无法验证登录状态");
        setState("ready");
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    }
    void check();
    return () => controller.abort();
  }, []);
  if (state === "loading") return <main className="auth-screen"><p role="status">正在验证登录状态…</p></main>;
  if (state === "error") return <main className="auth-screen"><p role="alert">无法连接 ArchFlow，请检查服务后刷新页面。</p></main>;
  return children;
}
