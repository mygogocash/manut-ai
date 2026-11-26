import type { conn as en } from "../en/conn";

export const conn: Record<keyof typeof en, string> = {
  "conn.save": "저장",
  "conn.saving": "저장하는 중…",
  "conn.cancel": "취소",
  "conn.err.ownerOnly": "가게 주인만 로그인과 아웃포스트를 보고 바꿀 수 있어요.",
  "conn.err.noShop": "내 계정에 연결된 가게가 아직 없어서, 여기서 관리할 로그인과 아웃포스트가 없어요.",
  "conn.err.password": "비밀번호는 1자에서 {max}자 사이예요.",
  "conn.err.signInGone": "그 로그인은 더 이상 금고에 없어요.",
  "conn.err.name": "이름은 1자에서 {max}자 사이예요.",
  "conn.err.outpostGone": "그 아웃포스트는 더 이상 가게의 것이 아니에요.",
  "conn.err.unavailable": "금고가 응답하지 않았어요. 다시 해 보세요.",
  "conn.err.again": "아무것도 저장되지 않았어요. 다시 하려면 비밀번호를 다시 입력하세요.",
  "conn.err.failed": "잘 되지 않았어요. 다시 해 보세요.",
  "conn.err.site": "사이트 이름은 1자에서 {max}자 사이예요.",
  "conn.err.origins": "https://로 시작하는 이 사이트의 주소를 1개에서 {max}개까지 추가하세요.",
  "conn.err.username": "계정 이름은 1자에서 {max}자 사이예요.",
  "conn.err.members": "쓸 수 있는 팀원을 골라 주세요: Nam, Pim, Ton, Kit 중 한 명 이상.",
  "conn.err.tooMany": "가게에 로그인이 이미 {max}개 있어요. 금고가 보관할 수 있는 최대 개수예요. 운영자에게 하나를 지워 달라고 하세요.",
  "conn.err.vaultKey": "금고가 아직 준비되지 않아서 아무것도 저장되지 않았어요. 운영자에게 설정을 요청하세요.",
  "conn.err.noChange": "바뀐 것이 없어요. 지금의 계정과 주소 그대로예요.",
  "conn.err.passwordAgain": "비밀번호를 다시 입력하세요. 새 계정이나 새 주소에는 비밀번호가 필요해요. 그래야 금고가 저장된 비밀번호를 새로운 곳에 입력하지 않아요.",
};
