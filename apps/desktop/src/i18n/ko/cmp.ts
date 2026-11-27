import type { cmp as en } from "../en/cmp";

export const cmp: Record<keyof typeof en, string> = {
  "cmp.skillHint": "{bot}의 스킬 목록이 없어요. 메시지 맨 앞에 스킬 이름을 전부 입력하세요. 예: {example}",
  "cmp.skillSigil": "스킬은 메시지 어디에서나 $로 입력해요. 예: {example}. / 명령어는 입력한 그대로 {bot}에게 보내요.",
  "cmp.removeReply": "답장 대상 지우기",
  "cmp.remove": "지우기",
  "cmp.offline": "{bot} 오프라인",
  "cmp.replyThere": "{bot}에게 거기에 올릴 내용을 말하세요",
  "cmp.asking": "위에서 답하거나 입력해서 답하세요",
  "cmp.message": "{bot}에게 메시지",
  "cmp.stop": "멈추기",
  "cmp.send": "보내기",
};
