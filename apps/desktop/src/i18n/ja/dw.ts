import type { dw as en } from "../en/dw";

export const dw: Record<keyof typeof en, string> = {
  "dw.show": "図を表示",
  "dw.hide": "図を隠す",
  "dw.by": "{name} が描いた図",
  "dw.title": "{name} が描いた図",
  "dw.closed": "閉じた箱の中の表示です。スクリプトもネットワークも使えず、ファイルやこのアプリにも触れられません。",
  "dw.noScripts": "スクリプトはここでは動かないため、コードで描かれる部分が欠けることがあります。",
  "dw.larger": "大きく開く",
  "dw.close": "閉じる",
  "dw.still": "チャットを軽く保つため、しまいました。",
  "dw.again": "表示",
  "dw.unsafe": "この図は安全に表示できませんでした。",
  "dw.empty": "このブロックには描けるものがありません。",
  "dw.tooBig": "大きすぎて図として表示できません（256 KB 超）。",
  "dw.tooMany": "大きすぎて描けません。5,000 個を超える図形を描くことになります。",
};
