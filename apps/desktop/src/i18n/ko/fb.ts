import type { fb as en } from "../en/fb";

export const fb: Record<keyof typeof en, string> = {
  "fb.denied": "거부함",
  "fb.allowed": "허용함",
  "fb.waiting": "확인 필요 · {title}",
  "fb.answered": "답함: {answer}",
  "fb.question": "질문 · {q}",
  "fb.routine": "루틴 · {name} · {status}",
  "fb.elsewhere": "다른 곳",
};
