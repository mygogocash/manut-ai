import type { history as en } from "../en/history";

export const history: Record<keyof typeof en, string> = {
  "history.find": "搜索历史记录",
  "history.findPh": "搜索标题和最新消息",
  "history.emptyTitle": "还没有记录",
  "history.emptyText": "与 Buddy 和团队的线程会按从新到旧的顺序显示在这里。",
  "history.none": "没有与“{q}”匹配的线程",
  // where a job's page and the activity log are opened from
  "history.kind.job": "工作",
  "history.show": "显示",
  "history.lane.all": "全部",
  "history.archive": "归档",
  "history.archiveN": "归档 ({n})",
};
