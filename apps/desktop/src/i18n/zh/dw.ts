import type { dw as en } from "../en/dw";

export const dw: Record<keyof typeof en, string> = {
  "dw.show": "显示图",
  "dw.hide": "隐藏图",
  "dw.by": "{name} 画的图",
  "dw.title": "{name} 画的图",
  "dw.closed": "在封闭的框中显示：不运行脚本，不联网，也无法访问你的文件或本应用。",
  "dw.noScripts": "脚本不会在这里运行，所以由代码画出的部分可能缺失。",
  "dw.larger": "放大打开",
  "dw.close": "关闭",
  "dw.still": "为了让聊天保持轻快，已收起。",
  "dw.again": "显示",
  "dw.unsafe": "无法安全地显示这张图。",
  "dw.empty": "这个代码块里没有可画的内容。",
  "dw.tooBig": "太大了，无法作为图显示（超过 256 KB）。",
  "dw.tooMany": "太大，无法绘制：它会画出超过 5,000 个图形。",
};
