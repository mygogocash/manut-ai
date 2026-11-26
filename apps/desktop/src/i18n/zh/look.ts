import type { look as en } from "../en/look";

export const look: Record<keyof typeof en, string> = {
  "look.theme": "主题",
  "look.themeHint": "“跟随系统”会使用操作系统的外观设置。",
  "look.system": "跟随系统",
  "look.dark": "深色",
  "look.light": "浅色",
  "look.bubbles": "气泡",
  "look.soft": "柔和",
  "look.solid": "实色",
  "look.open": "无框",
  "look.softHint": "双方都用浅色气泡。",
  "look.solidHint": "你的消息使用强调色。",
  "look.openHint": "机器人直接写在页面上，只有你的消息在气泡里。",
  "look.size": "文字大小",
  "look.sizeHint": "应用于消息和输入框。",
  "look.small": "小",
  "look.medium": "中",
  "look.large": "大",
  "look.pvAsk": "能帮我看看那些 502 吗？",
  "look.pvAnswer": "找到了：{path} 上的 keep-alive 连接过期了。详情见{link}。",
  "look.pvLink": "运维手册",
};
