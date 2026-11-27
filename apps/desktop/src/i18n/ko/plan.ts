import type { plan as en } from "../en/plan";

export const plan: Record<keyof typeof en, string> = {
  "plan.count": "할 일 · {n}개 중 {done}개 완료",
  "plan.pending": "할 일",
  "plan.doing": "진행 중",
  "plan.done": "완료",
};
