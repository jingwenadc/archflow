import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ApiClient } from "./client.js";
import { runStep, stepContext, type ModelConfig } from "./runtime.js";
import { contextOverride } from "./model-limits.js";
import type { ClaimedJob } from "./contracts.js";
import { WorkflowError, diagnosticError, isRetryableProviderError } from "./errors.js";

const MAX_PROVIDER_RETRIES = 4;
const MAX_UNCHECKPOINTED_REPLAY_CALLS = 8;
// Match the session's latest possible automatic compaction threshold. If a
// costly attempt never produced a newer durable summary, replaying it
// automatically can multiply model spend without recovering useful work.
const MAX_UNCHECKPOINTED_REPLAY_TOKENS = 32_000;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 15_000;

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
      const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
      for (let retries = 0; ; retries++) {
        const { action, start, end, modelId } = stepContext(claim.job);
        const base = { action, attempt: retries + 1, unit_start: start, unit_end: end, model: modelId };
        const started = performance.now();
        await api.diagnostic(claim.job.id, claim.lease_id, { ...base, event: "step_start", outcome: "started" }).catch(() => undefined);
        try {
          await runStep(api, claim, config, stepSignal, retries + 1);
          await api.diagnostic(claim.job.id, claim.lease_id, { ...base, event: "step_end", outcome: "completed", elapsed_ms: Math.round(performance.now() - started) }).catch(() => undefined);
          break;
        }
        catch (error) {
          // The checkpoint may have committed even if the response was lost.
          // Reconcile with durable state before deciding whether to replay a step.
          const latest = await api.detail(claim.job.id);
          const current = stepContext(latest);
          const spentTokens = Math.max(0, latest.total_tokens - claim.job.total_tokens);
          const spentCalls = Math.max(0, latest.model_calls - claim.job.model_calls);
          if (latest.status !== "running" || latest.stage !== claim.job.stage ||
              current.action !== action || current.start !== start || current.end !== end ||
              current.batch?.draft_count !== stepContext(claim.job).batch?.draft_count) {
            claim.job = latest;
            break;
          }
          claim.job = latest;
          const retryable = isRetryableProviderError(error) && retries < MAX_PROVIDER_RETRIES && !stepSignal.aborted;
          const memory = retryable ? await api.loadMemory(claim.job.id, claim.lease_id) : null;
          const memoryScope = `${action}:${start}-${end}:${current.batch?.draft_count ?? 0}`;
          const freshMemory = memory?.scope === memoryScope && memory.summary !== claim.memory?.summary;
          const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retries);
          const retryDelay = retryable ? Math.round(backoff * (0.75 + Math.random() * 0.5)) : undefined;
          await api.diagnostic(claim.job.id, claim.lease_id, { ...base, event: "step_end", outcome: "failed",
            elapsed_ms: Math.round(performance.now() - started),
            error_kind: error instanceof WorkflowError ? error.kind : "workflow", error_message: diagnosticError(error),
            retry_reason: stepSignal.aborted && !signal.aborted ? "step_deadline" : isRetryableProviderError(error) && retries >= MAX_PROVIDER_RETRIES ? "retry_exhausted" : undefined,
          }).catch(() => undefined);
          if (!retryable) throw error;
          if ((spentTokens > MAX_UNCHECKPOINTED_REPLAY_TOKENS || spentCalls > MAX_UNCHECKPOINTED_REPLAY_CALLS) && !freshMemory) {
            throw new WorkflowError("provider", "模型连接中断，本次尝试消耗较多调用或 tokens，但未保存新的恢复摘要；已暂停自动重跑，避免重复费用。可从已有检查点手动继续。");
          }
          // Each attempt creates a fresh Pi session. Refresh the same-lease
          // compaction memory rather than restarting from the original claim.
          await api.diagnostic(claim.job.id, claim.lease_id, { ...base, event: "retry", outcome: "retrying",
            error_kind: "provider", error_message: diagnosticError(error), retry_delay_ms: retryDelay, retry_reason: "transient_provider",
          }).catch(() => undefined);
          await api.progress(claim.job.id, claim.lease_id, { step: "retrying" }).catch(() => undefined);
          await delay(retryDelay, undefined, { signal: stepSignal });
          claim.memory = memory;
        }
      }
      claim.job = await api.detail(claim.job.id);
    }
  } catch (error) {
    // Cancelled/shutdown/expired leases are recoverable states, not a false failure.
    if (!signal.aborted) {
      await api.checkpoint(claim.job.id, claim.lease_id, { action: "failure", failure_kind: error instanceof WorkflowError ? error.kind : "workflow", error: error instanceof Error ? error.message : "Agent step failed." }).catch(() => undefined);
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
    contextWindow: contextOverride(process.env.ARCHFLOW_LLM_CONTEXT_WINDOW), maxOutputTokens: positive("ARCHFLOW_LLM_MAX_OUTPUT_TOKENS", 8192), workDir: process.env.ARCHFLOW_AGENT_DIR ?? "/tmp/archflow-agent",
  } : null;
  if (config && !/^https?:\/\//.test(config.baseUrl)) throw new Error("Invalid provider URL.");
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
