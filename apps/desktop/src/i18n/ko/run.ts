import type { run as en } from "../en/run";

export const run: Record<keyof typeof en, string> = {
  // what keeps running: the commands this app's sessions started that still run (src/running/, on the Code page)
  "run.title": "계속 실행 중인 명령",
  "run.tag": "실행 중",
  "run.tag.preview": "미리보기",
  "run.stop": "멈추기",
  "run.stopping": "멈추는 중",
  "run.stopAria": "{command} 멈추기",
  "run.stopFailed": "멈추지 못했어요. 다시 해 보세요.",
  "run.none": "여기서 시작한 것 중 실행 중인 것이 없어요.",
  "run.port": "포트 {ports}",
  "run.ports": "포트 {ports}",
  "run.unnamed": "명령",
  "run.others": "다른 프로젝트에서 {n}개 더 실행 중",
};
