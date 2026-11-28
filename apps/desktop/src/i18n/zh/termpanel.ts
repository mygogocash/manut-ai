import type { termpanel as en } from "../en/termpanel";

export const termpanel: Record<keyof typeof en, string> = {
  // termpanel (the bottom terminal panel, Ctrl+`)
  "termpanel.label": "终端",
  "termpanel.tabs": "终端标签页",
  "termpanel.newTab": "新建终端",
  "termpanel.closeTab": "关闭 {name}",
  "termpanel.hide": "隐藏终端",
  "termpanel.resize": "终端高度",
  "termpanel.home": "主文件夹",
  "termpanel.ended": "shell 已结束",
  "termpanel.endedCode": "shell 已结束，代码 {code}",
  "termpanel.couldNotStart": "无法启动 shell：{error}",
  "termpanel.divider": "调整分屏大小（双击：均分）",
  "termpanel.rang": "响铃了",
  "termpanel.splitRight": "向右拆分（{keys}）",
};
