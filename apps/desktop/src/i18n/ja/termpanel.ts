import type { termpanel as en } from "../en/termpanel";

export const termpanel: Record<keyof typeof en, string> = {
  // termpanel (the bottom terminal panel, Ctrl+`)
  "termpanel.label": "ターミナル",
  "termpanel.tabs": "ターミナルのタブ",
  "termpanel.newTab": "新しいターミナル",
  "termpanel.closeTab": "{name} を閉じる",
  "termpanel.hide": "ターミナルを隠す",
  "termpanel.resize": "ターミナルの高さ",
  "termpanel.home": "ホームフォルダ",
  "termpanel.ended": "シェルが終了しました",
  "termpanel.endedCode": "シェルがコード {code} で終了しました",
  "termpanel.couldNotStart": "シェルを起動できませんでした: {error}",
  "termpanel.divider": "ペインのサイズ変更（ダブルクリックで均等）",
  "termpanel.rang": "ベルが鳴りました",
  "termpanel.splitRight": "右に分割（{keys}）",
};
