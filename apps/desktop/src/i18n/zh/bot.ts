import type { bot as en } from "../en/bot";

export const bot: Record<keyof typeof en, string> = {
  // settings, appearance, bot identity, providers, add a bot (i18n 0.2.5)
  "bot.online": "已连接",
  "bot.offline": "未连接",
  "bot.starting": "正在启动…",
  "bot.working": "工作中",
  "bot.connecting": "正在连接…",
};
