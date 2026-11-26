// What a coding session's ask card shows of Kit (the canvas's StatesCodeDev board, "Kit asks to run a command"): what
// the step does in words under the command, a key in the change it would save, the buttons No, Allow once and Always
// allow in this project, and the settled line of an ask Kit's dial answered by itself. The card itself stays
// chat/cards/Cards.slot.tsx's, and every button settles through its one path, `settleApproval`.
import "./kit.css";
import { useEffect } from "react";
import { t, type Key } from "../i18n";
import type { ApprovalChoice } from "../lib/protocol";
import { getSessions } from "../sessions/sessions";
import { workDir } from "./laneBranch";
import type { ApprovalItem } from "../state/store";
import { askOfItem, kitAnswered, kitCard, useKeysVersion, type AskContext, type KitCard } from "./kitAsks";
import { useKitProjects } from "./project";
import { scriptRun } from "./command";
import { readPreview, usePreviewRecord } from "./previewStore";

/** Where a coding session's ask is asked, from its chat key (`agent:<id>`); null for any other chat. */
function sessionContext(chat: string): AskContext | null {
  if (!chat.startsWith("agent:")) return null;
  const ss = getSessions().getState();
  const id = chat.slice("agent:".length);
  const r = ss.list.find((x) => x.id === id);
  // a lane's asks are read inside its own folder; the project, whose settings the dial keeps, is the session's folder
  return r?.cwd ? { chat, root: workDir(r), project: r.cwd, home: ss.home, branch: ss.live[id]?.branch, ...(r.workflow ? { careful: true } : {}) } : null;
}

/** Kit's reading of an open ask of chat `chat`, read again when a project's settings or a session's keys change; null
 *  for an ask Kit's words do not cover. A command that runs a package.json script by its name shows what the script runs:
 *  the lane's folder is read for it as its Preview reads it (only a lane's own folder is read, so a session in the
 *  developer's folder shows the name alone). */
export function useKitCard(chat: string, item: ApprovalItem): KitCard | null {
  useKitProjects();
  useKeysVersion();
  const record = usePreviewRecord(chat);
  const open = !(item.resolved || item.expired || item.outdated);
  const ctx = open ? sessionContext(chat) : null;
  const line = item.tool?.line ?? item.command;
  const wants = !!ctx && scriptRun(line) !== null;
  const dir = ctx?.root ?? "";
  const known = record.dir === dir && (record.project !== null || record.reading || record.readWhy !== null);
  useEffect(() => {
    if (wants && !known) void readPreview(chat, dir);
  }, [wants, known, chat, dir]);
  if (!ctx) return null;
  return kitCard(askOfItem(chat, item), ctx, record.dir === dir ? record.project?.packageJson : null);
}

/** A button of Kit's card. "Always allow in this project" allows this one ask once, then keeps the rule. */
export interface KitButton {
  choice: ApprovalChoice;
  label: Key;
  key: string;
  keep?: true;
}

/** The canvas's buttons, the safe answer first, as every ask card here orders them (Allow once is drawn as the card's
 *  one black button, chat/cards/cards.css; the order is this). */
export function kitButtons(card: KitCard, choices: readonly ApprovalChoice[]): KitButton[] {
  const out: KitButton[] = [];
  if (choices.includes("deny")) out.push({ choice: "deny", label: "kit.ask.no", key: "1" });
  if (choices.includes("once")) {
    out.push({ choice: "once", label: "card.allowOnce", key: "2" });
    if (card.always) out.push({ choice: "once", label: "kit.ask.always", key: "3", keep: true });
  }
  return out;
}

/** What Kit's card says under the command: the step in words, and the files with a key when it would save them. */
export function KitSays({ card }: { card: KitCard }) {
  return (
    <>
      <p className="card-kit-say" data-testid="card-kit-say">
        {t(card.say.key, card.say.vars)}
      </p>
      {card.script && (
        <p className="card-kit-say" data-testid="card-kit-script">
          {t("kit.ask.script", { name: card.script.name, text: card.script.text })}
        </p>
      )}
      {card.keys.length > 0 && (
        <p className="card-kit-key" role="note" data-testid="card-kit-key">
          {t("kit.ask.key", { files: card.keys.join(", ") })}
        </p>
      )}
    </>
  );
}

/** The settled line of an ask Kit's dial answered by itself, or null when the person answered it. */
export function kitDoneText(chat: string, requestId: string): string | null {
  const a = kitAnswered(chat, requestId);
  if (!a) return null;
  if (a.by === "reads") return t("kit.done.reads");
  if (a.by === "rule") return t("kit.done.rule");
  if (a.by === "blocked") return t("kit.done.blocked", { project: a.project });
  return t("kit.done.dial", { level: t(`kit.level.${a.level}`) });
}
