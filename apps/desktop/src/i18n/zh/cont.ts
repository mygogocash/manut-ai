import type { cont as en } from "../en/cont";

export const cont: Record<keyof typeof en, string> = {
  "cont.menu": "换一个智能体继续…",
  "cont.tip": "{agent}。用另一个智能体或模型继续这项工作",
  "cont.note": "在这个聊天工作的地方打开一个新聊天，把这个聊天的上下文放在输入框上方，不会发送。这个聊天保持原样。",
  "cont.none": "没有安装其他可以聊天的智能体",
  "cont.failed": "无法继续 · {error}",
  "cont.in": "已在 {agent} 中继续",
  "cont.from": "从 {agent} 继续而来",
  "cont.open": "打开",
  "cont.stop": "在这里停止 {agent}",
  "cont.stopTip": "它现在没有在工作。它的程序会结束，这个聊天会保留，可以打开。",
  "cont.wait": "{agent} 正在这个工作线中工作。请等它完成后再发送：一个工作线一次只有一个智能体工作。",
};
