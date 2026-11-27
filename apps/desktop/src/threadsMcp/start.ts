// Starts item 103's page side once the app is up: the app's own reads for the list (the store, the sessions and item 97's chat
// reader), the notification for a program waiting to be let in, and the shell's events. Kept apart from `store.ts`, which a test
// drives with stand-ins and so imports none of this.
import { appReader } from "../chat/box/contextReader";
import { bringToFront, showNote, windowWatched } from "../lib/notify";
import { getStore, notifyEnabled, selectAsks } from "../state/store";
import { getSessions } from "../sessions/sessions";
import { getHost } from "../sessions/host";
import { agentLabel } from "../sessions/agents";
import { t } from "../i18n";
import { getMcpShell } from "./shell";
import { getMcp, provideMcpDeps, type LetInCard } from "./store";

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** A notification for a program that waits, while the person is not looking at the window. */
function announce(card: LetInCard): void {
  if (windowWatched() || !notifyEnabled()) return;
  void showNote({ title: t("tm.note.title", { name: card.program.name }), body: t("tm.note.body"), bot: "", tag: `manut:threads:${card.id}` }, () => void bringToFront(), true);
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
      if (selectAsks(s).some((a) => a.bot === key)) return "waiting";
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
