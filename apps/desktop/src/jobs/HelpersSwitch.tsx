// The Helpers switch in a lane's box (item 102e; `docs/several-agents.md`, "4. Helper lanes a lane asks for"): one switch for that
// chat, beside the approval level, off until the person turns it on. On, the lane's agent is told with each message how to ask for
// helper lanes, and a request becomes the Start helpers card; nothing starts without that card's press. It is drawn only where it
// is offered (`helpersOffered` in leadLanes.ts): a lane's chat with a folder of its own, never a workflow's lane, a chat working in
// the developer's own folder, Buddy's chat (whose box is AgentBox.tsx and has no such switch) or a terminal.
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { getSessions, useSessions } from "../sessions/sessions";
import type { SessionRec } from "../sessions/agents";
import { helpersOffered } from "./leadLanes";
import "./helpers.css";

/** The switch from props alone: a quiet word in the box's row, as the approval level is, ticked on in ink when on. */
export function HelpersToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={t("helpers.switch")}
      title={on ? t("helpers.switchOnTip") : t("helpers.switchTip")}
      className={`ss-pick bx-helpers${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
      data-testid="helpers-switch"
    >
      <Icon name="users" />
      <span className="ss-pick-n">{t("helpers.switch")}</span>
    </button>
  );
}

/** Session `rec`'s switch, or nothing where Helpers is not offered. */
export function HelpersSwitch({ rec }: { rec: SessionRec }) {
  const ss = useSessions();
  if (!helpersOffered(rec, ss.agents)) return null;
  return <HelpersToggle on={rec.helpers === true} onChange={(on) => getSessions().setHelpers(rec.id, on)} />;
}
