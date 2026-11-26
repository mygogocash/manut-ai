import type { editor as en } from "../en/editor";

export const editor: Record<keyof typeof en, string> = {
  "editor.open": "{name}에서 열기",
  "editor.openAny": "편집기에서 열기",
  "editor.openProject": "프로젝트를 {name}에서 열기",
  "editor.openSession": "이 세션의 폴더를 {name}에서 열기",
  "editor.title": "편집기",
  "editor.hint": "'편집기에서 열기'가 폴더를 여는 앱입니다. 자동은 이 컴퓨터에서 처음 찾은 것을 다음 순서로 사용합니다: Visual Studio Code, Cursor, Windsurf, Zed, Xcode(Mac 전용).",
  "editor.auto": "자동",
  "editor.none": "이 컴퓨터에서 편집기를 찾지 못해 '편집기에서 열기'를 표시하지 않습니다. Visual Studio Code, Cursor, Windsurf, Zed, Xcode(Mac 전용)를 찾습니다.",
  "editor.gone": "{name}을(를) 이 컴퓨터에서 찾지 못해 처음 찾은 편집기를 사용합니다.",
  "editor.fail.gone": "폴더가 더 이상 없어서 열지 못했습니다.",
  "editor.fail.folder": "폴더가 아니어서 열지 못했습니다.",
  "editor.fail.missing": "이 컴퓨터에서 편집기를 찾지 못해 아무것도 열지 않았습니다.",
  "editor.fail.other": "편집기를 열지 못했습니다. 바뀐 것은 없습니다.",
};
