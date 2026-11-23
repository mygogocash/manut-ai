// Team: the members in the order the sidebar listed them (selectSidebarBots: pinned first, then as they joined), each
// with face, name, what they do and status, opening their chat. The status is team.ts's, in the design canvas's words.
// The faces are the app's own avatars: the canvas's drawn faces (AUTHORING.md, Team faces) are not in the app yet.
import { t, type Key } from "../i18n";
import { selectAsks, selectSidebarBots, useStore, type Actions, type AppState } from "../state/store";
import { MenuIcon } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import { Empty, MenuPageFrame } from "./MenuPage";
import { asksOf, memberStatus, type MemberStatus } from "./team";

/** One member as its row shows it. */
export interface TeamRow {
  name: string;
  displayName: string;
  /** what the member does ("Sales chat"), as the runtime describes it */
  description: string;
  status: MemberStatus;
  open: () => void;
}

/** Each status's word and the canvas's tag for it: amber waits on you, blue works, red could not finish. */
const STATUS: Record<MemberStatus, { word: Key; tag: string }> = {
  needs: { word: "thread.st.needs", tag: "tag warn" },
  working: { word: "thread.st.running", tag: "tag run" },
  stuck: { word: "team.stuck", tag: "tag err" },
  offline: { word: "bot.offline", tag: "tag" },
  idle: { word: "thread.st.idle", tag: "tag" },
};

/** The rows for the listed members, each opening that member's chat. */
export function teamRows(s: AppState & Actions): TeamRow[] {
  const asks = selectAsks(s);
  return selectSidebarBots(s).map((b) => ({
    name: b.name,
    displayName: b.display_name,
    description: b.description,
    status: memberStatus(b, s.chats[b.name], asksOf(asks, b.name).length),
    open: () => void s.selectBot(b.name),
  }));
}

export function TeamView({ members }: { members: TeamRow[] }) {
  return (
    <MenuPageFrame page="team" title={t("menu.team")}>
      <div className="pane">
        {members.length ? (
          <ul className="rows">
            {members.map((m) => {
              const st = STATUS[m.status];
              return (
                <li key={m.name}>
                  <button type="button" className="rowl" onClick={m.open} data-testid={`team-${m.name}`}>
                    <Avatar bot={m.name} size={40} />
                    <span className="grow">
                      <span className="l1">{m.displayName}</span>
                      {m.description && <span className="l2">{m.description}</span>}
                    </span>
                    <span className={st.tag}>{t(st.word)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty icon={<MenuIcon row="team" />} title={t("team.emptyTitle")} text={t("team.emptyText")} testId="team-empty" />
        )}
      </div>
    </MenuPageFrame>
  );
}

export function TeamPage() {
  const s = useStore();
  return <TeamView members={teamRows(s)} />;
}
