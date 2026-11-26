import type { outposts as en } from "../en/outposts";

export const outposts: Record<keyof typeof en, string> = {
  "outposts.title": "お店のアウトポスト",
  "outposts.hint": "お店のすべてのマシンを、付けた名前で表示します。見分けやすいように名前を変えましょう。削除すると、そのマシンの作業はすぐに止まります。",
  "outposts.empty": "アウトポストはまだありません。",
  "outposts.noOther": "ほかのアウトポストはまだありません。",
  "outposts.mac": "アプリの入ったMac、{day}に追加",
  "outposts.cloud": "作業が来ると起動します。スリープ中は費用がかかりません。",
  "outposts.rename": "名前を変更",
  "outposts.newName": "{name}の新しい名前",
  "outposts.remove": "削除",
  "outposts.removeAsk": "{name}を削除しますか？作業はすぐに止まり、もう一度使うには再登録が必要です。",
  "outposts.keep": "残す",
  "outposts.renamed": "名前を{name}に変更しました。",
  "outposts.removed": "削除しました。{name}はもうチームのために作業しません。",
};
