import type { conn as en } from "../en/conn";

export const conn: Record<keyof typeof en, string> = {
  "conn.save": "保存",
  "conn.saving": "保存しています…",
  "conn.cancel": "キャンセル",
  "conn.err.ownerOnly": "サインインとアウトポストを見たり変えたりできるのは、お店のオーナーだけです。",
  "conn.err.noShop": "あなたのアカウントにはまだお店が結び付いていないため、ここで管理するサインインとアウトポストはありません。",
  "conn.err.password": "パスワードは1〜{max}文字です。",
  "conn.err.signInGone": "そのサインインはもう保管庫にありません。",
  "conn.err.name": "名前は1〜{max}文字です。",
  "conn.err.outpostGone": "そのアウトポストはもうお店のものではありません。",
  "conn.err.unavailable": "保管庫から応答がありませんでした。もう一度お試しください。",
  "conn.err.again": "何も保存されていません。もう一度試すには、パスワードを入力し直してください。",
  "conn.err.failed": "うまくいきませんでした。もう一度お試しください。",
  "conn.err.site": "サイトの名前は1〜{max}文字です。",
  "conn.err.origins": "https:// で始まるこのサイトのアドレスを1〜{max}個追加してください。",
  "conn.err.username": "アカウント名は1〜{max}文字です。",
  "conn.err.members": "使えるメンバーを選んでください：Nam、Pim、Ton、Kit のうち1人以上。",
  "conn.err.tooMany": "お店のサインインはすでに{max}件あり、保管庫に保存できる上限です。オペレーターに1件削除してもらってください。",
  "conn.err.vaultKey": "保管庫の準備がまだできていないため、何も保存されていません。オペレーターに設定を頼んでください。",
  "conn.err.noChange": "何も変わっていません。今のアカウントとアドレスのままです。",
  "conn.err.passwordAgain": "パスワードを入力し直してください。新しいアカウントや新しいアドレスには必要です。保管庫が保存済みのパスワードを新しい場所に入力することはありません。",
};
