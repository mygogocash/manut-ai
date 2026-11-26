import type { diff as en } from "../en/diff";

export const diff: Record<keyof typeof en, string> = {
  "diff.new": "새 파일",
  "diff.deleted": "삭제됨",
  "diff.more": "{n}줄 더",
  "diff.renamed": "{from}에서 이름 변경",
  "diff.binary": "바이너리 파일이라 보여 줄 줄이 없어요.",
  "diff.tooLarge": "너무 커서 보여 줄 수 없어요.",
  "diff.leftOut": "표시하지 않았어요. 이 목록이 이미 길어요.",
};
