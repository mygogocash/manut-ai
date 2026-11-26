import type { editor as en } from "../en/editor";

export const editor: Record<keyof typeof en, string> = {
  "editor.open": "{name} で開く",
  "editor.openAny": "エディタで開く",
  "editor.openProject": "プロジェクトを {name} で開く",
  "editor.openSession": "このセッションのフォルダを {name} で開く",
  "editor.title": "エディタ",
  "editor.hint": "「エディタで開く」がフォルダを開くアプリです。自動では、このコンピュータで最初に見つかったものを次の順で使います: Visual Studio Code、Cursor、Windsurf、Zed、Xcode（Macのみ）。",
  "editor.auto": "自動",
  "editor.none": "このコンピュータにエディタが見つからないため、「エディタで開く」は表示されません。Visual Studio Code、Cursor、Windsurf、Zed、Xcode（Macのみ）を探します。",
  "editor.gone": "{name} がこのコンピュータに見つからないため、最初に見つかったエディタを使います。",
  "editor.fail.gone": "フォルダがなくなっているため、開けませんでした。",
  "editor.fail.folder": "フォルダではないため、開けませんでした。",
  "editor.fail.missing": "このコンピュータにエディタが見つからないため、何も開きませんでした。",
  "editor.fail.other": "エディタを開けませんでした。何も変更していません。",
};
