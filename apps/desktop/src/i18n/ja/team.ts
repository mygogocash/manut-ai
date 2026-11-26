import type { team as en } from "../en/team";

export const team: Record<keyof typeof en, string> = {
  "team.stuck": "完了できませんでした",
  "team.emptyTitle": "まだチームがいません",
  "team.emptyText": "アプリが Buddy とチームにつながると、ここに表示されます。",
  // Pause everyone, on the Team page (src/pages/TeamPage.tsx)
  "team.paused": "一時停止中",
  // a member's line on the Team page: what they are doing, what waits for them, or why they are not at work
  "team.line.working": "いま作業中",
  "team.line.pausedSince": "{since}から一時停止中。新しい作業は始めません。",
  "team.line.paused": "一時停止中。新しい作業は始めません。",
  "team.line.stuck": "前回の仕事が途中で止まりました。",
  "team.line.idleLast": "いまはやることがありません。最後の仕事：{when}。",
  "team.line.idle": "いまはやることがありません。",
};
