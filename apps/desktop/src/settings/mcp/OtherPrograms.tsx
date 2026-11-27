// Settings › MCP and Skills › Other programs (item 103, `docs/mcp-threads.md`): programs outside Manut AI on this Mac, such as
// Claude Desktop, Cursor or a Claude Code in a terminal, may ask to reach the chats listed here. Off until the person turns it
// on (the shell keeps the switch, `src-tauri/src/threads_mcp`); then the list, at most ten chats added from item 97's picker
// and each removable, and the address to copy: a line for Claude Code and a block for programs that keep an `mcpServers` file.
// A program asks to be let in each time it starts, and every read, message and new lane asks on a card.
//
// `OtherProgramsView` draws from props alone, so a test renders it; `OtherPrograms` reads the shell and the list.
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
import { Icon } from "../../ui/icons";
import { Modes } from "../../ui/Modes";
import { CopyButton } from "../../chat/parts/Copy";
import { revealHidden } from "../../lib/secrets";
import { BringPicker, bringRows, type BringRow } from "../../chat/box/Bring";
import { refKey, type ThreadRef } from "../../chat/box/threadContext";
import { useStore } from "../../state/store";
import { getSessions } from "../../sessions/sessions";
import type { ReachEntry } from "../../jobs/reachList";
import { OUTSIDE_MAX, type ChatState } from "../../threadsMcp/list";
import { getMcpShell, type McpSettings } from "../../threadsMcp/shell";
import { getMcp, useMcp } from "../../threadsMcp/store";
import { Row } from "../DevRow";
import "../../threadsMcp/threadsMcp.css";

/** The server's name in a program's settings (`threads_mcp::SERVER`). */
export const SERVER = "manut-threads";

/** `s` as one word for a POSIX shell: in single quotes, so nothing in it is expanded. */
const quoted = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The line that adds the server to Claude Code. */
export function claudeLine(s: Pick<McpSettings, "command" | "args">): string {
  return `claude mcp add ${SERVER} -- ${[s.command, ...s.args].map(quoted).join(" ")}`;
}

/** The block for programs that keep an `mcpServers` file (Claude Desktop, Cursor and others). */
export function serversBlock(s: Pick<McpSettings, "command" | "args">): string {
  return JSON.stringify({ mcpServers: { [SERVER]: { command: s.command, args: s.args } } }, null, 2);
}

/** Whether the address changes if the app is moved: it does not run from the Applications folder. */
export const movable = (command: string): boolean => !/^\/Applications\/[^/]+\.app\//.test(command);

export interface OtherProgramsViewProps {
  /** The shell's answer; null while it is read. */
  state: McpSettings | null;
  list: readonly ReachEntry[];
  stateOf: (e: ReachEntry) => ChatState;
  /** the line the last add left: why a chat was not added */
  line?: string | null;
  picking?: boolean;
  rows?: (query: string) => BringRow[];
  onOn: (on: boolean) => void;
  onAdd: () => void;
  onPick?: (ref: ThreadRef) => void;
  onClose?: () => void;
  onRemove: (n: number) => void;
}

export function OtherProgramsView(p: OtherProgramsViewProps) {
  const s = p.state;
  return (
    <div className="tm-settings" data-testid="tm-settings">
      <div className="st-gh">{t("tm.title")}</div>
      {!s ? null : !s.available ? (
        <div className="st-note">{t("tm.notHere")}</div>
      ) : (
        <>
          <Row title={t("tm.switch")} hint={t("tm.switchHint")}>
            <Modes
              label={t("tm.switch")}
              value={s.on ? "on" : "off"}
              options={[
                { value: "off", label: t("tm.off") },
                { value: "on", label: t("tm.on") },
              ]}
              onChange={(v) => p.onOn(v === "on")}
              testId="tm-switch"
            />
          </Row>
          {s.on && (
            <>
              <Row title={t("tm.list")} hint={t("tm.listHint", { max: OUTSIDE_MAX })}>
                <div className="tm-list" data-testid="tm-list">
                  {p.list.map((e) => {
                    const st = p.stateOf(e);
                    const lost = st === "gone" || st === "moved";
                    return (
                      <span key={e.n} className="tm-chip" data-testid="tm-chip" data-n={e.n} title={revealHidden(e.title)}>
                        <span className="tm-n">{e.n}</span>
                        <span className="tm-t">{revealHidden(e.title)}</span>
                        {lost && <span className="tm-n">{t(st === "gone" ? "tm.chipGone" : "tm.chipMoved")}</span>}
                        <button type="button" className="ui-ib" aria-label={t("tm.remove", { title: revealHidden(e.title) })} onClick={() => p.onRemove(e.n)} data-testid="tm-remove">
                          <Icon name="x" />
                        </button>
                      </span>
                    );
                  })}
                  {p.list.length < OUTSIDE_MAX && (
                    <button type="button" className="st-btn" onClick={p.onAdd} data-testid="tm-add">
                      <Icon name="plus" />
                      {t("tm.add")}
                    </button>
                  )}
                  {p.picking && p.rows && p.onPick && p.onClose && <BringPicker rows={p.rows} onPick={p.onPick} onClose={p.onClose} />}
                </div>
                {p.line && (
                  <div className="st-note" role="status" data-testid="tm-line">
                    {p.line}
                  </div>
                )}
              </Row>
              <Row title={t("tm.copyClaude")}>
                <div className="tm-copy">
                  <code data-testid="tm-claude">{claudeLine(s)}</code>
                  <CopyButton text={() => claudeLine(s)} testId="tm-copy-claude" />
                </div>
              </Row>
              <Row title={t("tm.copyJson")}>
                <div className="tm-copy">
                  <code data-testid="tm-json">{serversBlock(s)}</code>
                  <CopyButton text={() => serversBlock(s)} testId="tm-copy-json" />
                </div>
              </Row>
              {movable(s.command) && <div className="st-note">{t("tm.movable")}</div>}
              <div className="st-note">{t("tm.asks")}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function OtherPrograms() {
  const { list } = useMcp();
  const store = useStore();
  const [state, setState] = useState<McpSettings | null>(null);
  const [picking, setPicking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getMcpShell()
      .settings()
      .then((s) => live && setState(s))
      .catch(() => live && setState({ on: false, available: false, command: "", args: [] }));
    return () => {
      live = false;
    };
  }, []);
  // the coding chats Bring context from… offers, less the ones already listed; no chat of its own to leave out. Never a team
  // thread: other programs reach coding chats only (the owner, 27 Nov 2026)
  const rows = useCallback(
    (query: string) => {
      const ss = getSessions();
      const listed = new Set(list.map((e) => refKey(e.ref)));
      return bringRows(store, { list: ss.getState().list, agents: ss.getState().agents, chatKey: ss.chatKey }, query, "").filter((r) => r.ref.kind === "session" && !listed.has(refKey(r.ref)));
    },
    [store, list],
  );
  return (
    <OtherProgramsView
      state={state}
      list={list}
      stateOf={(e) => getMcp().stateOf(e)}
      line={line}
      picking={picking}
      rows={rows}
      onOn={(on) => {
        void getMcpShell()
          .set(on)
          .then(setState)
          .catch(() => undefined);
      }}
      onAdd={() => {
        setLine(null);
        setPicking(true);
      }}
      onPick={(ref) => {
        setPicking(false);
        setLine(getMcp().add(ref));
      }}
      onClose={() => setPicking(false)}
      onRemove={(n) => {
        setLine(null);
        getMcp().remove(n);
      }}
    />
  );
}
