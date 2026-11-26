import type { outposts as en } from "../en/outposts";

export const outposts: Record<keyof typeof en, string> = {
  "outposts.title": "가게의 아웃포스트",
  "outposts.hint": "가게의 모든 컴퓨터를 붙인 이름으로 보여 줘요. 구별하기 쉽게 이름을 바꾸세요. 지우면 그 컴퓨터의 일이 바로 멈춰요.",
  "outposts.empty": "아직 아웃포스트가 없어요.",
  "outposts.noOther": "아직 다른 아웃포스트가 없어요.",
  "outposts.mac": "앱이 설치된 Mac, {day}에 추가됨",
  "outposts.cloud": "일이 생기면 깨어나요. 잠자는 동안에는 비용이 들지 않아요.",
  "outposts.rename": "이름 바꾸기",
  "outposts.newName": "{name}의 새 이름",
  "outposts.remove": "지우기",
  "outposts.removeAsk": "{name}을(를) 지울까요? 일이 바로 멈추고, 다시 일하려면 다시 등록해야 해요.",
  "outposts.keep": "그대로 두기",
  "outposts.renamed": "이름을 {name}(으)로 바꿨어요.",
  "outposts.removed": "지웠어요. {name}은(는) 이제 팀을 위해 일하지 않아요.",
};
