import type { drafts as en } from "../en/drafts";

export const drafts: Record<keyof typeof en, string> = {
  "drafts.title": "下書き",
  "drafts.count": "{max} 件中 {n} 件",
  "drafts.backTo": "{place} に戻す",
  "drafts.move": "移す",
  "drafts.moveOf": "「{words}」の移し先",
  "drafts.onlyFiles": "ファイルのみ",
  "drafts.delete": "削除",
  "drafts.deleteOf": "下書き「{words}」を削除",
  "drafts.letGo": "下書きは {max} 件までなので、いちばん古いものを外しました：{words}",
  "drafts.undo": "元に戻す",
  "drafts.home": "ホーム",
  "drafts.toHome": "ホームの入力欄（新しいチャット）",
  "drafts.toChat": "{name} のチャット",
  "drafts.toProject": "{name}（コーディングのチャット）",
  "drafts.file": "ファイル 1 件",
  "drafts.files": "ファイル {n} 件",
  "drafts.from": "{place} から",
};
