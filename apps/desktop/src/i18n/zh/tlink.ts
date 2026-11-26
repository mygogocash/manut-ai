import type { tlink as en } from "../en/tlink";

export const tlink: Record<keyof typeof en, string> = {
  // terminal links (manut://terminal/<id>)
  "tlink.copy": "复制链接",
  "tlink.copied": "已复制链接",
  "tlink.gone": "不在这台电脑上的终端",
  "tlink.st.working": "工作中",
  "tlink.st.waiting": "等待中",
  "tlink.st.done": "完成",
  "tlink.st.ended": "已结束",
};
