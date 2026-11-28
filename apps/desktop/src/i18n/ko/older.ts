import type { older as en } from "../en/older";

export const older: Record<keyof typeof en, string> = {
  "older.show": "이전 작업 보기",
  "older.more": "가장 최근 작업만 보이고 있어요. 이전 작업이 더 있어요.",
  "older.reading": "이전 작업을 불러오는 중…",
  "older.end": "여기까지가 전부예요. 더 이전 작업은 없어요.",
  "older.again": "다시 시도",
  "older.failed": "이전 작업을 불러오지 못했어요. 지금 보이는 내용은 그대로예요.",
  "older.offline": "이전 작업을 보려면 연결이 필요해요. 지금 보이는 내용은 그대로예요.",
  // Show older at the top of a conversation (item 102l-6)
  "older.messages.show": "Show older",
  "older.messages.reading": "Reading older messages…",
  "older.messages.failed": "Older messages could not be read. What is shown here has not changed.",
};
