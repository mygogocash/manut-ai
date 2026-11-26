import type { disk as en } from "../en/disk";

export const disk: Record<keyof typeof en, string> = {
  "disk.gb": "{n}GB",
  "disk.noteLow": "디스크 공간 부족: {free} 남음",
  "disk.noteCritical": "디스크 공간이 거의 없어요: {free} 남음",
  "disk.noteBody": "빌드와 에이전트가 실패하기 전에 {volume}의 공간을 비워 주세요.",
  "disk.chip": "{free} 남음",
  "disk.chipTitle": "{volume}의 디스크 공간이 얼마 남지 않았어요. 설정 열기",
  "disk.setting": "디스크 공간이 이보다 적으면 알림",
  "disk.settingHint": "Manut AI가 홈 폴더가 있는 디스크를 1분마다 확인해요. 아무것도 지우지 않아요.",
};
