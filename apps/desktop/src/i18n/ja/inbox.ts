import type { inbox as en } from "../en/inbox";

export const inbox: Record<keyof typeof en, string> = {
  "inbox.group": "サイドメニュー",
  "inbox.working": "作業中のまとまり",
  "inbox.workingHint": "作業中のチャットは「最近」の下の控えめな「作業中」にまとまり、終わると一番上に戻ります。あなたの確認が必要なチャットは、いつも「最近」に残ります。",
  "inbox.quiet": "動きのない日が続いたら完了",
  "inbox.quietHint": "この日数のあいだ、どちらからもメッセージがなく、あなたの確認待ちもないチャットやレーンは「いったん完了」になります。何も失われず、開くか確認が必要になれば戻ります。",
  "inbox.day1": "1 日",
  "inbox.days": "{n} 日",
  "inbox.merged": "プルリクエストがマージされたら完了",
  "inbox.mergedHint": "GitHub または GitLab がプルリクエストのマージを伝えたレーンは「いったん完了」になります。何も失われず、開けば戻ります。",
};
