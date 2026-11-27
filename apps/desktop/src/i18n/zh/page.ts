import type { page as en } from "../en/page";

export const page: Record<keyof typeof en, string> = {
  // shared words of both pages
  "page.cancel": "取消",
  "page.close": "关闭",
  "page.back": "返回",
  "page.offline": "{bot} 已离线。请等它恢复后再试一次。",
  "page.failed": "操作失败：{error}",
  "page.on": "开",
  "page.off": "关",
  "page.more": "{name} 的更多操作",
};
