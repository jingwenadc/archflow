import type { Message } from "./api";
import type { GenerationJobRecord } from "./job-contracts";

export const jobStatuses: Record<string, string> = {
  queued: "排队中", running: "正在处理资料与生成内容", waiting_outline: "提纲已准备好，等待你确认",
  waiting_storyboard: "逐页策划已准备好，等待你确认", needs_review: "内容有待确认项，请复核",
  completed: "内容审校完成", failed: "任务失败，可从检查点重试", cancelled: "任务已取消",
};

export const isActiveJob = (job: GenerationJobRecord | null) => !!job && ["queued", "running", "waiting_outline", "waiting_storyboard"].includes(job.status);

// Page references (第 3 页 / 3–5 页) are not a requested document length.
export function requestedPageCount(text: string): number | undefined {
  const matches = [...text.matchAll(/(?<!\d)(\d{1,3})\s*页/gu)].filter(match => {
    const prefix = text.slice(0, match.index!);
    return !/第\s*$|\d\s*[-–到至]\s*$|(?:不要|不做|不是)\s*$/u.test(prefix);
  });
  const match = matches.at(-1);
  return match ? Math.min(500, Math.max(1, Number(match[1]))) : undefined;
}

export function requirementBrief(messages: Message[], confirmed?: GenerationJobRecord | null): string {
  const additions = messages.filter(message => message.role === "user" && (!confirmed || Date.parse(message.created_at) > Date.parse(confirmed.created_at)));
  return [...(confirmed ? [confirmed.goal] : []), ...additions.map(message => message.content)]
    .join("\n补充要求（与前文冲突时，以后续要求为准）：").slice(-20000);
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
