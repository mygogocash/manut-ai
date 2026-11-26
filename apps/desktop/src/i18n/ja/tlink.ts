import type { tlink as en } from "../en/tlink";

export const tlink: Record<keyof typeof en, string> = {
  // terminal links (manut://terminal/<id>)
  "tlink.copy": "リンクをコピー",
  "tlink.copied": "リンクをコピーしました",
  "tlink.gone": "このコンピューターにないターミナル",
  "tlink.st.working": "作業中",
  "tlink.st.waiting": "待機中",
  "tlink.st.done": "完了",
  "tlink.st.ended": "終了",
};
