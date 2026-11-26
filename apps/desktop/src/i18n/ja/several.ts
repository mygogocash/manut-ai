import type { several as en } from "../en/several";

export const several: Record<keyof typeof en, string> = {
  // Ask several agents (item 102a): the + menu's row, its panel, and a job's row in the Lanes band
  "several.row": "複数のエージェントに頼む…",
  "several.tip": "1 つのメッセージを最大 {max} つのエージェントに送ります。それぞれ専用のレーンで始まり、変更する前に確認します。",
  "several.title": "複数のエージェントに頼む",
  "several.back": "戻る",
  "several.lead": "1 つのメッセージを最大 {max} つのエージェントへ。それぞれ先に確認するモードで、専用のレーンとして始まります。送信を押すまで何も送られません。",
  "several.agent": "エージェント",
  "several.model": "モデル",
  "several.effort": "思考の深さ",
  "several.own": "エージェント標準",
  "several.remove": "このエージェントを外す",
  "several.add": "エージェントを追加",
  "several.cap": "一度に頼めるのは最大 {max} つのエージェントまでです。",
  "several.foot": "各エージェントからの質問は、それぞれのレーンに届きます。あなたの代わりに答えるものはありません。",
  "several.err.few": "エージェントを {min} つ以上選んでください。",
  "several.err.many": "エージェントは {max} つまでです。",
  "several.err.empty": "先にメッセージを書いてください。",
  "several.err.folder": "先にフォルダを選んでください。",
  "several.err.agent": "{agent} はここでレーンを始められません。",
  "several.err.limited": "{agent} は上限に達しています。別のエージェントを選ぶか、リセットを待ってください。",
  "several.err.noLane": "このフォルダはリポジトリではないため、専用のレーンでエージェントを始められません。何も始めていません。",
  "several.jobRow": "{n} つのエージェント: {title}",
  "several.jobTip": "このジョブのレーンを表示または非表示にします",
  "several.lane.note": "このレーンは、同じメッセージから始めた {n} つのうちの 1 つです。それぞれ別のエージェントで、変更する前に確認します。",
};
