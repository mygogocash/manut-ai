import type { customize as en } from "../en/customize";

export const customize: Record<keyof typeof en, string> = {
  "customize.automations": "团队按计划执行的任务",
  "customize.allRoutines": "全部定时任务",
  "customize.plugins": "团队成员可以使用的技能和工具",
  "customize.emptyTitle": "还没有记住任何内容",
  "customize.emptyText": "团队了解到的店铺信息会显示在这里。",
  // 自定义 › 连接：把这台 Mac 用作店铺的前哨
  "customize.tab.memory": "记忆与定时任务",
  "customize.tab.connections": "连接",
};
