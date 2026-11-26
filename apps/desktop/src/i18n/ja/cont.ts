import type { cont as en } from "../en/cont";

export const cont: Record<keyof typeof en, string> = {
  "cont.menu": "別のエージェントで続ける…",
  "cont.tip": "{agent}。この作業を別のエージェントやモデルで続ける",
  "cont.note": "このチャットと同じ場所で新しいチャットを開き、このチャットの文脈を送らずにボックスの上に置きます。このチャットはそのまま残ります。",
  "cont.none": "チャットできる別のエージェントは入っていません",
  "cont.failed": "続けられませんでした · {error}",
  "cont.in": "{agent} で続けています",
  "cont.from": "{agent} から続けています",
  "cont.open": "開く",
  "cont.stop": "ここで {agent} を止める",
  "cont.stopTip": "今は作業していません。プログラムは終わりますが、このチャットは残り、開けます。",
  "cont.wait": "{agent} がこのレーンで作業中です。終わってから送ってください。1 つのレーンで作業するエージェントは一度に 1 つです。",
};
