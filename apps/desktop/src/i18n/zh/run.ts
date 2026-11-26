import type { run as en } from "../en/run";

export const run: Record<keyof typeof en, string> = {
  // what keeps running: the commands this app's sessions started that still run (src/running/, on the Code page)
  "run.title": "持续运行的命令",
  "run.tag": "运行中",
  "run.tag.preview": "预览",
  "run.stop": "停止",
  "run.stopping": "正在停止",
  "run.stopAria": "停止 {command}",
  "run.stopFailed": "无法停止，请重试。",
  "run.none": "这里启动的内容都没有在运行。",
  "run.port": "端口 {ports}",
  "run.ports": "端口 {ports}",
  "run.unnamed": "命令",
  "run.others": "其他项目中还有 {n} 个在运行",
};
