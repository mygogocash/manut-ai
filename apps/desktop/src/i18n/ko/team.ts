import type { team as en } from "../en/team";

export const team: Record<keyof typeof en, string> = {
  "team.stuck": "끝내지 못함",
  "team.emptyTitle": "아직 팀이 없어요",
  "team.emptyText": "앱이 Buddy와 팀에 연결되면 여기에 표시돼요.",
  // Pause everyone, on the Team page (src/pages/TeamPage.tsx)
  "team.paused": "일시중지됨",
  // a member's line on the Team page: what they are doing, what waits for them, or why they are not at work
  "team.line.working": "지금 작업 중",
  "team.line.pausedSince": "{since}부터 일시중지됨. 새 작업을 시작하지 않아요.",
  "team.line.paused": "일시중지됨. 새 작업을 시작하지 않아요.",
  "team.line.stuck": "마지막 작업이 도중에 멈췄어요.",
  "team.line.idleLast": "지금은 할 일이 없어요. 마지막 작업: {when}.",
  "team.line.idle": "지금은 할 일이 없어요.",
};
