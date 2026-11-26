// Drafts on Home (item 95): the drafts kept for later (app/stash.ts) as a short list at the top of Home, the New page, so
// a person finds them where a new chat starts. A row puts its draft back where it was written; Move to puts it into
// another member's chat, Home's box or a project's box; × deletes it. Taking a draft only fills a box: the person sends
// it, or not. When a sixth draft lets the oldest go, one line says so with an Undo.
import { useState } from "react";
import { t } from "../i18n";
import { Popover } from "../ui/Popover";
import { CloseIcon } from "../ui";
import { age } from "../sidebar/Needs";
import { getStore, selectSidebarBots, type Actions, type AppState } from "../state/store";
import { chatTarget } from "../state/store";
import { getSessions } from "../sessions/sessions";
import { folderName, isGone } from "../sessions/agents";
import { pathKey } from "../sessions/folders";
import { laneOf } from "../code/askKit";
import { dropDraft, intoChat, STASH_MAX, takeDraft, undoLetGo, useStash, type Stashed } from "../app/stash";

/** A place a draft can go: a box it is put into. */
export interface DraftPlace {
  key: string;
  label: string;
  pick: () => void;
}

/** One draft as its row shows it. */
export interface DraftRow {
  id: string;
  /** its first words, on one line */
  words: string;
  /** "2 files · From Kami · 3m" */
  meta: string;
  /** puts it back where it was written; null when that chat is gone (the row then opens Move to) */
  back: (() => void) | null;
  /** where it goes back to, for the row's name */
  backTo: string;
  places: DraftPlace[];
  remove: () => void;
}

/** The first line with words in it, on one line, cut where a row would cut it anyway. */
export function draftWords(text: string, max = 90): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function DraftsView({ rows, dropped, onUndo }: { rows: DraftRow[]; dropped: string | null; onUndo: () => void }) {
  const [menu, setMenu] = useState<string | null>(null);
  if (!rows.length && !dropped) return null;
  return (
    // a region, not a section: Home's first section (Needs you) keeps its place under the suggestions (home.css)
    <div className="wide drafts" role="region" aria-labelledby="home-drafts-h" data-testid="home-drafts">
      <div className="band">
        <h2 id="home-drafts-h">{t("drafts.title")}</h2>
        <span>{t("drafts.count", { n: rows.length, max: STASH_MAX })}</span>
      </div>
      {rows.length > 0 && (
        <ul className="rows">
          {rows.map((r, i) => (
            <li key={r.id} className="drow" data-testid="home-draft" data-draft={r.id}>
              <button
                type="button"
                className="rowl"
                aria-describedby={`home-draft-${i}`}
                title={r.back ? t("drafts.backTo", { place: r.backTo }) : t("drafts.move")}
                onClick={r.back ?? (() => setMenu(r.id))}
                data-testid="home-draft-back"
              >
                <span className="grow">
                  <span className="l1">{r.words || t("drafts.onlyFiles")}</span>
                  <span className="l2" id={`home-draft-${i}`}>
                    {r.meta}
                  </span>
                </span>
              </button>
              <span className="dmenu">
                <button type="button" className="btn" aria-haspopup="menu" aria-expanded={menu === r.id} onClick={() => setMenu(menu === r.id ? null : r.id)} data-testid="home-draft-move">
                  {t("drafts.move")}
                </button>
                <Popover open={menu === r.id} onClose={() => setMenu(null)} label={t("drafts.moveOf", { words: r.words })} width={260}>
                  <div role="menu" className="dmenu-list" data-testid="home-draft-places">
                    {r.places.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        role="menuitem"
                        className="dmenu-row"
                        onClick={() => {
                          setMenu(null);
                          p.pick();
                        }}
                        data-testid="home-draft-place"
                        data-place={p.key}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </Popover>
              </span>
              <button type="button" className="ui-ib" aria-label={t("drafts.deleteOf", { words: r.words })} title={t("drafts.delete")} onClick={r.remove} data-testid="home-draft-delete">
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      {dropped !== null && (
        <p className="dnote" role="status" data-testid="home-draft-dropped">
          <span className="grow">{t("drafts.letGo", { words: dropped, max: STASH_MAX })}</span>
          <button type="button" className="lk" onClick={onUndo} data-testid="home-draft-undo">
            {t("drafts.undo")}
          </button>
        </p>
      )}
    </div>
  );
}

type S = AppState & Actions;

/** The name of the chat a draft was written in, or null when it is gone. */
export function placeName(s: S, key: string): string | null {
  if (key === "home") return t("drafts.home");
  if (key.startsWith("agent:")) {
    const rec = getSessions().getState().list.find((r) => r.id === key.slice(6));
    return rec ? (rec.title || rec.agentTitle || rec.promptTitle || folderName(rec.cwd)) : null;
  }
  const { bot, session } = chatTarget(key);
  const b = s.bots.find((x) => x.name === bot);
  if (!b) return null;
  if (!session) return b.display_name;
  const row = (s.threads[bot] ?? []).find((r) => r.thread === session);
  return row ? `${b.display_name} / ${row.title || t("thread.untitled")}` : null;
}

/** Open the chat `key` names (a member's main chat, a thread or a session). */
function openChat(s: S, key: string): void {
  if (key.startsWith("agent:")) return s.openSession(key.slice(6));
  const { bot, session } = chatTarget(key);
  void (session ? s.openThread(bot, session) : s.selectBot(bot));
}

/** A project's box: its running lane when there is one, else a new session in that folder, with the draft's words in it
 *  and nothing started (code/askKit.ts's way, without its send). */
function intoProject(s: S, root: string, e: Stashed): void {
  const ss = getSessions();
  const lane = laneOf(ss, root);
  if (lane) {
    intoChat(getStore(), ss.chatKey(lane)!, e);
    return s.openSession(lane);
  }
  const was = ss.getState().recent.find((r) => pathKey(r.cwd) === pathKey(root))?.agent;
  const id = ss.draft(was && !isGone(was) ? was : undefined);
  ss.setDraft(id, { cwd: root });
  intoChat(getStore(), `agent:${id}`, e);
  s.openSession(id);
}

/** The projects a draft may go to: the folders coding sessions ran in lately, newest first, at most five. */
function projects(): string[] {
  const out: string[] = [];
  for (const r of getSessions().getState().recent) {
    if (r.cwd && !out.some((o) => pathKey(o) === pathKey(r.cwd))) out.push(r.cwd);
    if (out.length === 5) break;
  }
  return out;
}

/** Home's drafts as rows. `here` puts words into Home's own box. */
export function draftRows(s: S, list: readonly Stashed[], nowMs: number, here: (text: string) => void): DraftRow[] {
  const members = selectSidebarBots(s);
  return list.map((e) => {
    const from = placeName(s, e.from);
    const files = e.files.length;
    // Home's box and a new coding session take words only; a draft with files goes to a chat whose box holds them
    const take = (to: (x: Stashed) => void) => () => {
      const x = takeDraft(e.id);
      if (x) to(x);
    };
    const toChat = (key: string) => take((x) => (intoChat(getStore(), key, x), openChat(s, key)));
    const places: DraftPlace[] = [
      ...(files || e.from === "home" ? [] : [{ key: "home", label: t("drafts.toHome"), pick: take((x) => here(x.text)) }]),
      ...members.filter((b) => b.name !== e.from).map((b) => ({ key: b.name, label: t("drafts.toChat", { name: b.display_name }), pick: toChat(b.name) })),
      ...(files ? [] : projects().map((root) => ({ key: `project:${root}`, label: t("drafts.toProject", { name: folderName(root) }), pick: take((x) => intoProject(s, root, x)) }))),
    ];
    const back = from === null ? null : e.from === "home" ? take((x) => here(x.text)) : toChat(e.from);
    return {
      id: e.id,
      words: draftWords(e.text),
      meta: [files === 1 ? t("drafts.file") : files ? t("drafts.files", { n: files }) : "", from === null ? "" : t("drafts.from", { place: from }), age(e.at / 1000, nowMs)].filter(Boolean).join(" · "),
      back,
      backTo: from ?? "",
      places,
      remove: () => dropDraft(e.id),
    };
  });
}

/** The list for Home, kept fresh as drafts come and go. */
export function HomeDrafts({ s, nowMs, here }: { s: S; nowMs: number; here: (text: string) => void }) {
  const { list, dropped } = useStash();
  return <DraftsView rows={draftRows(s, list, nowMs, here)} dropped={dropped ? draftWords(dropped.text) || t("drafts.onlyFiles") : null} onUndo={undoLetGo} />;
}
