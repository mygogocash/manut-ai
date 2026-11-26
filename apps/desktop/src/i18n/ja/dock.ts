import type { dock as en } from "../en/dock";

export const dock: Record<keyof typeof en, string> = {
  "dock.label": "ピン留め",
  "dock.pin": "ドックに固定",
  "dock.unpin": "固定を解除",
  "dock.open": "開く",
  "dock.needs": "{name}: あなたの応答待ち",
  "dock.failed": "{name}: 失敗",
  "dock.running": "{name}: 作業中",
};
