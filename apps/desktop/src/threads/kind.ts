// What a thread is, in words, where the runtime says (item 102l-2): the connected runtime lists the shop's conversations with Buddy
// beside the team's work on its tasks, and a person must never take one for the other. The thread's header says which.
import { t } from "../i18n";
import type { ThreadRow } from "./types";

/** "Conversation" or "Team's work"; null for a thread of a runtime that lists one kind only. */
export function kindWord(kind: ThreadRow["kind"]): string | null {
  if (kind === "chat") return t("thread.kind.chat");
  if (kind === "task") return t("thread.kind.task");
  return null;
}
