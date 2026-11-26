import type { plans as en } from "../en/plans";

export const plans: Record<keyof typeof en, string> = {
  // plans (the Plans tab: the list of a bot's runs)
  "plans.tab": "计划",
  "plans.of": "{bot}的计划",
  "plans.all": "全部 {n} 个计划",
  "plans.none": "还没有计划。",
  "plans.noneHint": "这个机器人把工作分给子代理后，每个部分和进度都会实时显示在这里。",
  "plans.noneHow": "要开始，请让它把任务拆成并行部分，或连同任务发送 {cmd}。",
  "plans.noneHowHermes": "机器人要把大任务分成几部分来计划，需要 oh-my-hermes，但这台电脑上没有。可在终端的 + 中添加。",
  "plans.stale": "{t}无更新",
  "plans.cli": "CLI 代理",
  "plans.cliAll": "CLI 代理（{n}）",
  "plans.showAll": "显示全部 ({n})",
  "plans.fewer": "收起",
  "plans.refresh": "刷新",
  "plans.open": "打开计划 {name}",
  "plans.graph": "计划图",
  "plans.session": "本会话的子代理",
  "plans.sessionNone": "本会话还没有子代理。",
};
