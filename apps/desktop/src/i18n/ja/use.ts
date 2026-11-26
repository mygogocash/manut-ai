import type { use as en } from "../en/use";

export const use: Record<keyof typeof en, string> = {
  "use.stale": "最近の記録なし",
  "use.none": "まだ使用量はありません",
  "use.resetsIn": "{t} 後にリセット",
  "use.near": "上限間近",
  "use.ok": "正常",
  "use.noRecord": "記録なし",
  "use.claudeNext": "Manut AI で次に Claude が応答すると表示されます",
  "use.cpaLogin": "CLIProxyAPI ログイン",
  "use.meter": "{name} の使用量: {value}",
  "use.card": "{name} の使用量",
  "use.logins": "ログイン {n} 件",
};
