import type { dock as en } from "../en/dock";

export const dock: Record<keyof typeof en, string> = {
  "dock.label": "고정됨",
  "dock.pin": "독에 고정",
  "dock.unpin": "고정 해제",
  "dock.open": "열기",
  "dock.needs": "{name}: 확인이 필요해요",
  "dock.failed": "{name}: 실패",
  "dock.running": "{name}: 작업 중",
};
