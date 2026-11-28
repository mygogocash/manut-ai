// The lanes in the side menu while the code mode is open (item 167a; docs/paradev-ux.md, "Navigation: where a lane is"): each
// project's lanes under a quiet heading with its name, the project the Code page shows first, each lane a menu row in Recent's
// look (`.rec`, KitNavigation's Recent items) with its title and one state mark, the open lane marked as the canvas marks an open
// Recent item, and its More menu (item 76's row menu, Lanes.tsx `LaneMore`) on hover and keyboard focus. The rules (which lanes,
// in what order) are laneGroups.ts's; `MenuLanesView` draws whatever it is given, so a test can draw any state, and
// `useMenuLanes` reads the stores.
//
// The state mark is the kit's status dot (KitStatus's `dotst`) in the tone `laneTag` gives the lane's state, the colour of the
// tag the Lanes band draws, before the title like Paradev's lead glyph. The kit sets a dot beside a word: the state's words follow
// the title for a screen reader and in the row's tooltip, since a 196px menu has no room for the band's tag. Only the working
// dot pulses; Needs you and a failure appear and stay still (docs/motion.md).
//
// A row only opens its lane (Lanes.tsx `openLane`, as its row in the band does): it answers no ask, sends nothing and touches no
// approval, and a lane that asks opens with its card in view.
import { Fragment } from "react";
import { dragRef } from "../chat/box/threadContext";
import { getCodeProject, useCodeProject } from "../code/codeProject";
import { laneTag } from "../code/lane";
import { laneKey, LaneMore, laneStoresNow, useLaneStores } from "../code/Lanes";
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { menuLanesFrom, type LaneGroup } from "./laneGroups";
import { settledWhy } from "./RowMenu";
import { getRowMarks, useRowMarks, type RowMarks } from "./rows";

/** The states that wait on the person or say something failed: their rows never rise. */
const ASKS_OR_FAILED: ReadonlySet<string> = new Set(["needs_you", "failed", "tests_failed"]);

export interface MenuLanesProps {
  groups: readonly LaneGroup[];
  /** The lane open in the main column, or null. */
  open: string | null;
  onOpen: (id: string) => void;
  /** What the person did to each row (rows.ts), for each lane's More menu and a settled lane's quiet second line. */
  marks: RowMarks;
}

/** One lane's row: its state's dot, its pin when pinned, its title, the state's words for a screen reader, and its More menu. */
function LaneMenuRow({ lane, open, onOpen, marks }: { lane: LaneGroup["lanes"][number] } & Pick<MenuLanesProps, "onOpen" | "marks"> & { open: boolean }) {
  const { row, place, helper } = lane;
  const mark = marks[laneKey(row)];
  const tag = laneTag(row.status);
  const words = t(tag.key);
  const why = place === "settled" ? settledWhy(mark) : null;
  return (
    <li
      className={`rec-li lane-li${place === "normal" ? "" : ` ${place}`}${helper ? " helper" : ""}`}
      data-place={place}
      data-status={row.status}
      data-flip={row.id}
      // a lane that asks, or that failed, fades where it stands as it arrives: an ask or an error never rises (docs/motion.md)
      data-ask={ASKS_OR_FAILED.has(row.status) || undefined}
      data-testid={`menu-lane-${row.id}`}
    >
      {/* dragged onto an open chat's box, the lane brings its context, as its row in the band does (item 97) */}
      <button type="button" className="rec" aria-current={open ? "true" : undefined} title={`${row.title} · ${words}`} onClick={() => onOpen(row.id)} {...dragRef({ kind: "session", id: row.id })} data-testid="menu-lane">
        <span className={`dotst${tag.tone ? ` ${tag.tone}` : ""}`} aria-hidden="true" data-testid="menu-lane-mark" data-tone={tag.tone || "plain"} />
        {place === "pinned" && (
          <span className="rec-pin" role="img" aria-label={t("row.pinned")} title={t("row.pinned")} data-testid="menu-lane-pin">
            <Icon name="pin" />
          </span>
        )}
        {row.title}
        <span className="vh">, {words}</span>
        {why && (
          <span className="rec-why" data-testid="menu-lane-why">
            {why}
          </span>
        )}
      </button>
      <LaneMore row={row} mark={mark} className="rec-more" />
    </li>
  );
}

/** Each project's lanes: its name in the menu's quiet heading, then its lanes. */
export function MenuLanesView({ groups, open, onOpen, marks }: MenuLanesProps) {
  return (
    <>
      {groups.map((g) => (
        <Fragment key={g.project}>
          <div className="sb-h" title={g.project} data-testid="menu-lanes-h">
            {g.name}
          </div>
          {/* the rows arrive once a session and slide when one is pinned or settled, as Recent's do (lib/firstPaint.ts) */}
          <ul className="sb-recent sb-lanes" aria-label={t("menu.lanesIn", { project: g.name })} data-arrive={`menu-lanes:${g.project}`} data-arrive-rows=".rec-li" data-flip-list data-testid="menu-lanes" data-project={g.project}>
            {g.lanes.map((l) => (
              <LaneMenuRow key={l.row.id} lane={l} open={l.row.id === open} onOpen={onOpen} marks={marks} />
            ))}
          </ul>
        </Fragment>
      ))}
    </>
  );
}

/** The menu's lane groups from the stores, followed while the menu is drawn. `on`: the code mode is open; outside it nothing is
 *  read, as nothing is drawn. */
export function useMenuLanes(on: boolean): { groups: LaneGroup[]; marks: RowMarks } {
  const stores = useLaneStores();
  const marks = useRowMarks();
  const picked = useCodeProject();
  return { groups: on ? menuLanesFrom(stores, marks, picked, Date.now()) : [], marks };
}

/** The same groups as they are now, for the previous and next lane keys (app/shortcuts.ts). */
export const menuLanesNow = (): LaneGroup[] => menuLanesFrom(laneStoresNow(), getRowMarks(), getCodeProject(), Date.now());
