import type { several as en } from "../en/several";

export const several: Record<keyof typeof en, string> = {
  // Ask several agents (item 102a): the + menu's row, its panel, and a job's row in the Lanes band
  "several.row": "同时问多个智能体…",
  "several.tip": "把一条消息发给最多 {max} 个智能体。每个都在自己的泳道里开始，改动任何东西之前都会先问你。",
  "several.title": "同时问多个智能体",
  "several.back": "返回",
  "several.lead": "一条消息发给最多 {max} 个智能体。每个都以先询问的模式，在自己的泳道里开始。点击发送之前不会发出任何内容。",
  "several.agent": "智能体",
  "several.model": "模型",
  "several.effort": "思考强度",
  "several.own": "智能体默认",
  "several.remove": "移除这个智能体",
  "several.add": "添加智能体",
  "several.cap": "一次最多 {max} 个智能体。",
  "several.foot": "每个智能体的提问都会出现在它自己的泳道里。没有谁会替你回答。",
  "several.err.few": "请至少选 {min} 个智能体。",
  "several.err.many": "最多只能选 {max} 个智能体。",
  "several.err.empty": "请先写一条消息。",
  "several.err.folder": "请先选一个文件夹。",
  "several.err.agent": "{agent} 无法在这里开始泳道。",
  "several.err.limited": "{agent} 已达到使用上限。请换一个智能体，或等它重置。",
  "several.err.noLane": "这个文件夹不是代码仓库，所以智能体无法在自己的泳道里开始。什么都没有开始。",
  "several.jobRow": "{n} 个智能体：{title}",
  "several.jobTip": "显示或隐藏这项任务的泳道",
  "several.lane.note": "这条泳道是同一条消息启动的 {n} 条之一，各用各的智能体。每个改动任何东西之前都会先问你。",
};
