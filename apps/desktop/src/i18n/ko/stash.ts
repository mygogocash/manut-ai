import type { stash as en } from "../en/stash";

export const stash: Record<keyof typeof en, string> = {
  "stash.put": "홈 위쪽의 임시 보관함에 넣어 두었습니다.",
  "stash.failed": "넣어 두지 못했습니다 · {error}",
  "stash.missing": "다음 파일은 함께 옮기지 못했습니다: {names}",
};
