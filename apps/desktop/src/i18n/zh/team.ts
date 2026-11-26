import type { team as en } from "../en/team";

export const team: Record<keyof typeof en, string> = {
  "team.stuck": "未能完成",
  "team.emptyTitle": "还没有团队",
  "team.emptyText": "应用连接到 Buddy 和团队后，会显示在这里。",
  // Pause everyone, on the Team page (src/pages/TeamPage.tsx)
  "team.paused": "已暂停",
  // a member's line on the Team page: what they are doing, what waits for them, or why they are not at work
  "team.line.working": "正在工作",
  "team.line.pausedSince": "自 {since} 起已暂停，不会开始新工作。",
  "team.line.paused": "已暂停，不会开始新工作。",
  "team.line.stuck": "上一项工作中途停了下来。",
  "team.line.idleLast": "现在没有要做的事。上一项工作：{when}。",
  "team.line.idle": "现在没有要做的事。",
};
