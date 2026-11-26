import type { awake as en } from "../en/awake";

export const awake: Record<keyof typeof en, string> = {
  "awake.title": "エージェントの作業中はスリープしない",
  "awake.hint": "エージェントが出力しているかボットが応答している間と、その後1分間はアイドルスリープを止めます。蓋を閉じるとスリープします。",
};
