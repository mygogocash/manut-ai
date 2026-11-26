import type { gate as en } from "../en/gate";

export const gate: Record<keyof typeof en, string> = {
  "gate.failedHead": "安装没有完成",
  "gate.head": "先安装 Hermes 再开始",
  "gate.text": "机器人运行在 Hermes Agent 上，本机还没有安装。点“安装”会运行下面的命令：先装 Hermes，再装 oh-my-hermes。",
  "gate.copyCmd": "复制命令",
  "gate.copy": "复制",
  "gate.copied": "已复制",
  "gate.couldNotRun": "安装程序无法运行。",
  "gate.stopped": "安装程序已停止（exit {code}）。原因见上方输出，修复后再点“安装”。",
  "gate.installing": "正在安装…",
  "gate.again": "重新安装",
  "gate.install": "安装",
  "gate.check": "重新检查",
  "gate.note": "需要几分钟。之后在应用里选择模型。",
  "gate.unreachable": "Manut AI 无法连接 Hermes",
  "gate.starting": "正在启动 Manut AI…",
  "gate.noBridge": "本地桥接没有启动。",
  "gate.retry": "重试",
  "gate.reviving": "正在重新启动桥接…",
};
