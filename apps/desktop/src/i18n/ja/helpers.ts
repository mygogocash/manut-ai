import type { helpers as en } from "../en/helpers";

export const helpers: Record<keyof typeof en, string> = {
  // the Helpers switch in a lane's box (item 102e, src/jobs/HelpersSwitch.tsx)
  "helpers.switch": "ヘルパー",
  "helpers.switchTip": "このレーンと並んで動くヘルパーレーンを Kit が頼めるようにします。それぞれ、このレーンの作業のコピーで動きます。カードで「ヘルパーを開始」を押すまで、どれも始まりません。",
  "helpers.switchOnTip": "ヘルパーはオンです。メッセージごとに、ヘルパーレーンの頼み方が Kit に伝えられます。カードで「ヘルパーを開始」を押すまで、どれも始まりません。",
  // the activity line while an answer asks for helper lanes, its blocks hidden
  "helpers.writing": "ヘルパーレーンの依頼を書いています",
  "helpers.writing.one": "ヘルパーレーンを 1 つ依頼しています",
  "helpers.writing.many": "ヘルパーレーンを {n} つ依頼しています",
  // the Start helpers card (src/jobs/HelpersCard.tsx)
  "helpers.ask.one": "Kit がヘルパーレーンを 1 つ依頼しています",
  "helpers.ask.many": "Kit がヘルパーレーンを {n} つ依頼しています",
  "helpers.row": "ヘルパー {n}",
  "helpers.leadModel": "リードと同じモデル",
  "helpers.defaultModel": "既定のモデル",
  "helpers.modelUnlisted": "エージェントの既定 (Kit は {name} を依頼しましたが、一覧にありません)",
  "helpers.effortUnlisted": "いつもの考える深さ (Kit は {name} を依頼しましたが、一覧にありません)",
  "helpers.unknownAgent": "{name}: Manut AI がレーンで動かすエージェントではないため、開始しません",
  "helpers.notInstalled": "インストールされていないため、開始しません",
  "helpers.briefLabel": "ヘルパー {n} への指示",
  "helpers.lines": "それぞれ、今のこのレーンの作業のコピーで動きます。ヘルパーレーンが報告したあと、その作業が 1 つずつ取り込まれるまで、ここは何も変わりません。それぞれ最大 {minutes} 分、{steps} ステップまでです。あなたの返事を待つ時間は数えません。終わると、Kit が報告を受け取って続けます。",
  "helpers.heldBack": "Kit は {asked} 個を依頼しました。1 ラウンドは最大 {max} 個なので、最後の {left} 個は外します。",
  "helpers.start": "ヘルパーを開始",
  "helpers.notNow": "今はしない",
  // what became of the card
  "helpers.started": "このラウンドを承認しました。このバージョンはまだヘルパーレーンを開始しないため、何も始まっていません。",
  "helpers.declined": "今はしない: ヘルパーレーンは始まっていません。",
  "helpers.gone": "もう開いていないため、ヘルパーレーンは始まっていません。",
  "helpers.refusal.already_decided": "これはすでに決まっています。",
  "helpers.refusal.superseded": "もう開いていません。Kit のターンが先に進みました。",
  "helpers.refusal.roundsSpent": "このメッセージは、ヘルパーレーンの {max} ラウンドを使い切りました。",
  "helpers.refusal.other": "受け付けられませんでした ({code})。",
  // the chat's line when a request shows no card
  "helpers.refused": "Kit がヘルパーレーンを依頼しましたが、Manut AI は依頼を読めませんでした: {why}。何も始まっていません。",
  "helpers.why.json": "ブロックが正しい JSON ではありません",
  "helpers.why.shape": "ブロックがヘルパー 1 つでも、その一覧でもありません",
  "helpers.why.empty": "ブロックにヘルパーレーンがありません",
  "helpers.why.key": "ブロックに Manut AI が受け付けないキーがあります ({key})",
  "helpers.why.value": "{key} は 1 行のテキストでなければなりません",
  "helpers.why.brief": "指示のないヘルパーレーンがあります",
  "helpers.why.long": "指示が {max} 文字を超えています",
  "helpers.why.unclosed": "ブロックが閉じられていません",
  "helpers.spent": "Kit がまたヘルパーレーンを依頼しました。このメッセージは {max} ラウンドを使い切ったので、何も始まらず、Kit が自分で仕上げます。",
  "helpers.unfinished": "Kit は終わらなかったターンでヘルパーレーンを依頼したため、何も始まりません。",
  "helpers.switchedOff": "ヘルパーがオフになったあとに Kit がヘルパーレーンを依頼したため、何も始まりません。",
};
