import type { cont as en } from "../en/cont";

export const cont: Record<keyof typeof en, string> = {
  "cont.menu": "다른 에이전트로 이어 가기…",
  "cont.tip": "{agent}. 이 작업을 다른 에이전트나 모델로 이어 가기",
  "cont.note": "이 채팅이 작업하는 곳에서 새 채팅을 열고, 이 채팅의 맥락을 보내지 않은 채 입력창 위에 둡니다. 이 채팅은 그대로 남습니다.",
  "cont.none": "채팅할 수 있는 다른 에이전트가 설치되어 있지 않습니다",
  "cont.failed": "이어 가지 못했습니다 · {error}",
  "cont.in": "{agent}에서 이어 감",
  "cont.from": "{agent}에서 이어 옴",
  "cont.open": "열기",
  "cont.stop": "여기서 {agent} 멈추기",
  "cont.stopTip": "지금은 작업하지 않습니다. 프로그램은 끝나지만 이 채팅은 남아 있고 열 수 있습니다.",
  "cont.wait": "{agent}이(가) 이 레인에서 작업 중입니다. 끝난 뒤에 보내 주세요. 한 레인에서는 한 번에 에이전트 하나만 작업합니다.",
};
