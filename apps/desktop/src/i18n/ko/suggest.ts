import type { suggest as en } from "../en/suggest";

export const suggest: Record<keyof typeof en, string> = {
  "suggest.group": "다음 메시지 제안",
  "suggest.title": "다음에 할 말 제안",
  "suggest.hintCost": "코딩 채팅이 한 차례를 끝내면 빈 입력창에 다음 메시지 제안이 회색으로 나타납니다. Tab을 눌러 쓰거나 그냥 입력하세요. 스스로 보내는 일은 없습니다. 제안마다 매 차례 뒤에 내 AI 요금제로 요청이 한 번 더 나가므로, 켜기 전에는 꺼져 있습니다. 켠 뒤에 시작한 채팅부터 적용됩니다.",
  "suggest.agents": "지원하는 에이전트",
  "suggest.agentsHint": "Codex와 다른 코딩 에이전트에는 아직 제안을 요청할 방법이 없어, 그 채팅에서는 표시되지 않습니다.",
  "suggest.agentsValue": "Claude Code",
  "suggest.hint": "다음 메시지 제안입니다. Tab으로 쓰고, 입력하면 사라집니다.",
};
