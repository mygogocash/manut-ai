import type { owners as en } from "../en/owners";

export const owners: Record<keyof typeof en, string> = {
  "owners.title": "見られるのは{owner}さんだけです",
  "owners.theOwner": "オーナー",
  "owners.team": "あなたは{shop}をヘルパーとして手伝っています。チーム、各メンバーの作業、全員を一時停止は{owner}さんのものです。あなたへの依頼は「対応が必要」にあります。",
  "owners.history": "あなたは{shop}をヘルパーとして手伝っています。これまでの作業を見られるのは{owner}さんだけです。あなたへの依頼は「対応が必要」にあります。",
  "owners.activity": "あなたは{shop}をヘルパーとして手伝っています。アクティビティログを見られるのは{owner}さんだけです。あなたへの依頼は「対応が必要」にあります。",
  "owners.automations": "あなたは{shop}をヘルパーとして手伝っています。ルーティンを見て変えられるのは{owner}さんだけです。あなたへの依頼は「対応が必要」にあります。",
  "owners.working": "{shop}で誰が作業中かを見られるのは{owner}さんだけです。",
  "owners.toNeeds": "「対応が必要」を開く",
};
