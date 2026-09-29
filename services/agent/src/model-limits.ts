import { WorkflowError } from "./errors.js";

// Official API model pages, verified 2026-09-28. Provider aliases need an explicit override.
// Source: https://developers.openai.com/api/docs/models/<model-id>
const catalog: Record<string, { contextWindow: number; maxOutputTokens: number; reasoning: boolean }> = {
  "gpt-5.5": { contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5.4": { contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5.2": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5.1": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5-mini": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5-nano": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5.4-mini": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5.4-nano": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-5.3-codex": { contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true },
  "gpt-4.1": { contextWindow: 1_047_576, maxOutputTokens: 32_768, reasoning: false },
  "gpt-4.1-mini": { contextWindow: 1_047_576, maxOutputTokens: 32_768, reasoning: false },
  "gpt-4.1-nano": { contextWindow: 1_047_576, maxOutputTokens: 32_768, reasoning: false },
  "gpt-4o": { contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false },
  "gpt-4o-mini": { contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false },
};

export function contextOverride(value: string | undefined): number | undefined {
  if (!value || value === "auto") return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 4096) throw new Error("ARCHFLOW_LLM_CONTEXT_WINDOW must be auto or an integer >= 4096.");
  return limit;
}

export function modelLimits(modelId: string, override?: number, output = 8192) {
  // Only strip the documented snapshot date form, not arbitrary gateway suffixes.
  const known = catalog[modelId] ?? catalog[modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!known && !override) throw new WorkflowError("configuration", `Unknown model ${modelId}; configure its verified ARCHFLOW_LLM_CONTEXT_WINDOW.`);
  const contextWindow = Math.min(override ?? known!.contextWindow, known?.contextWindow ?? Infinity);
  const maxOutputTokens = Math.min(output, known?.maxOutputTokens ?? output);
  if (maxOutputTokens >= contextWindow) throw new WorkflowError("configuration", "Output token limit must be smaller than the model/provider context window.");
  return { contextWindow, maxOutputTokens, reasoning: known?.reasoning ?? true };
}
