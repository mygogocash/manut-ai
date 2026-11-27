// Starts item 103's page side once the app is up: the app's own reads for the list (the store, the sessions and item 97's chat
// reader), the notification for a program waiting to be let in, and the shell's events. Kept apart from `store.ts`, which a test
// drives with stand-ins and so imports none of this.
import { appReader } from "../chat/box/contextReader";
import { bringToFront, showNote, windowWatched } from "../lib/notify";
import { getStore, notifyEnabled, asksIn } from "../state/store";
import { getSessions } from "../sessions/sessions";
import { getHost } from "../sessions/host";
import { agentLabel, sessionMode, type AgentInfo } from "../sessions/agents";
import { t } from "../i18n";
import { getMcpShell } from "./shell";
import { getMcp, provideMcpDeps, type McpCard } from "./store";

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** A notification for a program that asks, while the person is not looking at the window. It names the program and the chat,
 *  never what would be read or sent. */
function announce(card: McpCard): void {
  if (windowWatched() || !notifyEnabled()) return;
  const name = card.program.name;
  const title =
    card.kind === "read"
      ? t("tm.read.title", { name, title: card.chat.title })
      : card.kind === "send"
        ? t("tm.send.title", { name, title: card.chat.title })
        : card.kind === "open"
          ? t("tm.open.title", { name, title: card.chat.title })
          : t("tm.note.title", { name });
  void showNote({ title, body: t("tm.note.body"), bot: "", tag: `manut:threads:${card.id}` }, () => void bringToFront(), true);
}

provideMcpDeps(() => {
  const reader = () => appReader({ store: getStore(), sessions: getSessions(), host: getHost() });
  const rec = (id: string) => getSessions().getState().list.find((r) => r.id === id);
  return {
    shell: getMcpShell(),
    storage: storage(),
    where: (ref) => {
      const r = reader();
      const key = r.chatKey(ref);
      return key ? { key, scope: r.scope(key) } : null;
    },
    title: (ref) => reader().title(ref),
    stateOf: (key) => {
      const s = getStore().getState();
      if (asksIn(s, key).length > 0) return "waiting";
      return s.chats[key]?.turn ? "working" : "idle";
    },
    whoOf: (ref) => {
      if (ref.kind === "session") {
        const r = rec(ref.id);
        return r ? agentLabel(r.agent, getSessions().getState().agents) : "";
      }
      return getStore().getState().bots.find((b) => b.name === ref.bot)?.display_name ?? ref.bot;
    },
    link: (ref) => (ref.kind === "session" ? rec(ref.id)?.linkId : undefined),
    reader,
    // a message goes only to a coding chat on this Mac whose agent runs as the app's chat, as 102k's `locate` holds
    sendable: (ref) => {
      if (ref.kind !== "session") return false;
      const r = rec(ref.id);
      return !!r && r.status !== "draft" && sessionMode(getSessions().getState().agents as AgentInfo[] | null, r) === "chat";
    },
    route: (session, text) => getSessions().route(session, text),
    laneBase: (ref) => {
      const r = ref.kind === "session" ? rec(ref.id) : undefined;
      return r && r.cwd ? { cwd: r.cwd, agent: r.agent } : null;
    },
    // an agent this Mac has and the person has not turned off, named by its id or by the name Settings shows
    agentFor: (name) => {
      const want = name.trim().toLowerCase();
      const agents = getSessions().getState().agents ?? [];
      const a = agents.find((x) => !x.off && !!x.path && (x.id.toLowerCase() === want || x.label.toLowerCase() === want || (x.name ?? "").toLowerCase() === want));
      return a ? { id: a.id, label: agentLabel(a.id, agents) } : null;
    },
    openLane: (p) => getSessions().openLane(p),
    notify: announce,
  };
});

let started = false;
/** Listens for other programs' calls. Once; never throws. */
export async function startMcp(): Promise<void> {
  if (started) return;
  started = true;
  const m = getMcp();
  await getMcpShell()
    .listen(
      (c) => m.call(c),
      (id) => m.gone(id),
    )
    .catch(() => undefined);
}
