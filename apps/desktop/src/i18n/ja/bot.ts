import type { bot as en } from "../en/bot";

export const bot: Record<keyof typeof en, string> = {
  // settings, appearance, bot identity, providers, add a bot (i18n 0.2.5)
  "bot.online": "接続中",
  "bot.offline": "未接続",
  "bot.starting": "起動中…",
  "bot.working": "作業中",
  "bot.connecting": "接続しています…",
};
