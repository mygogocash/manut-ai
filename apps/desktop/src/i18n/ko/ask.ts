import type { ask as en } from "../en/ask";

export const ask: Record<keyof typeof en, string> = {
  // the "say it in words" box on Automations and Plugins
  "ask.to": "{bot}에게 보내기",
  "ask.pickBot": "봇 고르기",
  "ask.send": "{bot} 채팅으로 보내기",
  "ask.offline": "{bot} 게이트웨이가 꺼져 있어요. 켠 뒤 다시 해 주세요.",
  "ask.allowCmd": "{cmd} 허용할까요?",
  "ask.allowThis": "이 명령을 허용할까요?",
  "ask.questions": "질문 {n}개: {first}",
  "ask.sessionEnded": "이 세션은 끝났어요",
};
