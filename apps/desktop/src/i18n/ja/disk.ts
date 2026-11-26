import type { disk as en } from "../en/disk";

export const disk: Record<keyof typeof en, string> = {
  "disk.gb": "{n} GB",
  "disk.noteLow": "ディスクの空き容量が少なくなっています: 残り {free}",
  "disk.noteCritical": "ディスクの空き容量がほとんどありません: 残り {free}",
  "disk.noteBody": "ビルドやエージェントが失敗する前に {volume} の空き容量を増やしてください。",
  "disk.chip": "空き {free}",
  "disk.chipTitle": "{volume} の空き容量が少なくなっています。設定を開く",
  "disk.setting": "空き容量がこれを下回ったら通知",
  "disk.settingHint": "Manut AI はホームフォルダのあるディスクを 1 分ごとに確認します。何も削除しません。",
};
