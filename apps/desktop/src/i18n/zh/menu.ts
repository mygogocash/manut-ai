import type { menu as en } from "../en/menu";

export const menu: Record<keyof typeof en, string> = {
  // the side menu and its pages (src/sidebar/Sidebar.tsx, src/pages/*Page.tsx): the design canvas's menu rows,
  // Recent, and each page's empty state
  "menu.label": "主菜单",
  "menu.home": "Manut AI 首页",
  "menu.new": "新建",
  "menu.needs": "需要你处理",
  "menu.team": "团队",
  "menu.code": "代码",
  "menu.artifacts": "成果",
  "menu.customize": "自定义",
  "menu.history": "历史记录",
  "menu.recent": "最近",
  "menu.budget": "{spent} / {cap}",
  "menu.budgetAria": "本月 AI 预算：已用 {spent}，共 {cap}",
  "menu.plans": "编程工具的套餐",
  "menu.plansNote": "每个编程工具的套餐用了多少，从这台电脑读取。",
  "menu.working": "进行中",
};
