import type { helpers as en } from "../en/helpers";

export const helpers: Record<keyof typeof en, string> = {
  // the Helpers switch in a lane's box (item 102e, src/jobs/HelpersSwitch.tsx)
  "helpers.switch": "도우미",
  "helpers.switchTip": "이 레인 옆에서 일하는 도우미 레인을 Kit이 요청할 수 있게 합니다. 각각 이 레인 작업의 사본에서 일합니다. 카드에서 도우미 시작을 누르기 전에는 아무것도 시작되지 않습니다.",
  "helpers.switchOnTip": "도우미가 켜져 있습니다. 메시지마다 도우미 레인을 요청하는 방법이 Kit에게 전달됩니다. 카드에서 도우미 시작을 누르기 전에는 아무것도 시작되지 않습니다.",
  // the activity line while an answer asks for helper lanes, its blocks hidden
  "helpers.writing": "도우미 레인 요청을 쓰는 중",
  "helpers.writing.one": "도우미 레인 1개를 요청하는 중",
  "helpers.writing.many": "도우미 레인 {n}개를 요청하는 중",
  // the Start helpers card (src/jobs/HelpersCard.tsx)
  "helpers.ask.one": "Kit이 도우미 레인 1개를 요청합니다",
  "helpers.ask.many": "Kit이 도우미 레인 {n}개를 요청합니다",
  "helpers.row": "도우미 {n}",
  "helpers.leadModel": "리드의 모델",
  "helpers.defaultModel": "기본 모델",
  "helpers.modelUnlisted": "에이전트의 기본값 (Kit이 {name}을(를) 요청했지만 목록에 없습니다)",
  "helpers.effortUnlisted": "평소의 생각의 깊이 (Kit이 {name}을(를) 요청했지만 목록에 없습니다)",
  "helpers.unknownAgent": "{name}: Manut AI가 레인에서 실행하는 에이전트가 아니므로 시작하지 않습니다",
  "helpers.notInstalled": "설치되어 있지 않아 시작하지 않습니다",
  "helpers.briefLabel": "도우미 {n}의 지시",
  "helpers.lines": "각각 지금 이 레인 작업의 사본에서 일합니다. 도우미 레인이 보고한 뒤 그 작업이 하나씩 반영되기 전까지 여기에는 아무것도 바뀌지 않습니다. 각각 최대 {minutes}분, {steps}단계까지이며, 답을 기다리는 시간은 세지 않습니다. 끝나면 Kit이 보고를 받고 이어서 일합니다.",
  "helpers.heldBack": "Kit이 {asked}개를 요청했습니다. 한 라운드는 최대 {max}개이므로 마지막 {left}개는 제외합니다.",
  "helpers.start": "도우미 시작",
  "helpers.notNow": "나중에",
  // what became of the card
  "helpers.started": "이 라운드를 승인했습니다. 이 버전은 아직 도우미 레인을 시작하지 않으므로 아무것도 시작되지 않았습니다.",
  "helpers.declined": "나중에: 도우미 레인이 시작되지 않았습니다.",
  "helpers.gone": "더 이상 열려 있지 않아 도우미 레인이 시작되지 않았습니다.",
  "helpers.refusal.already_decided": "이미 결정되었습니다.",
  "helpers.refusal.superseded": "더 이상 열려 있지 않습니다. Kit의 턴이 넘어갔습니다.",
  "helpers.refusal.roundsSpent": "이 메시지는 도우미 레인 라운드 {max}번을 모두 썼습니다.",
  "helpers.refusal.other": "받아들여지지 않았습니다 ({code}).",
  // the chat's line when a request shows no card
  "helpers.refused": "Kit이 도우미 레인을 요청했지만 Manut AI가 요청을 읽을 수 없었습니다: {why}. 아무것도 시작되지 않았습니다.",
  "helpers.why.json": "블록이 올바른 JSON이 아닙니다",
  "helpers.why.shape": "블록이 도우미 하나도, 그 목록도 아닙니다",
  "helpers.why.empty": "블록에 도우미 레인이 없습니다",
  "helpers.why.key": "블록에 Manut AI가 받지 않는 키가 있습니다 ({key})",
  "helpers.why.value": "{key}은(는) 한 줄의 텍스트여야 합니다",
  "helpers.why.brief": "지시가 없는 도우미 레인이 있습니다",
  "helpers.why.long": "지시가 {max}자를 넘습니다",
  "helpers.why.unclosed": "블록이 닫히지 않았습니다",
  "helpers.spent": "Kit이 다시 도우미 레인을 요청했습니다. 이 메시지는 라운드 {max}번을 모두 썼으므로 아무것도 시작되지 않고 Kit이 직접 마무리합니다.",
  "helpers.unfinished": "Kit이 끝나지 않은 턴에서 도우미 레인을 요청했으므로 아무것도 시작되지 않습니다.",
  "helpers.switchedOff": "도우미가 꺼진 뒤에 Kit이 도우미 레인을 요청했으므로 아무것도 시작되지 않습니다.",
};
