import type { mode as en } from "../en/mode";

export const mode: Record<keyof typeof en, string> = {
  "mode.practice": "练习模式",
  "mode.connected": "已连接到 {host}",
  "mode.connecting": "正在连接 {host}…",
  "mode.signedOut": "已退出登录 · {host}",
  "mode.offline": "离线 · {host}",
  "mode.unavailable": "无响应 · {host}",
  "mode.cachedOffline": "离线。显示的是 {time} 时的内容",
  "mode.cachedUnavailable": "无响应。显示的是 {time} 时的内容",
  "mode.oldOffline": "离线。已保存的副本超过 7 天，因此不再显示",
  "mode.oldUnavailable": "无响应。已保存的副本超过 7 天，因此不再显示",
  "mode.unkeptOffline": "离线。这台电脑还不能保存副本，因此没有可显示的内容",
  "mode.unkeptUnavailable": "无响应。这台电脑还不能保存副本，因此没有可显示的内容",
  "mode.open": "运行时设置",
};
