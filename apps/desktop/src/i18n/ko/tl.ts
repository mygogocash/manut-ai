import type { tl as en } from "../en/tl";

export const tl: Record<keyof typeof en, string> = {
  "tl.offline": "{bot}가 연결되어 있지 않아요.",
  "tl.loading": "불러오는 중…",
  "tl.unreachable": "{bot}에 연결할 수 없어요 ({error}). 잠시 뒤에 다시 해 주세요.",
  "tl.noModel": "{bot}에 아직 모델이 없어요. 오른쪽 위 모델 메뉴에서 골라 시작하세요.",
  "tl.jump": "맨 아래로",
  "tl.jumpNew": "새 메시지 {n}개",
  "tl.pinnedOwn": "내 메시지: {text}",
  "tl.sayHi": "{bot}에게 인사해 보세요",
};
