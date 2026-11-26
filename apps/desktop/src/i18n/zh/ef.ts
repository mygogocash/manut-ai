import type { ef as en } from "../en/ef";

export const ef: Record<keyof typeof en, string> = {
  // the effort card (item 132): the chip while it is open, the card's title with no levels, its buttons and the slider
  "ef.select": "选择思考深度",
  "ef.standard": "标准",
  "ef.none": "此模型没有可选的思考深度。",
  "ef.reset": "恢复默认",
  "ef.chooseModel": "选择模型",
  "ef.selectModel": "选择模型",
  "ef.back": "返回",
  "ef.slider": "思考深度",
  // the one-click Ultrathink row, Claude Code chats only: a visible line in the draft
  "ef.utTitle": "为此消息开启 Ultrathink",
  "ef.utAdds": "在此消息开头加上“Ultrathink:”，让 Claude Code 更仔细地思考。",
  "ef.utTyped": "要关闭，请从消息中删除“ultrathink”。",
  "ef.utSlash": "Claude Code 会忽略斜杠命令中的 ultrathink。",
};
