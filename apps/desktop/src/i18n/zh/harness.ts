import type { harness as en } from "../en/harness";

export const harness: Record<keyof typeof en, string> = {
  "harness.working": "正在工作：{who}",
  "harness.trail": "当前位置",
  "harness.openChat": "以聊天打开",
  "harness.closeChat": "返回计划",
  "harness.loading": "正在读取会话…",
  "harness.error": "无法读取会话：{error}",
  "harness.none": "尚未找到这一部分的会话。",
  "harness.noCli": "{agent} 负责了这一部分，但它的会话不在这台电脑上。",
  "harness.openChild": "打开 {name}",
  "harness.session": "会话",
};
