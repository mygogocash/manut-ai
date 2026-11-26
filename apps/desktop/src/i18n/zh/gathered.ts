import type { gathered as en } from "../en/gathered";

export const gathered: Record<keyof typeof en, string> = {
  // The gathered answers of a job (item 102c)
  "gathered.tab": "汇总 {n}/{total}",
  "gathered.count": "汇总：{total} 个中已有 {n} 个回答",
  "gathered.compare": "在聊天中比较…",
  "gathered.compareTip": "把这些回答放进某个聊天的输入框，不会发送。在那个聊天里按发送之前，什么都不会发出。",
  "gathered.compareNeed": "比较需要两个回答。",
  "gathered.answer": "去回答",
  "gathered.waitingCount": "{n} 个在等你回应",
  "gathered.laneLabel": "{agent} 的回答",
  "gathered.waiting": "正在等你回应。它到目前为止写的内容不算回答。",
  "gathered.working": "仍在工作。",
  "gathered.failed": "没有给出回答就停止了。",
  "gathered.none": "还没有回答。",
  "gathered.files": "改动的文件：{n}",
  "gathered.noFiles": "没有改动文件",
  "gathered.filesMore": "另有 {n} 个",
  "gathered.tests": "测试",
  "gathered.noTests": "没有运行测试",
  "gathered.put": "{title} 的输入框里已放入 {n} 个回答。在那个聊天里按发送之前，什么都不会发出。",
  "gathered.open": "打开那个聊天",
  "gathered.gone": "{title} 已不存在。",
};
