import type { outposts as en } from "../en/outposts";

export const outposts: Record<keyof typeof en, string> = {
  "outposts.title": "你店铺的前哨",
  "outposts.hint": "按名称列出你店铺的每台机器。重命名可以方便区分它们。删除后，它的工作会立即停止。",
  "outposts.empty": "还没有前哨。",
  "outposts.noOther": "还没有其他前哨。",
  "outposts.mac": "装有应用的 Mac，添加于 {day}",
  "outposts.cloud": "有工作时唤醒。休眠时不产生费用。",
  "outposts.rename": "重命名",
  "outposts.newName": "{name} 的新名称",
  "outposts.remove": "删除",
  "outposts.removeAsk": "要删除 {name} 吗？它的工作会立即停止，必须重新注册才能再工作。",
  "outposts.keep": "保留",
  "outposts.renamed": "已重命名为 {name}。",
  "outposts.removed": "已删除。{name} 不再为你的团队工作。",
};
