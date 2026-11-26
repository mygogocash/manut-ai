import type { omh as en } from "../en/omh";

export const omh: Record<keyof typeof en, string> = {
  // onboarding (the first-run cards and the empty sections' lines)
  "omh.add.line": "oh-my-hermes 추가",
  "omh.add.tip": "Manut AI 첫 실행 화면과 같은 설치 프로그램을 실행해요. 그다음부터 봇이 큰 일을 여러 부분으로 나눠 계획하고, 계획 탭에 보여 줘요.",
  "omh.add.exit": "설치 프로그램이 멈췄어요(exit {code}).",
  "omh.icon": "oh-my-hermes가 설치되어 있지 않아요",
  "omh.pop.body": "설치하면 봇이 큰 일을 여러 부분으로 계획해 나눠 맡기고, 진행 상황을 계획 탭에서 볼 수 있어요.",
  "omh.pop.hide": "다시 보지 않기",
};
