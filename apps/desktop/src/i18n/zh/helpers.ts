import type { helpers as en } from "../en/helpers";

export const helpers: Record<keyof typeof en, string> = {
  // the Helpers switch in a lane's box (item 102e, src/jobs/HelpersSwitch.tsx)
  "helpers.switch": "助手",
  "helpers.switchTip": "让 Kit 可以请求在这条泳道旁工作的助手泳道，每条都在这条泳道工作的副本中进行。在你按卡片上的“启动助手”之前，一条都不会启动。",
  "helpers.switchOnTip": "助手已开启：每条消息都会告诉 Kit 如何请求助手泳道。在你按卡片上的“启动助手”之前，一条都不会启动。",
  // the activity line while an answer asks for helper lanes, its blocks hidden
  "helpers.writing": "正在写助手泳道的请求",
  "helpers.writing.one": "正在请求 1 条助手泳道",
  "helpers.writing.many": "正在请求 {n} 条助手泳道",
  // the Start helpers card (src/jobs/HelpersCard.tsx)
  "helpers.ask.one": "Kit 请求 1 条助手泳道",
  "helpers.ask.many": "Kit 请求 {n} 条助手泳道",
  "helpers.row": "助手 {n}",
  "helpers.leadModel": "主泳道的模型",
  "helpers.defaultModel": "默认模型",
  "helpers.modelUnlisted": "该代理的默认模型（Kit 请求了 {name}，但它的列表里没有）",
  "helpers.effortUnlisted": "平常的思考深度（Kit 请求了 {name}，但它的列表里没有）",
  "helpers.unknownAgent": "{name}：不是 Manut AI 在泳道中运行的代理，不会启动",
  "helpers.notInstalled": "未安装，不会启动",
  "helpers.briefLabel": "给助手 {n} 的说明",
  "helpers.lines": "每条都在这条泳道当前工作的副本中进行。在助手泳道报告、它的工作逐一并入之前，这里什么都不会变。每条最多 {minutes} 分钟、{steps} 步；等待你回复的时间不计。完成后，Kit 会收到报告并继续。",
  "helpers.heldBack": "Kit 请求了 {asked} 条。一轮最多 {max} 条，所以最后 {left} 条不包括在内。",
  "helpers.start": "启动助手",
  "helpers.notNow": "暂不",
  // what became of the card
  "helpers.started": "你批准了这一轮。这个版本还不会启动助手泳道，所以一条都没有启动。",
  "helpers.declined": "暂不：没有启动助手泳道。",
  "helpers.gone": "已不再开放，所以没有启动助手泳道。",
  "helpers.refusal.already_decided": "这已经决定过了。",
  "helpers.refusal.superseded": "已不再开放：Kit 的回合已经往前了。",
  "helpers.refusal.roundsSpent": "这条消息已用完 {max} 轮助手泳道。",
  "helpers.refusal.other": "未被接受（{code}）。",
  // the chat's line when a request shows no card
  "helpers.refused": "Kit 请求了助手泳道，但 Manut AI 读不懂这个请求：{why}。什么都没有启动。",
  "helpers.why.json": "有一个块不是有效的 JSON",
  "helpers.why.shape": "有一个块既不是一个助手，也不是助手列表",
  "helpers.why.empty": "有一个块没有写任何助手泳道",
  "helpers.why.key": "有一个块含有 Manut AI 不接受的键（{key}）",
  "helpers.why.value": "{key} 必须是一行文本",
  "helpers.why.brief": "有一条助手泳道没有说明",
  "helpers.why.long": "有一份说明超过了 {max} 个字符",
  "helpers.why.unclosed": "有一个块没有闭合",
  "helpers.spent": "Kit 又请求了助手泳道。这条消息已用完 {max} 轮，所以不会启动，Kit 会自己完成。",
  "helpers.unfinished": "Kit 在没有完成的回合中请求了助手泳道，所以不会启动。",
  "helpers.switchedOff": "Kit 在助手关闭后请求了助手泳道，所以不会启动。",
};
