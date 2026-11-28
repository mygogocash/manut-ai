import type { menu as en } from "../en/menu";

export const menu: Record<keyof typeof en, string> = {
  // the side menu and its pages (src/sidebar/Sidebar.tsx, src/pages/*Page.tsx): the design canvas's menu rows,
  // Recent, and each page's empty state
  "menu.label": "メインメニュー",
  "menu.home": "Manut AI ホーム",
  "menu.new": "新規作成",
  "menu.needs": "対応が必要",
  "menu.team": "チーム",
  "menu.code": "コード",
  "menu.artifacts": "成果物",
  "menu.customize": "カスタマイズ",
  "menu.history": "履歴",
  "menu.recent": "最近",
  "menu.budget": "{cap} のうち {spent}",
  "menu.budgetAria": "今月の AI 予算: {cap} のうち {spent}",
  "menu.plans": "コーディングツールのプラン",
  "menu.plansNote": "各コーディングツールのプランをどれだけ使ったか。このコンピューターから読み取ります。",
  "menu.working": "作業中",
  // the lanes listed in Recent's place while the code mode is open (item 167a): each project's list, for a screen reader
  "menu.lanesIn": "{project} のレーン",
};
