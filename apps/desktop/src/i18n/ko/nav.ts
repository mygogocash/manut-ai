import type { nav as en } from "../en/nav";

export const nav: Record<keyof typeof en, string> = {
  // sidebar nav (the foot of the sidebar) and its search
  "nav.automations": "루틴",
  "nav.plugins": "기술과 도구",
  "nav.settings": "설정",
  "nav.search": "검색",
  "nav.searchBots": "봇과 터미널 검색",
  "nav.addBot": "봇 추가",
  "nav.bots": "팀",
  "nav.sessions": "세션",
  "nav.you": "나",
  "nav.accounts": "계정",
  // termui: TERMINALS (terminal sessions) and the sidebar dock
  "nav.terminals": "터미널",
};
