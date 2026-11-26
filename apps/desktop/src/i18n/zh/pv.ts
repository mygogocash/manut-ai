import type { pv as en } from "../en/pv";

export const pv: Record<keyof typeof en, string> = {
  "pv.loading": "加载中…",
  "pv.opened": "已用 {cmd} 打开终端。在那里输入密钥，回到这里时列表会自动刷新。",
  "pv.manual": "请在终端中运行 {cmd}。",
  "pv.openFailed": "无法打开终端（{error}）。请自行运行 {cmd}。",
  "pv.addKey": "添加密钥",
  "pv.addKeyFor": "添加密钥给",
  "pv.addApiKeyFor": "为以下服务添加 API 密钥",
  "pv.setup": "在 Hermes 中设置 · {cmd}",
  "pv.copyCmd": "复制命令",
  "pv.copy": "复制",
  "pv.copied": "已复制",
  "pv.inUse": "使用中",
  "pv.addApiKey": "添加 {name} API 密钥",
  "pv.filter": "筛选 {n} 个模型",
  "pv.filterOf": "筛选 {name} 的模型",
  "pv.noModels": "没有模型",
  "pv.noMatch": "没有匹配“{q}”的模型",
  "pv.model1": "1 个模型",
  "pv.models": "{n} 个模型",
};
