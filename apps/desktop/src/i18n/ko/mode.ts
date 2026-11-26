import type { mode as en } from "../en/mode";

export const mode: Record<keyof typeof en, string> = {
  "mode.practice": "연습 모드",
  "mode.connected": "{host}에 연결됨",
  "mode.connecting": "{host}에 연결하는 중…",
  "mode.signedOut": "로그아웃됨 · {host}",
  "mode.offline": "오프라인 · {host}",
  "mode.unavailable": "응답 없음 · {host}",
  "mode.cachedOffline": "오프라인. {time}에 있던 내용을 보여 주고 있어요",
  "mode.cachedUnavailable": "응답 없음. {time}에 있던 내용을 보여 주고 있어요",
  "mode.oldOffline": "오프라인. 저장된 사본이 7일보다 오래되어 보여 주지 않아요",
  "mode.oldUnavailable": "응답 없음. 저장된 사본이 7일보다 오래되어 보여 주지 않아요",
  "mode.unkeptOffline": "오프라인. 이 컴퓨터는 아직 사본을 저장할 수 없어서 보여 줄 내용이 없어요",
  "mode.unkeptUnavailable": "응답 없음. 이 컴퓨터는 아직 사본을 저장할 수 없어서 보여 줄 내용이 없어요",
  "mode.open": "런타임 설정",
};
