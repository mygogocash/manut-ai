import type { risk as en } from "../en/risk";

export const risk: Record<keyof typeof en, string> = {
  "risk.delete": "파일과 폴더를 지워요",
  "risk.admin": "관리자 권한으로 실행해요",
  "risk.force": "원격 브랜치의 기록을 덮어써요",
  "risk.discard": "로컬 변경을 버려요",
  "risk.erase": "디스크를 지워요",
  "risk.rawDisk": "디스크에 직접 써요",
  "risk.perms": "권한을 넓게 바꿔요",
  "risk.db": "데이터베이스 데이터를 지워요",
  "risk.pipe": "인터넷에서 받은 스크립트를 실행해요",
  "risk.infra": "운영 중인 인프라를 지워요",
  "risk.forkBomb": "포크 폭탄",
};
