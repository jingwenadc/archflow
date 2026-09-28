import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ApiClient } from "./client.js";
import { runStep, type ModelConfig } from "./runtime.js";
import type { ClaimedJob } from "./contracts.js";

export async function processJob(api: ApiClient, claim: ClaimedJob, config: ModelConfig, shutdown: AbortSignal) {
  const lostLease = new AbortController();
  const signal = AbortSignal.any([shutdown, lostLease.signal]);
  let heartbeating = false;
  const heartbeat = setInterval(async () => {
    if (heartbeating) return;
    heartbeating = true;
    try { await api.heartbeat(claim.job.id, claim.lease_id); }
    catch { lostLease.abort(); }
    finally { heartbeating = false; }
  }, 15_000);
  try {
    while (claim.job.status === "running" && !signal.aborted) {
      await runStep(api, claim, config, AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]));
      claim.job = await api.detail(claim.job.id);
    }
  } catch (error) {
    // Cancelled/shutdown/expired leases are recoverable states, not a false failure.
    if (!signal.aborted) {
      await api.checkpoint(claim.job.id, claim.lease_id, { action: "failure", error: error instanceof Error ? error.message : "Agent step failed." }).catch(() => undefined);
    }
  } finally { clearInterval(heartbeat); }
}

async function main() {
  const shutdown = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"] as const) process.on(name, () => shutdown.abort());
  const enabled = process.env.ARCHFLOW_AGENT_ENABLED === "true";
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; };
  const positive = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    return value;
  };
  const config: ModelConfig | null = enabled ? {
    baseUrl: required("ARCHFLOW_LLM_BASE_URL"), apiKey: required("ARCHFLOW_LLM_API_KEY"),
    contextWindow: positive("ARCHFLOW_LLM_CONTEXT_WINDOW", 65536), maxOutputTokens: positive("ARCHFLOW_LLM_MAX_OUTPUT_TOKENS", 8192), workDir: process.env.ARCHFLOW_AGENT_DIR ?? "/tmp/archflow-agent",
  } : null;
  if (config && (config.maxOutputTokens >= config.contextWindow || !/^https?:\/\//.test(config.baseUrl))) throw new Error("Invalid provider limits or URL.");
  const api = enabled ? new ApiClient(process.env.ARCHFLOW_API_URL ?? "http://api:8000", required("ARCHFLOW_WORKER_TOKEN")) : null;
  console.log(enabled ? "ArchFlow Pi worker started." : "ArchFlow Pi worker disabled; no model calls will be made.");
  while (!shutdown.signal.aborted) {
    await writeFile("/tmp/archflow-agent-health", String(Date.now()), { mode: 0o600 });
    try {
      const claim = await api?.claim();
      if (claim && api && config) {
        const health = setInterval(() => { void writeFile("/tmp/archflow-agent-health", String(Date.now())).catch(() => undefined); }, 10_000);
        try { await processJob(api, claim, config, shutdown.signal); } finally { clearInterval(health); }
      } else { await delay(1000, undefined, { signal: shutdown.signal }); }
    } catch {
      if (!shutdown.signal.aborted) { console.error("Worker API unavailable; retrying."); await delay(3000, undefined, { signal: shutdown.signal }).catch(() => undefined); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof Error ? error.message : "Worker configuration failed."); process.exitCode = 1; });
