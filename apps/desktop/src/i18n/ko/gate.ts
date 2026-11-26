import type { gate as en } from "../en/gate";

export const gate: Record<keyof typeof en, string> = {
  "gate.failedHead": "설치가 끝나지 않았어요",
  "gate.head": "시작하려면 Hermes를 설치하세요",
  "gate.text": "봇은 Hermes Agent 위에서 돌아가는데, 이 컴퓨터에는 아직 없어요. 설치를 누르면 아래 명령으로 Hermes와 oh-my-hermes를 차례로 설치해요.",
  "gate.copyCmd": "명령 복사",
  "gate.copy": "복사",
  "gate.copied": "복사됨",
  "gate.couldNotRun": "설치 프로그램을 실행하지 못했어요.",
  "gate.stopped": "설치가 멈췄어요 (exit {code}). 위 출력에 이유가 있어요. 고친 뒤 다시 설치를 누르세요.",
  "gate.installing": "설치하는 중…",
  "gate.again": "다시 설치",
  "gate.install": "설치",
  "gate.check": "다시 확인",
  "gate.note": "몇 분 걸려요. 모델은 그다음 앱에서 골라요.",
  "gate.unreachable": "Manut AI가 Hermes에 연결할 수 없어요",
  "gate.starting": "Manut AI 시작하는 중…",
  "gate.noBridge": "로컬 브리지가 시작되지 않았어요.",
  "gate.retry": "다시 시도",
  "gate.reviving": "브리지를 다시 시작하는 중…",
};
