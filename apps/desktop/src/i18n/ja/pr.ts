import type { pr as en } from "../en/pr";

export const pr: Record<keyof typeof en, string> = {
  "pr.open": "オープン",
  "pr.merged": "マージ済み",
  "pr.closed": "クローズ",
  "pr.draft": "ドラフト",
  "pr.onGithub": "GitHubで{pr}を開く",
};
