// The chat box's choices for a chat that answers through the person's own coding agent (item 80): Buddy's, in its main
// chat and each thread. The runtime keeps them (`agent.box`, runtime/mock/buddy.ts) with what the agent itself listed,
// and the shell checks each again (src-tauri/src/buddy_chat.rs); this draws them with the same model and approval menus
// as a coding chat's box (ModelMenu.tsx, ApprovalMenu.tsx). A chat whose runtime has no such box shows none.
import { useEffect, useState } from "react";
import type { AgentBox, Bot } from "../../lib/protocol";
import { getSessions } from "../../sessions/sessions";
import type { Member } from "./context";
import { folderKey, useStore } from "../../state/store";
import { t, type Key } from "../../i18n";
import { ModelMenu } from "./ModelMenu";
import { ApprovalMenu } from "./ApprovalMenu";

/** The box of `bot`'s main chat, or of its thread `thread`: read when the chat opens, then kept current by the store
 *  (`agent.box` events). Null while unread and for a chat with none. */
export function useAgentBox(bot: string | null, thread?: string | null): AgentBox | null {
  const s = useStore();
  const load = s.loadAgentBox;
  useEffect(() => {
    if (bot) void load(bot, thread ?? undefined);
  }, [bot, thread, load]);
  if (!bot) return null;
  return s.agentBox[thread ? folderKey(bot, thread) : bot] ?? null;
}

/** The teammates a chat can mention with `@`: every member of the team but the one whose chat it is. */
export const teammates = (bots: readonly Bot[], self: string): Member[] => bots.filter((b) => b.name !== self).map((b) => ({ name: b.name, label: b.display_name }));

/** Add context › Folder in a chat that answers through the person's own agent: the native picker, from the home folder.
 *  The folder is named by its path and never copied; the agent asks before it reads there (it runs in a folder of its
 *  own). */
export const pickFolder = () => getSessions().pickFolder(getSessions().getState().home ?? "");

/** The words under each of the agent's own approval levels, for a person who is not technical. */
const HINT: Record<string, Key> = { default: "box.hint.ask", plan: "box.hint.plan" };

/** What the button names: a model the chat picked (other than the agent's own default), else what the agent says it
 *  runs, else the agent itself. */
export function boxLabel(box: AgentBox): string {
  const picked = box.model && box.model !== "default" ? box.models.find((m) => m.id === box.model)?.label : "";
  return picked || box.running || box.label;
}

/** The row that is on: the chat's pick, else the agent's own `default` entry when it listed one. */
export const boxOn = (box: AgentBox): string => box.model || (box.models.some((m) => m.id === "default") ? "default" : "");

/** The model with its effort, and the approval level, in the box of `bot`'s chat (or its thread `thread`). */
export function AgentBoxTools({ bot, thread, box }: { bot: string; thread?: string; box: AgentBox }) {
  const s = useStore();
  const [note, setNote] = useState<string | null>(null);
  const choose = async (change: { model?: string; effort?: string; approval?: string }) => {
    const why = await s.setAgentBox(change, bot, thread);
    setNote(why ? t("box.notChanged", { error: why }) : null);
  };
  const label = boxLabel(box);
  const on = boxOn(box);
  return (
    <>
      <ModelMenu
        label={label}
        mark={{ model: label, provider: box.agent }}
        live={!!box.running}
        options={box.models}
        isOn={(o) => o.id === on}
        onPick={(o) => choose({ model: o.id })}
        canPick={box.models.length > 0}
        efforts={box.efforts}
        effort={box.effort}
        onEffort={(v) => choose({ effort: v })}
        // Ultrathink is Claude Code's keyword: the card offers its row when that is the agent answering (item 132)
        ultrathink={box.agent === "claude"}
        empty={box.agent ? t("box.modelsLater", { agent: box.label }) : t("box.noModels")}
        notes={
          note ? (
            <div className="mp-note" role="status" title={note} data-testid="model-note">
              {note}
            </div>
          ) : undefined
        }
        foot={t("box.appliesChat")}
      />
      <ApprovalMenu
        modes={box.approvals}
        current={box.approval}
        live
        onPick={(m) => void choose({ approval: m })}
        hint={(m) => (HINT[m] ? t(HINT[m]) : "")}
        foot={box.agent ? t("box.buddyFoot", { agent: box.label }) : undefined}
        testId="box-approval"
      />
    </>
  );
}
