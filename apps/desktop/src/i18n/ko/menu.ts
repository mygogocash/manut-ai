import type { menu as en } from "../en/menu";

export const menu: Record<keyof typeof en, string> = {
  // the side menu and its pages (src/sidebar/Sidebar.tsx, src/pages/*Page.tsx): the design canvas's menu rows,
  // Recent, and each page's empty state
  "menu.label": "주 메뉴",
  "menu.home": "Manut AI 홈",
  "menu.new": "새로 만들기",
  "menu.needs": "확인 필요",
  "menu.team": "팀",
  "menu.code": "코드",
  "menu.artifacts": "결과물",
  "menu.customize": "맞춤 설정",
  "menu.history": "기록",
  "menu.recent": "최근",
  "menu.budget": "{cap} 중 {spent}",
  "menu.budgetAria": "이번 달 AI 예산: {cap} 중 {spent}",
  "menu.plans": "코딩 도구 요금제",
  "menu.plansNote": "각 코딩 도구의 요금제를 얼마나 썼는지 이 컴퓨터에서 읽어 옵니다.",
  "menu.working": "작업 중",
  // the lanes listed in Recent's place while the code mode is open (item 167a): each project's list, for a screen reader
  "menu.lanesIn": "{project}의 레인",
};
