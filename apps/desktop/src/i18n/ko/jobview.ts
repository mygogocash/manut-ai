import type { jobview as en } from "../en/jobview";

export const jobview: Record<keyof typeof en, string> = {
  // The job's side-by-side view (item 102b)
  "jobview.back": "레인 목록으로",
  "jobview.tabs": "이 작업의 에이전트",
  "jobview.openLane": "레인 열기",
  "jobview.stop": "중지",
  "jobview.stopAll": "모두 중지",
  "jobview.stopAllAsk": "작업 중인 에이전트 {n}개를 모두 중지할까요?",
  "jobview.keep": "계속하기",
  "jobview.again": "다시 요청",
  "jobview.againTip": "같은 에이전트와 같은 메시지로 '여러 에이전트에게 요청'을 엽니다. 보내기를 누르기 전에는 아무것도 보내지 않습니다.",
  "jobview.nothingRuns": "이 레인에서는 실행 중인 것이 없습니다.",
  "jobview.chatLabel": "{agent}의 레인",
  "jobview.openTip": "이 작업의 에이전트를 나란히 보기",
  "jobview.none": "이 작업에는 남은 레인이 없습니다.",
};
