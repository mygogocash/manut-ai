import type { shops as en } from "../en/shops";

export const shops: Record<keyof typeof en, string> = {
  // the switcher in the account row, and what is said when the person's place in a shop ends (docs/several-shops.md)
  "shops.switch": "お店を切り替える",
  "shops.menu": "あなたのお店",
  "shops.owner": "オーナー",
  "shops.helper": "ヘルパー",
  "shops.aShop": "あるお店",
  "shops.yourShop": "あなたのお店",
  "shops.dismiss": "閉じる",
  "shops.left.removed": "{shop} にはもう入れません。{date} に {owner} さんがあなたを外しました。間違いなら {owner} さんに聞いてください",
  "shops.left.removedNoDate": "{shop} にはもう入れません。{owner} さんがあなたを外しました。間違いなら {owner} さんに聞いてください",
  "shops.left.unlinked": "{shop} にはもう入れません。{date} にあなたのアカウントとこのお店のつながりが外されました",
  "shops.left.unlinkedNoDate": "{shop} にはもう入れません。あなたのアカウントとこのお店のつながりが外されました",
  "shops.left.gone": "{shop} はもうあなたのお店の一覧にありません",
};
