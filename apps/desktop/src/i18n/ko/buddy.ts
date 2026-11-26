import type { buddy as en } from "../en/buddy";

export const buddy: Record<keyof typeof en, string> = {
  // Buddy in Practice: Buddy answers through the coding agent on this computer, with the person's own sign-in (src/runtime/mock/buddy.ts)
  "buddy.hello": "안녕하세요, Buddy예요. 연습 모드에서는 가게와 주문, 팀이 모두 샘플이고, 실제 고객에게는 아무것도 가지 않아요.\n\n이 컴퓨터에 있는 코딩 에이전트(예: Claude Code)를 통해 내 계정으로 답해요. 무언가를 바꾸거나 보내기 전에는 꼭 먼저 물어볼게요. `/approve`, `/clarify`, `/interview`, `/delegate`를 입력해 보면 팀이 움직이기 전에 어떻게 묻는지 볼 수 있어요.",
  "buddy.anyAgent": "내 코딩 에이전트",
  "buddy.noAgent": "코딩 에이전트 없음",
  "buddy.none": "이 컴퓨터의 코딩 에이전트를 통해 내 계정으로 답하는데, 쓸 수 있는 에이전트가 아직 설치되지 않았어요. Claude Code를 쓸 수 있어요. 설치 명령은 코드 페이지의 + 메뉴, 다른 에이전트 아래에 있어요. 설치한 뒤 터미널에서 {cmd}를 실행해 로그인하고, 메시지를 다시 보내 주세요.",
  "buddy.notYet": "{agents}이(가) 이 컴퓨터에 있지만, 아직은 그것을 통해 답할 수 없어요.",
  "buddy.signedOut": "{agent}에 로그인되어 있지 않아 아직 답할 수 없어요. 터미널에서 {cmd}를 실행해 로그인한 뒤 메시지를 다시 보내 주세요.",
  "buddy.old": "이 컴퓨터의 {agent} 버전이 오래되어 Buddy로 답할 수 없어요. {cmd}로 업데이트한 뒤 메시지를 다시 보내 주세요.",
  "buddy.failed": "{agent}이(가) 이번에는 답하지 못했어요. 받은 메시지: {why}\n\n메시지를 다시 보내면 한 번 더 시도해요.",
  "buddy.stopped": "{agent}이(가) 답하기 전에 멈췄어요. 메시지를 다시 보내면 한 번 더 시도해요.",
  "buddy.off": "{agent}이(가) 설정 › 프로바이더에서 꺼져 있어서 답할 수 없어요. 거기서 켠 뒤 메시지를 다시 보내 주세요.",
};
