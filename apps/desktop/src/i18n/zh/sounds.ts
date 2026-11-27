import type { sounds as en } from "../en/sounds";

export const sounds: Record<keyof typeof en, string> = {
  // sounds (Settings › General)
  "sounds.title": "声音",
  "sounds.hint": "发送、机器人回复或提问、出错时的轻声提示。",
  "sounds.play": "试听",
  "sounds.on": "开",
  "sounds.off": "关",
  // finish chime, tone, settle and effort sounds (item 131)
  "sounds.group": "声音与提示音",
  "sounds.finish": "完成提示音",
  "sounds.finishHint": "你没在看的聊天结束一轮时，轻轻响一声。安静时段内不会响",
  "sounds.tone": "完成的声音",
  "sounds.toneHint": "一轮结束时播放什么：内置提示音或一种音调",
  "sounds.preview": "试听",
  "sounds.tone.default": "默认",
  "sounds.settle": "暂时完成的声音",
  "sounds.settleHint": "用“暂时完成”收起聊天时，发出一声轻轻的滴答",
  "sounds.effort": "Effort 滑块的声音",
  "sounds.effortHint": "拖动时每经过一档就滴答一声，越往上音越高；到最高档时有一声短促的冲击音",
  "sounds.tone.heaven": "Heaven",
  "sounds.tone.highwire": "Highwire",
  "sounds.tone.iridium": "Iridium",
  "sounds.tone.krypton": "Krypton",
  "sounds.tone.kzurbSonar": "Kzurb Sonar",
};
