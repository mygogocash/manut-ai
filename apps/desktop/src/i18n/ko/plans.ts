import type { plans as en } from "../en/plans";

export const plans: Record<keyof typeof en, string> = {
  // plans (the Plans tab: the list of a bot's runs)
  "plans.tab": "계획",
  "plans.of": "{bot}의 계획",
  "plans.all": "계획 {n}개 전체",
  "plans.none": "아직 계획이 없어요.",
  "plans.noneHint": "이 봇이 일을 서브에이전트에게 나눠 맡기면, 각 부분과 진행 상황이 여기에 실시간으로 보여요.",
  "plans.noneHow": "시작하려면 작업을 병렬로 나눠 달라고 하거나, 작업과 함께 {cmd}를 보내세요.",
  "plans.noneHowHermes": "봇이 큰 일을 여러 부분으로 계획하려면 oh-my-hermes가 필요한데, 이 컴퓨터에는 없어요. 터미널의 +에서 추가하세요.",
  "plans.stale": "{t} 동안 변경 없음",
  "plans.cli": "CLI 에이전트",
  "plans.cliAll": "CLI 에이전트 ({n})",
  "plans.showAll": "전체 보기 ({n})",
  "plans.fewer": "접기",
  "plans.refresh": "새로 고침",
  "plans.open": "계획 {name} 열기",
  "plans.graph": "계획 그래프",
  "plans.session": "이 세션의 서브에이전트",
  "plans.sessionNone": "이 세션에는 아직 서브에이전트가 없어요.",
};
