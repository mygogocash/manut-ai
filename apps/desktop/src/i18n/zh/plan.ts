import type { plan as en } from "../en/plan";

export const plan: Record<keyof typeof en, string> = {
  "plan.count": "待办 · {n} 项中已完成 {done} 项",
  "plan.pending": "待办",
  "plan.doing": "进行中",
  "plan.done": "已完成",
};
