import type { pull as en } from "../en/pull";

export const pull: Record<keyof typeof en, string> = {
  "pull.why.pulled": "已让 {branch} 跟上 {remote}：{n} 个新提交（{from} 到 {to}）。",
  "pull.why.pulledOne": "已让 {branch} 跟上 {remote}：1 个新提交（{from} 到 {to}）。",
  "pull.why.current": "{branch} 已与 {remote} 同步。",
  "pull.why.git_missing": "没有拉取：这台电脑上没有 git。",
  "pull.why.config": "没有拉取：这个项目自己的 git 设置指定了要 git 运行的程序，或另一个获取地址（{setting}）。应用不会自己运行这些；如果你信任它们，请在终端里拉取。",
  "pull.why.busy": "没有拉取 {branch}：git 正在这个文件夹里进行某项操作。",
  "pull.why.detached": "没有拉取：这个文件夹不在任何分支上。",
  "pull.why.no_upstream": "没有拉取 {branch}：它没有跟踪远程的分支。",
  "pull.why.not_default": "没有拉取：这个文件夹在 {branch} 上，不是远程的默认分支。",
  "pull.why.unread": "没有拉取 {branch}：git 无法读出文件夹里的内容。",
  "pull.why.changes": "没有拉取 {branch}：文件夹里有改动过或新增的文件。",
  "pull.why.submodules": "没有拉取 {branch}：这个项目有子模块，应用不会自行查看子模块内部。请在终端里拉取。",
  "pull.why.ahead": "没有拉取 {branch}：它有还没有推送到远程的提交。",
  "pull.why.fetch_failed": "没有拉取 {branch}：无法在 10 秒内不输入密码连接到 {remote}。",
  "pull.why.diverged": "没有拉取 {branch}：它和 {remote} 各自都有新提交，无法直接向前移动。",
  "pull.why.failed": "没有拉取 {branch}：git 拒绝向前移动它。",
};
