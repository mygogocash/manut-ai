import type { buddy as en } from "../en/buddy";

export const buddy: Record<keyof typeof en, string> = {
  // Buddy in Practice: Buddy answers through the coding agent on this computer, with the person's own sign-in (src/runtime/mock/buddy.ts)
  "buddy.hello": "Buddy です。練習モードでは、お店も注文もチームもサンプルで、本物のお客さまには何も届きません。\n\nこのコンピューターにあるコーディングエージェント（Claude Code など）を通して、あなた自身のアカウントで答えます。何かを変えたり送ったりする前には必ずあなたに確認します。`/approve`、`/clarify`、`/interview`、`/delegate` を試すと、チームが動く前にどう確認するかが見られます。",
  "buddy.anyAgent": "あなたのコーディングエージェント",
  "buddy.noAgent": "コーディングエージェントなし",
  "buddy.none": "このコンピューターのコーディングエージェントを通して、あなた自身のアカウントで答えますが、使えるものがまだインストールされていません。Claude Code が使えます。インストールの行は「コード」ページの + メニューの「ほかのエージェント」にあります。インストールしたら、ターミナルで {cmd} を実行してサインインし、もう一度メッセージを送ってください。",
  "buddy.notYet": "{agents} はこのコンピューターにありますが、まだそれを通しては答えられません。",
  "buddy.signedOut": "{agent} にサインインしていないため、まだ答えられません。ターミナルで {cmd} を実行してサインインし、もう一度メッセージを送ってください。",
  "buddy.old": "このコンピューターの {agent} は古いため、Buddy として答えられません。{cmd} で更新してから、もう一度メッセージを送ってください。",
  "buddy.failed": "{agent} は今回答えられませんでした。届いたメッセージ: {why}\n\nもう一度メッセージを送ると、やり直します。",
  "buddy.stopped": "{agent} は答える前に止まりました。もう一度メッセージを送ると、やり直します。",
  "buddy.off": "{agent} は 設定 › プロバイダー でオフになっているため、答えられません。そこでオンにして、もう一度メッセージを送ってください。",
};
