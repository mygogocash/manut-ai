import type { nav as en } from "../en/nav";

export const nav: Record<keyof typeof en, string> = {
  // sidebar nav (the foot of the sidebar) and its search
  "nav.automations": "定时任务",
  "nav.plugins": "技能和工具",
  "nav.settings": "设置",
  "nav.search": "搜索",
  "nav.searchBots": "搜索机器人和终端",
  "nav.addBot": "添加机器人",
  "nav.bots": "团队",
  "nav.sessions": "会话",
  "nav.you": "我",
  "nav.accounts": "账号",
  // termui: TERMINALS (terminal sessions) and the sidebar dock
  "nav.terminals": "终端",
};
