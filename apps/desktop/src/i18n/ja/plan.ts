import type { plan as en } from "../en/plan";

export const plan: Record<keyof typeof en, string> = {
  "plan.count": "ToDo · {n}件中{done}件完了",
  "plan.pending": "未着手",
  "plan.doing": "進行中",
  "plan.done": "完了",
};
