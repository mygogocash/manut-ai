// What a coding session's ask card shows of Kit (the canvas's StatesCodeDev board, "Kit asks to run a command"): what
// the step does in words under the command, a key in the change it would save, the buttons No, Allow once and Always
// allow in this project, and the settled line of an ask Kit's dial answered by itself. The card itself stays
// chat/cards/Cards.slot.tsx's, and every button settles through its one path, `settleApproval`.
import "./kit.css";
import { t, type Key } from "../i18n";
import type { ApprovalChoice } from "../lib/protocol";
import { getSessions } from "../sessions/sessions";
import type { ApprovalItem } from "../state/store";
import { kitAnswered, kitCard, useKeysVersion, type AskContext, type KitCard } from "./kitAsks";
import { useKitProjects } from "./project";

/** Where a coding session's ask is asked, from its chat key (`agent:<id>`); null for any other chat. */
function sessionContext(chat: string): AskContext | null {
  if (!chat.startsWith("agent:")) return null;
  const ss = getSessions().getState();
  const id = chat.slice("agent:".length);
  const r = ss.list.find((x) => x.id === id);
  return r?.cwd ? { chat, root: r.cwd, home: ss.home, branch: ss.live[id]?.branch } : null;
}

/** Kit's reading of an open ask of chat `chat`, read again when a project's settings or a session's keys change; null
 *  for an ask Kit's words do not cover. */
export function useKitCard(chat: string, item: ApprovalItem): KitCard | null {
  useKitProjects();
  useKeysVersion();
  if (item.resolved || item.expired || item.outdated) return null;
  const ctx = sessionContext(chat);
  if (!ctx) return null;
  return kitCard({ event: "approval.request", bot: chat, request_id: item.request_id, title: item.title, command: item.command, cwd: item.cwd, plan: item.plan, choices: item.choices }, ctx);
}

/** A button of Kit's card. "Always allow in this project" allows this one ask once, then keeps the rule. */
export interface KitButton {
  choice: ApprovalChoice;
  label: Key;
  key: string;
  keep?: true;
}

/** The canvas's buttons, the safe answer first and all of the same weight, as every ask card here orders them. */
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
