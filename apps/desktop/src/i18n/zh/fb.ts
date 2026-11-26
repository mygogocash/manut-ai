import type { fb as en } from "../en/fb";

export const fb: Record<keyof typeof en, string> = {
  "fb.denied": "已拒绝",
  "fb.allowed": "已允许",
  "fb.waiting": "需要你处理 · {title}",
  "fb.answered": "已回答：{answer}",
  "fb.question": "问题 · {q}",
  "fb.routine": "定时任务 · {name} · {status}",
  "fb.elsewhere": "其他地方",
};
