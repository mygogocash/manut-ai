import type { bot as en } from "../en/bot";

export const bot: Record<keyof typeof en, string> = {
  // settings, appearance, bot identity, providers, add a bot (i18n 0.2.5)
  "bot.online": "연결됨",
  "bot.offline": "연결 안 됨",
  "bot.starting": "시작하는 중…",
  "bot.working": "작업 중",
  "bot.connecting": "연결하는 중…",
};
