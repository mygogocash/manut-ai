import type { use as en } from "../en/use";

export const use: Record<keyof typeof en, string> = {
  "use.stale": "没有最近记录",
  "use.none": "暂无用量",
  "use.resetsIn": "{t} 后重置",
  "use.near": "接近上限",
  "use.ok": "正常",
  "use.noRecord": "无记录",
  "use.claudeNext": "在 Manut AI 中 Claude 下次回复后显示",
  "use.cpaLogin": "CLIProxyAPI 登录",
  "use.meter": "{name} 用量：{value}",
  "use.card": "{name} 用量",
  "use.logins": "{n} 个登录",
};
