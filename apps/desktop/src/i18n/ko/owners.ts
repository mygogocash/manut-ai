import type { owners as en } from "../en/owners";

export const owners: Record<keyof typeof en, string> = {
  "owners.title": "{owner} 님만 볼 수 있어요",
  "owners.theOwner": "가게 주인",
  "owners.team": "{shop}에서 도우미로 돕고 있어요. 팀과 각 멤버가 하는 일, 모두 일시중지는 {owner} 님의 몫이에요. 나에게 온 요청은 확인 필요에 있어요.",
  "owners.history": "{shop}에서 도우미로 돕고 있어요. 지난 작업은 {owner} 님만 볼 수 있어요. 나에게 온 요청은 확인 필요에 있어요.",
  "owners.activity": "{shop}에서 도우미로 돕고 있어요. 활동 기록은 {owner} 님만 볼 수 있어요. 나에게 온 요청은 확인 필요에 있어요.",
  "owners.automations": "{shop}에서 도우미로 돕고 있어요. 루틴은 {owner} 님만 보고 바꿀 수 있어요. 나에게 온 요청은 확인 필요에 있어요.",
  "owners.working": "{shop}에서 누가 일하고 있는지는 {owner} 님만 볼 수 있어요.",
  "owners.toNeeds": "확인 필요 열기",
};
