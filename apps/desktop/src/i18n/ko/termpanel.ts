import type { termpanel as en } from "../en/termpanel";

export const termpanel: Record<keyof typeof en, string> = {
  // termpanel (the bottom terminal panel, Ctrl+`)
  "termpanel.label": "터미널",
  "termpanel.tabs": "터미널 탭",
  "termpanel.newTab": "새 터미널",
  "termpanel.closeTab": "{name} 닫기",
  "termpanel.hide": "터미널 숨기기 (Ctrl+`)",
  "termpanel.resize": "터미널 높이",
  "termpanel.home": "홈 폴더",
  "termpanel.ended": "shell이 종료됐어요",
  "termpanel.endedCode": "shell이 종료됐어요 (exit {code})",
  "termpanel.couldNotStart": "shell을 시작하지 못했어요: {error}",
  "termpanel.divider": "창 크기 조절 (더블클릭: 같은 크기로)",
  "termpanel.rang": "벨이 울렸어요",
  "termpanel.splitRight": "오른쪽으로 나누기 ({keys})",
};
