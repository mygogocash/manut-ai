import type { live as en } from "../en/live";

export const live: Record<keyof typeof en, string> = {
  "live.running": "正在运行",
  "live.reading": "正在读取",
  "live.searching": "正在搜索",
  "live.searchingWeb": "正在搜索网页",
  "live.editing": "正在编辑",
  "live.asking": "正在委派",
  "live.usingSkill": "正在使用技能",
  "live.waitApproval": "需要你处理",
  "live.retrying": "正在重试 {n}/{max}",
  "live.waitAnswer": "等待你的回复",
  "live.lost": "连接已断开",
};
