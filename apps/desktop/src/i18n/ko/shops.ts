import type { shops as en } from "../en/shops";

export const shops: Record<keyof typeof en, string> = {
  // the switcher in the account row, and what is said when the person's place in a shop ends (docs/several-shops.md)
  "shops.switch": "가게 바꾸기",
  "shops.menu": "내 가게",
  "shops.owner": "주인",
  "shops.helper": "도우미",
  "shops.aShop": "어느 가게",
  "shops.yourShop": "내 가게",
  "shops.dismiss": "닫기",
  "shops.left.removed": "이제 {shop}에 들어갈 수 없어요. {owner} 님이 {date}에 나를 내보냈어요. 실수라면 {owner} 님에게 물어보세요",
  "shops.left.removedNoDate": "이제 {shop}에 들어갈 수 없어요. {owner} 님이 나를 내보냈어요. 실수라면 {owner} 님에게 물어보세요",
  "shops.left.unlinked": "이제 {shop}에 들어갈 수 없어요. {date}에 내 계정과 이 가게의 연결이 끊겼어요",
  "shops.left.unlinkedNoDate": "이제 {shop}에 들어갈 수 없어요. 내 계정과 이 가게의 연결이 끊겼어요",
  "shops.left.gone": "{shop}은(는) 이제 내 가게 목록에 없어요",
};
