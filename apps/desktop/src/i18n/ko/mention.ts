import type { mention as en } from "../en/mention";

export const mention: Record<keyof typeof en, string> = {
  // mentions (`@name` of a bot in chat text)
  "mention.open": "{bot} 열기",
};
