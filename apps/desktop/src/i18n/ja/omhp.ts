import type { omhp as en } from "../en/omhp";

export const omhp: Record<keyof typeof en, string> = {
  "omhp.ready": "oh-my-hermes の準備ができました。モデルを設定しますか？",
  "omhp.fill": "入力欄に入れる",
  "omhp.ask": "このコンピューターにすでにあるプロバイダーで、私のモデルを設定して。適用する前に、何が変わるかを先に見せて。",
  "omhp.noSkills": "{bot} にはまだ oh-my-hermes のスキルが見えません。",
  "omhp.tools": "{bot} にはまだ oh-my-hermes のツール（サブエージェントの計画など）がありません。モデル設定はツールなしでできます。",
};
