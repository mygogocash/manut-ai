import type { inbox as en } from "../en/inbox";

export const inbox: Record<keyof typeof en, string> = {
  "inbox.group": "侧边菜单",
  "inbox.working": "进行中分组",
  "inbox.workingHint": "正在进行的聊天会放在“最近”下方一个安静的“进行中”分组里，完成后回到最上面。需要你处理的聊天始终留在“最近”里。",
  "inbox.quiet": "安静几天后完成",
  "inbox.quietHint": "在这么多天里双方都没有消息、也没有等你处理的事的聊天或工作线，会被标为“暂时完成”。不会丢失任何内容，打开它或它有问题要问你时会回来。",
  "inbox.day1": "1 天",
  "inbox.days": "{n} 天",
  "inbox.merged": "拉取请求合并后完成",
  "inbox.mergedHint": "GitHub 或 GitLab 表示其拉取请求已合并的工作线，会被标为“暂时完成”。不会丢失任何内容，打开它就会回来。",
};
