import type { sounds as en } from "../en/sounds";

export const sounds: Record<keyof typeof en, string> = {
  // sounds (Settings › General)
  "sounds.title": "소리",
  "sounds.hint": "보낼 때, 봇이 답하거나 물을 때, 오류가 날 때 작은 소리",
  "sounds.play": "재생",
  "sounds.on": "켬",
  "sounds.off": "끔",
  // finish chime, tone, settle and effort sounds (item 131)
  "sounds.group": "소리와 알림음",
  "sounds.finish": "완료 알림음",
  "sounds.finishHint": "보고 있지 않은 채팅이 턴을 마치면 부드러운 알림음을 냅니다. 방해 금지 시간에는 울리지 않습니다",
  "sounds.tone": "완료 소리",
  "sounds.toneHint": "턴이 끝날 때 나는 소리입니다. 기본 알림음이나 톤 중에서 고를 수 있습니다",
  "sounds.preview": "미리 듣기",
  "sounds.tone.default": "기본",
  "sounds.settle": "일단 완료 소리",
  "sounds.settleHint": "'일단 완료'로 채팅을 치울 때 작은 딸깍 소리를 냅니다",
  "sounds.effort": "Effort 슬라이더 소리",
  "sounds.effortHint": "드래그하며 각 단계를 지날 때마다 딸깍 소리가 나고, 올라갈수록 높아집니다. 맨 위에서는 짧은 충격음이 납니다",
  "sounds.tone.heaven": "Heaven",
  "sounds.tone.highwire": "Highwire",
  "sounds.tone.iridium": "Iridium",
  "sounds.tone.krypton": "Krypton",
  "sounds.tone.kzurbSonar": "Kzurb Sonar",
};
