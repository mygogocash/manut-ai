import type { several as en } from "../en/several";

export const several: Record<keyof typeof en, string> = {
  // Ask several agents (item 102a): the + menu's row, its panel, and a job's row in the Lanes band
  "several.row": "여러 에이전트에게 요청…",
  "several.tip": "메시지 하나를 최대 {max}개의 에이전트에게 보냅니다. 각각 자기만의 레인에서 시작하고, 무언가 바꾸기 전에 먼저 묻습니다.",
  "several.title": "여러 에이전트에게 요청",
  "several.back": "뒤로",
  "several.lead": "메시지 하나를 최대 {max}개의 에이전트에게 보냅니다. 각각 먼저 묻는 모드로, 자기만의 레인에서 시작합니다. 보내기를 누르기 전에는 아무것도 전송되지 않습니다.",
  "several.agent": "에이전트",
  "several.model": "모델",
  "several.effort": "추론 강도",
  "several.own": "에이전트 기본값",
  "several.remove": "이 에이전트 빼기",
  "several.add": "에이전트 추가",
  "several.cap": "한 번에 최대 {max}개의 에이전트까지 요청할 수 있습니다.",
  "several.foot": "각 에이전트의 질문은 그 에이전트의 레인으로 옵니다. 대신 답해 주는 것은 없습니다.",
  "several.err.few": "에이전트를 {min}개 이상 고르세요.",
  "several.err.many": "에이전트는 최대 {max}개까지 고를 수 있습니다.",
  "several.err.empty": "먼저 메시지를 작성하세요.",
  "several.err.folder": "먼저 폴더를 고르세요.",
  "several.err.agent": "{agent}은(는) 여기서 레인을 시작할 수 없습니다.",
  "several.err.limited": "{agent}의 사용 한도에 도달했습니다. 다른 에이전트를 고르거나 초기화될 때까지 기다리세요.",
  "several.err.noLane": "이 폴더는 저장소가 아니어서 에이전트를 자기만의 레인에서 시작할 수 없습니다. 아무것도 시작하지 않았습니다.",
  "several.jobRow": "에이전트 {n}개: {title}",
  "several.jobTip": "이 작업의 레인을 보이거나 숨깁니다",
  "several.lane.note": "이 레인은 같은 메시지로 시작한 {n}개 중 하나이며, 각각 다른 에이전트가 맡습니다. 각 에이전트는 무언가 바꾸기 전에 먼저 묻습니다.",
};
