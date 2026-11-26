import type { editor as en } from "../en/editor";

export const editor: Record<keyof typeof en, string> = {
  "editor.open": "在 {name} 中打开",
  "editor.openAny": "在编辑器中打开",
  "editor.openProject": "在 {name} 中打开项目",
  "editor.openSession": "在 {name} 中打开此会话的文件夹",
  "editor.title": "编辑器",
  "editor.hint": "“在编辑器中打开”用来打开文件夹的应用。自动会使用这台电脑上找到的第一个，顺序为：Visual Studio Code、Cursor、Windsurf、Zed、Xcode（仅 Mac）。",
  "editor.auto": "自动",
  "editor.none": "这台电脑上没有找到编辑器，所以不提供“在编辑器中打开”。会查找 Visual Studio Code、Cursor、Windsurf、Zed 和 Xcode（仅 Mac）。",
  "editor.gone": "这台电脑上没有找到 {name}，所以使用找到的第一个编辑器。",
  "editor.fail.gone": "文件夹已不存在，所以没有打开。",
  "editor.fail.folder": "这不是文件夹，所以没有打开。",
  "editor.fail.missing": "这台电脑上没有找到编辑器，所以什么也没有打开。",
  "editor.fail.other": "编辑器没有打开。没有改动任何内容。",
};
