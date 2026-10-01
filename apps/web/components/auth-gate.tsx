"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { apiBaseUrl } from "@/lib/api";

type AuthState = { enabled: boolean; user: { id: string; username: string; role: "admin" | "user" } | null };
const AuthContext = createContext<AuthState | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Auth provider is missing.");
  return value;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [auth, setAuth] = useState<AuthState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const status = await fetch(`${apiBaseUrl}/api/v1/auth/status`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!status.ok) throw new Error("无法检查账号状态");
        const session: AuthState = await status.json();
        if (controller.signal.aborted) return;
        if (session.enabled && !session.user && window.location.pathname !== "/login") {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        setAuth({ enabled: session.enabled, user: session.user ?? null });
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
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
