import type { omhp as en } from "../en/omhp";

export const omhp: Record<keyof typeof en, string> = {
  "omhp.ready": "oh-my-hermes 已就绪。要设置模型吗？",
  "omhp.fill": "放入输入框",
  "omhp.ask": "用这台电脑上已有的提供商帮我设置模型。应用任何更改之前，先告诉我会改动什么。",
  "omhp.noSkills": "{bot} 还没有列出 oh-my-hermes 的技能。",
  "omhp.tools": "{bot} 还没有 oh-my-hermes 的工具（子代理计划等）。模型设置不需要这些工具。",
};
