import type { omh as en } from "../en/omh";

export const omh: Record<keyof typeof en, string> = {
  // onboarding (the first-run cards and the empty sections' lines)
  "omh.add.line": "添加 oh-my-hermes",
  "omh.add.tip": "运行与 Manut AI 首次启动界面相同的安装程序。之后机器人会把大任务分成几部分来计划，并显示在 Plans 里。",
  "omh.add.exit": "安装程序已停止（exit {code}）。",
  "omh.icon": "未安装 oh-my-hermes",
  "omh.pop.body": "装上后，机器人会把大任务分成几部分来计划并分派出去，计划的进展会显示在 Plans 里。",
  "omh.pop.hide": "不再显示",
};
