import type { st as en } from "../en/st";

export const st: Record<keyof typeof en, string> = {
  "st.done": "완료",
  "st.running": "실행 중",
  "st.failed": "실패",
  "st.blocked": "막힘",
  "st.parked": "보류",
  "st.waiting": "대기 중",
  "st.cancelled": "취소됨",
};
