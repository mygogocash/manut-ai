import type { dock as en } from "../en/dock";

export const dock: Record<keyof typeof en, string> = {
  "dock.label": "已固定",
  "dock.pin": "固定到 Dock",
  "dock.unpin": "取消固定",
  "dock.open": "打开",
  "dock.needs": "{name}：等待你处理",
  "dock.failed": "{name}：失败",
  "dock.running": "{name}：进行中",
};
