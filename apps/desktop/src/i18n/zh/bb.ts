import type { bb as en } from "../en/bb";

export const bb: Record<keyof typeof en, string> = {
  "bb.done0": "没有文件被找回。聊天仍停留在回退后的位置。",
  "bb.done1": "1 个文件已恢复为回退前一刻的样子。聊天仍停留在回退后的位置。",
  "bb.doneN": "{n} 个文件已恢复为回退前一刻的样子。聊天仍停留在回退后的位置。",
  "bb.why.gone": "回退前的文件已不再保留。",
  "bb.title": "找回文件",
  "bb.reading": "正在查看文件…",
  "bb.files1": "1 个文件会恢复为回退前一刻的样子。",
  "bb.filesN": "{n} 个文件会恢复为回退前一刻的样子。",
  "bb.none": "没有文件与回退前不同，所以没有需要找回的内容。",
  "bb.allKept": "会恢复的文件都已勾选为保持现状，所以不会恢复任何文件。",
  "bb.hand": "这些文件在回退之后被手动改过。勾选的文件保持现在的样子。",
  "bb.branch": "之后分支上有了新的提交。文件会找回，提交保持不变。",
  "bb.chat": "聊天仍停留在回退后的位置。Kit 不会记得你回退掉的那几轮。",
  "bb.go": "找回",
  "bb.going": "正在找回…",
  "bb.cancel": "暂不",
  "bb.failed": "没有找回：{error}。文件保持原样。",
};
