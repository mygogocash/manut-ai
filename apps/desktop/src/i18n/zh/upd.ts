import type { upd as en } from "../en/upd";

export const upd: Record<keyof typeof en, string> = {
  "upd.tip": "安装 Manut AI {version} 并重启",
  "upd.retry": "重试更新",
  "upd.to": "更新到 {version}",
  "upd.failed": "更新失败",
  "upd.restarting": "正在重启…",
  "upd.updating": "正在更新…",
  "upd.updatingPct": "正在更新 {n}%",
};
