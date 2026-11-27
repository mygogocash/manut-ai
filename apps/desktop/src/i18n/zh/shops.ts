import type { shops as en } from "../en/shops";

export const shops: Record<keyof typeof en, string> = {
  // the switcher in the account row, and what is said when the person's place in a shop ends (docs/several-shops.md)
  "shops.switch": "切换店铺",
  "shops.menu": "你的店铺",
  "shops.owner": "店主",
  "shops.helper": "帮手",
  "shops.aShop": "一家店",
  "shops.yourShop": "你的店",
  "shops.dismiss": "关闭",
  "shops.left.removed": "你已无法再进入 {shop}。{owner} 已在 {date} 把你移出。如果弄错了，请问问 {owner}",
  "shops.left.removedNoDate": "你已无法再进入 {shop}。{owner} 已把你移出。如果弄错了，请问问 {owner}",
  "shops.left.unlinked": "你已无法再进入 {shop}。你的账号已在 {date} 与这家店解除关联",
  "shops.left.unlinkedNoDate": "你已无法再进入 {shop}。你的账号已与这家店解除关联",
  "shops.left.gone": "{shop} 已不在你的店铺列表里",
};
