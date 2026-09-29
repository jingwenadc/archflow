"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { apiRequest } from "@/lib/api";
import { runLimitsSchema, type RunLimits } from "@/lib/job-contracts";
import { normalizeIntegerInput, parseIntegerInput } from "@/lib/integer-input";
import { CloseIcon, SettingsIcon } from "./icons";

type SettingsState = { limits: RunLimits | null; openSettings: () => void };
type LimitsDraft = { [Key in keyof RunLimits]: string };
const limitsDraft = (value: RunLimits): LimitsDraft => ({ max_model_calls: String(value.max_model_calls), max_total_tokens: String(value.max_total_tokens) });
const SettingsContext = createContext<SettingsState | null>(null);
export function useRunSettings() {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("Run settings provider is missing.");
  return value;
}

export function RunSettingsProvider({ children }: { children: ReactNode }) {
  const [limits, setLimits] = useState<RunLimits | null>(null);
  const [draft, setDraft] = useState<LimitsDraft | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const tokens = draft ? parseIntegerInput(draft.max_total_tokens, runLimitsSchema.properties.max_total_tokens.minimum, runLimitsSchema.properties.max_total_tokens.maximum) : null;
  const calls = draft ? parseIntegerInput(draft.max_model_calls, runLimitsSchema.properties.max_model_calls.minimum, runLimitsSchema.properties.max_model_calls.maximum) : null;

  async function load() {
    try { const value = await apiRequest<RunLimits>("/api/v1/settings/run-limits"); setLimits(value); setDraft(limitsDraft(value)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取运行设置，请重试。"); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (tokens === null || calls === null || busy) return;
    setBusy(true); setError(null);
    try {
      const value = await apiRequest<RunLimits>("/api/v1/settings/run-limits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_total_tokens: tokens, max_model_calls: calls }) });
      setLimits(value); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <SettingsContext.Provider value={{ limits, openSettings: () => { setDraft(limits ? limitsDraft(limits) : null); setOpen(true); } }}>
    {children}
    <dialog ref={dialog} className="run-settings-dialog" aria-labelledby="run-settings-title" onCancel={event => { if (busy) event.preventDefault(); else setOpen(false); }} onClose={() => setOpen(false)}>
      <form onSubmit={save}>
        <header><div><p className="eyebrow">WORKSPACE SETTINGS</p><h2 id="run-settings-title">运行设置</h2></div><button type="button" className="icon-button" aria-label="关闭运行设置" disabled={busy} onClick={() => setOpen(false)}><CloseIcon /></button></header>
        <p>任务运行保护参数，与模型的单次上下文窗口无关。高额度可能产生较高费用，请按需要调整。</p>
        {draft && <>
          <label>每个任务的累计 token 上限<input type="number" required step={1} min={runLimitsSchema.properties.max_total_tokens.minimum} max={runLimitsSchema.properties.max_total_tokens.maximum} value={draft.max_total_tokens} disabled={busy} onChange={event => setDraft({ ...draft, max_total_tokens: event.target.value })} onBlur={() => setDraft({ ...draft, max_total_tokens: normalizeIntegerInput(draft.max_total_tokens) })} /></label>
          <label>每个任务的模型调用上限<input type="number" required step={1} min={runLimitsSchema.properties.max_model_calls.minimum} max={runLimitsSchema.properties.max_model_calls.maximum} value={draft.max_model_calls} disabled={busy} onChange={event => setDraft({ ...draft, max_model_calls: event.target.value })} onBlur={() => setDraft({ ...draft, max_model_calls: normalizeIntegerInput(draft.max_model_calls) })} /></label>
          <p className="generation-note">包含生成、审校与上下文整理的累计用量，不是美元预算。最后一次在途请求可能超出 token 上限。</p>
        </>}
        <p className="generation-note">设置保存在服务器，供此工作空间的新任务使用。已有任务保留原额度；需要继续时，点击任务中的继续按钮。保存设置不会自动启动或恢复任务。</p>
        {error && <p className="generation-error" role="alert">{error}<button type="button" onClick={() => void load()}>重新读取设置</button></p>}
        <footer><button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button><button type="submit" disabled={tokens === null || calls === null || busy}>{busy ? "正在保存…" : "保存设置"}</button></footer>
      </form>
    </dialog>
  </SettingsContext.Provider>;
}

export function RunSettingsButton() {
  const { openSettings } = useRunSettings();
  return <button className="icon-button settings-button" aria-label="运行设置" title="运行设置" onClick={openSettings}><SettingsIcon /></button>;
}
