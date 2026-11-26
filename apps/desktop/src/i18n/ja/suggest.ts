import type { suggest as en } from "../en/suggest";

export const suggest: Record<keyof typeof en, string> = {
  "suggest.group": "次のメッセージの提案",
  "suggest.title": "次に言うことを提案する",
  "suggest.hintCost": "コーディングチャットがターンを終えると、空の入力欄に次のメッセージの案が灰色で表示されます。Tab で使うか、そのまま入力してください。自動で送信されることはありません。提案のたびに、毎ターン後にご自身の AI プランでリクエストが 1 回余分に使われるため、オンにするまでオフです。オンにした後に始めたチャットから有効です。",
  "suggest.agents": "対応するエージェント",
  "suggest.agentsHint": "Codex などほかのコーディングエージェントには、提案を求める方法がまだないため、それらのチャットには表示されません。",
  "suggest.agentsValue": "Claude Code",
  "suggest.hint": "次のメッセージの提案です。Tab で使え、入力すると置き換わります。",
};
