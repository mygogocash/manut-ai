import type { buddy as en } from "../en/buddy";

export const buddy: Record<keyof typeof en, string> = {
  // Buddy in Practice: Buddy answers through the coding agent on this computer, with the person's own sign-in (src/runtime/mock/buddy.ts)
  "buddy.hello": "你好，我是 Buddy。在练习模式里，店铺、订单和团队都是示例，这里的任何内容都不会发给真实的顾客。\n\n我通过这台电脑上你已有的编程代理（例如 Claude Code）用你自己的账号回复。修改或发送任何东西之前，我都会先问你。试试 `/approve`、`/clarify`、`/interview` 和 `/delegate`，看看团队在行动前怎样征求你的同意。",
  "buddy.anyAgent": "你的编程代理",
  "buddy.noAgent": "没有编程代理",
  "buddy.none": "我通过这台电脑上的编程代理、用你自己的账号回复，但还没有安装我能用的代理。Claude Code 可以用：它的安装命令在「代码」页面 + 菜单的「更多代理」下。安装后，在终端运行 {cmd} 登录，然后再发一次消息。",
  "buddy.notYet": "这台电脑上有 {agents}，但我暂时还不能通过它回复。",
  "buddy.signedOut": "{agent} 还没有登录，所以我暂时无法回复。在终端运行 {cmd} 登录，然后再发一次消息。",
  "buddy.old": "这台电脑上的 {agent} 版本太旧，无法作为 Buddy 回复。用 {cmd} 更新后，再发一次消息。",
  "buddy.failed": "{agent} 这次没能回复。它说：{why}\n\n再发一次消息即可重试。",
  "buddy.stopped": "{agent} 在回复之前停止了。再发一次消息即可重试。",
  "buddy.off": "{agent} 在「设置 › 提供方」中已关闭，所以我无法回复。请在那里打开它，然后再发一次消息。",
};
