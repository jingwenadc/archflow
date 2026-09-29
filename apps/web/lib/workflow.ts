import type { Message } from "./api";
import type { GenerationJobRecord } from "./job-contracts";

export const jobStatuses: Record<string, string> = {
  queued: "排队中", running: "正在处理资料与生成内容", waiting_outline: "提纲已准备好，等待你确认",
  waiting_storyboard: "内容策划已准备好，等待你确认", needs_review: "内容有待确认项，请复核",
  completed: "内容已生成", failed: "需要处理后继续", cancelled: "已停止",
};

export const workflowSteps = (module: GenerationJobRecord["module"]) => ["整理资料与提纲", "确认提纲", module === "concept" ? "逐页策划" : "逐章策划", "生成与审校", "排版与下载"];

export function workflowState(job: GenerationJobRecord & { progress?: string | null }) {
  const index = job.status === "waiting_outline" ? 1 : job.stage === "planning" ? 0
    : job.stage === "storyboarding" ? 2 : ["completed", "needs_review"].includes(job.status) ? 4 : 3;
  const label = job.status === "queued" ? "已接收任务，正在等待处理"
    : job.status === "waiting_outline" ? "提纲已准备好，请在右侧查看后确认"
    : job.status === "waiting_storyboard" ? `${job.module === "concept" ? "逐页" : "逐章"}策划已准备好，请查看后确认生成`
    : job.status === "completed" ? "内容生成与审校完成，文件排版和下载在右侧"
    : job.status === "needs_review" ? "已有审阅稿，请核对待确认项"
    : job.status === "cancelled" ? "已停止，原需求和已有成果保留"
    : job.status === "failed" ? "暂时停止，已有成果与需求保留"
    : job.progress ?? (job.stage === "planning" ? "正在阅读资料、整理提纲" : job.stage === "storyboarding"
      ? `正在策划${job.module === "concept" ? "页面" : "章节"} · ${job.storyboard_units} / ${job.target_units}` : job.stage === "final_review"
      ? "正在检查整份文档的一致性" : `正在生成与审校 · ${job.completed_units} / ${job.target_units}`);
  return { index, label };
}

export function failureHelp(job: GenerationJobRecord) {
  if (job.total_tokens >= job.max_total_tokens || job.model_calls >= job.max_model_calls || job.failure_kind === "budget")
    return { kind: "budget", message: "已达到你批准的运行上限。已有内容保留；批准新的总上限后才能继续。", retry: "" };
  if (job.failure_kind === "context")
    return { kind: "context", message: "当前上下文未能整理完成。可以从检查点继续；若重复失败，需要检查模型窗口或减少单次输入，而不是提高累计预算。", retry: "继续整理资料" };
  if (job.failure_kind === "configuration")
    return { kind: "configuration", message: "模型配置需要管理员检查。修正配置后可以从已保存的进度继续。", retry: "配置修正后重试" };
  if (job.failure_kind === "provider")
    return { kind: "provider", message: "模型服务未完成请求。已有进度保留，可以重试当前步骤。", retry: "重试当前步骤" };
  return { kind: "other", message: "当前步骤未完成。可以从已保存的进度继续；若仍失败，请展开技术诊断查看原因。", retry: "继续当前步骤" };
}

export const isActiveJob = (job: GenerationJobRecord | null) => !!job && ["queued", "running", "waiting_outline", "waiting_storyboard"].includes(job.status);

// Page references (第 3 页 / 3–5 页) are not a requested document length.
export function requestedUnitCount(text: string, module: "concept" | "bid" | "drawing" = "concept"): number | undefined {
  const pattern = module === "bid" ? /(?<!\d)(\d+)\s*(?:章节|章|chapters?\b)/giu : /(?<!\d)(\d+)\s*(?:页|slides?\b|pages?\b)/giu;
  const matches = [...text.matchAll(pattern)].filter(match => {
    const prefix = text.slice(0, match.index!);
    return !/第\s*$|\d\s*[-–到至]\s*$|(?:不要|不做|不是|not)\s*$/iu.test(prefix);
  });
  const match = matches.at(-1);
  return match ? Number(match[1]) : undefined;
}

export function requirementBrief(messages: Message[], confirmed?: GenerationJobRecord | null): string {
  const additions = messages.filter(message => message.role === "user" && (!confirmed || Date.parse(message.created_at) > Date.parse(confirmed.created_at)));
  return [...(confirmed ? [confirmed.goal] : []), ...additions.map(message => message.content)]
    .join("\n补充要求（与前文冲突时，以后续要求为准）：");
}

export function orderedJobs(jobs: GenerationJobRecord[]): GenerationJobRecord[] {
  return [...jobs].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export type TimelineEntry = { type: "message"; message: Message } | { type: "requirement"; job: GenerationJobRecord; version: number };

export function conversationTimeline(messages: Message[], jobs: GenerationJobRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map(message => ({ type: "message" as const, message })),
    ...orderedJobs(jobs).map((job, index) => ({ type: "requirement" as const, job, version: index + 1 })),
  ];
  const createdAt = (entry: TimelineEntry) => entry.type === "message" ? entry.message.created_at : entry.job.created_at;
  return entries.sort((a, b) => createdAt(a).localeCompare(createdAt(b)));
}
