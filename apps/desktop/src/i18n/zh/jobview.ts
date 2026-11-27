import type { jobview as en } from "../en/jobview";

export const jobview: Record<keyof typeof en, string> = {
  // The job's side-by-side view (item 102b)
  "jobview.back": "返回泳道列表",
  "jobview.tabs": "这项任务中的智能体",
  "jobview.openLane": "打开泳道",
  "jobview.stop": "停止",
  "jobview.stopAll": "全部停止",
  "jobview.stopAllAsk": "停止正在工作的 {n} 个智能体吗？",
  "jobview.keep": "继续运行",
  "jobview.again": "再问一次",
  "jobview.againTip": "用同样的智能体和同样的消息打开“询问多个智能体”。点击发送之前不会发出任何内容。",
  "jobview.nothingRuns": "这条泳道里没有正在运行的内容。",
  "jobview.chatLabel": "{agent} 的泳道",
  "jobview.openTip": "并排查看这项任务的智能体",
  "jobview.none": "这项任务已没有泳道。",
};
