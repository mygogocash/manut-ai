import type { att as en } from "../en/att";

export const att: Record<keyof typeof en, string> = {
  "att.attach": "添加附件",
  "att.addFiles": "添加照片和文件",
  "att.plugins": "技能和工具",
  "att.pluginsLoading": "正在读取插件…",
  "att.pluginsManage": "管理插件",
  "att.pluginsNone": "还没有插件 · 添加",
  "att.usePlugin": "使用 {plugin}：",
  "att.removeOf": "移除 {name}",
  "att.drop": "拖放到此处添加附件",
  "att.tooMany": "超过 {n} 个文件",
  "att.tooBig": "超过 100 MB",
  "att.failed": "无法添加 {name} · {error}",
  "att.readFailed": "无法读取文件",
};
