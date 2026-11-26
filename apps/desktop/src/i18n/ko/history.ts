import type { history as en } from "../en/history";

export const history: Record<keyof typeof en, string> = {
  "history.find": "기록 검색",
  "history.findPh": "제목과 최근 메시지 검색",
  "history.emptyTitle": "아직 기록이 없어요",
  "history.emptyText": "Buddy와 팀의 스레드가 최신순으로 여기에 표시돼요.",
  "history.none": "“{q}”와 맞는 스레드가 없어요",
  // where a job's page and the activity log are opened from
  "history.kind.job": "작업",
  "history.show": "표시",
  "history.lane.all": "전체",
  "history.archive": "보관함",
  "history.archiveN": "보관함 ({n})",
  "history.pastMore": "가져온 프로젝트에서 Claude Code와 Codex 각각의 최신 대화 {n}개를 보여 줍니다.",
};
