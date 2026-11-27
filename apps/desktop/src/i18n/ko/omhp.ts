import type { omhp as en } from "../en/omhp";

export const omhp: Record<keyof typeof en, string> = {
  "omhp.ready": "oh-my-hermes가 준비됐어요. 모델을 설정할까요?",
  "omhp.fill": "입력창에 넣기",
  "omhp.ask": "이 컴퓨터에 이미 있는 프로바이더로 내 모델을 설정해 줘. 적용하기 전에 무엇이 바뀌는지 먼저 보여 줘.",
  "omhp.noSkills": "{bot} 봇에는 아직 oh-my-hermes 스킬이 보이지 않아요.",
  "omhp.tools": "{bot} 봇에는 아직 oh-my-hermes 도구(서브에이전트 계획 등)가 없어요. 모델 설정은 도구 없이도 돼요.",
};
