import type { fb as en } from "../en/fb";

export const fb: Record<keyof typeof en, string> = {
  "fb.denied": "拒否しました",
  "fb.allowed": "許可しました",
  "fb.waiting": "対応が必要 · {title}",
  "fb.answered": "回答済み: {answer}",
  "fb.question": "質問 · {q}",
  "fb.routine": "ルーティン · {name} · {status}",
  "fb.elsewhere": "ほかの場所",
};
