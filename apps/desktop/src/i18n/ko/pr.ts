import type { pr as en } from "../en/pr";

export const pr: Record<keyof typeof en, string> = {
  "pr.open": "열림",
  "pr.merged": "병합됨",
  "pr.closed": "닫힘",
  "pr.draft": "초안",
  "pr.onGithub": "GitHub에서 {pr} 열기",
};
