import type { tl as en } from "../en/tl";

export const tl: Record<keyof typeof en, string> = {
  "tl.offline": "{bot} 未连接。",
  "tl.loading": "加载中…",
  "tl.unreachable": "无法连接 {bot}（{error}）。请稍后再试。",
  "tl.noModel": "{bot} 还没有模型。请在右上角的模型菜单中选择一个后开始。",
  "tl.jump": "跳到底部",
  "tl.jumpNew": "{n} 条新消息",
  "tl.pinnedOwn": "你的消息：{text}",
  "tl.sayHi": "和 {bot} 打个招呼吧",
};
