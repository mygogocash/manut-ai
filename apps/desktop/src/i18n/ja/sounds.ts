import type { sounds as en } from "../en/sounds";

export const sounds: Record<keyof typeof en, string> = {
  // sounds (Settings › General)
  "sounds.title": "サウンド",
  "sounds.hint": "送信、ボットの回答や質問、エラーのときに小さな音",
  "sounds.play": "再生",
  "sounds.on": "オン",
  "sounds.off": "オフ",
  // finish chime, tone, settle and effort sounds (item 131)
  "sounds.group": "サウンドとチャイム",
  "sounds.finish": "完了のチャイム",
  "sounds.finishHint": "見ていないチャットがターンを終えたとき、やわらかいチャイムを鳴らします。静かな時間帯は鳴りません",
  "sounds.tone": "完了の音",
  "sounds.toneHint": "ターンが終わったときに鳴る音。内蔵のチャイムか、トーンから選べます",
  "sounds.preview": "試聴",
  "sounds.tone.default": "デフォルト",
  "sounds.settle": "いったん完了の音",
  "sounds.settleHint": "「いったん完了」でチャットを片付けたとき、小さなカチッという音を鳴らします",
  "sounds.effort": "Effort スライダーの音",
  "sounds.effortHint": "ドラッグで各段階を通るたびにカチッと鳴り、上がるほど音が高くなります。最大では短い衝撃音が鳴ります",
  "sounds.tone.heaven": "Heaven",
  "sounds.tone.highwire": "Highwire",
  "sounds.tone.iridium": "Iridium",
  "sounds.tone.krypton": "Krypton",
  "sounds.tone.kzurbSonar": "Kzurb Sonar",
};
