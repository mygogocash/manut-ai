import type { page as en } from "../en/page";

export const page: Record<keyof typeof en, string> = {
  // shared words of both pages
  "page.cancel": "취소",
  "page.close": "닫기",
  "page.back": "뒤로",
  "page.offline": "{bot}이(가) 오프라인이에요. 다시 켜진 뒤에 해 주세요.",
  "page.failed": "처리하지 못했어요: {error}",
  "page.on": "켬",
  "page.off": "끔",
  "page.more": "{name} 더 보기",
};
