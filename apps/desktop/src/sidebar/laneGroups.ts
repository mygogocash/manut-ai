// The lanes the side menu lists while the code mode is open (item 167a; docs/paradev-ux.md, "Navigation: where a lane is"), as
// Paradev keeps its workspaces in a sidebar that is always there: grouped by project, the project the Code page shows first and
// the others in the Code page's order, each group in the Lanes band's order and with its marks (Lanes.tsx `laneOrder`), and
// the previous and next lane keys stepping through the same list. The rules are here, apart from the markup, so they can be
// tested without a page; MenuLanes.tsx reads the stores and draws the rows.
//
// Nothing here answers anything: a row and a key only open a lane, as its row in the band does (Lanes.tsx `openLane`), and a lane
// that asks opens with its card in view, unanswered.
import { projectName } from "../code/kitAsks";
import { laneOrder, laneRowsFrom, type LaneInOrder, type LaneRow, type LaneStores } from "../code/Lanes";
import { folderGroups, pathKey } from "../sessions/folders";
import type { RowMarks } from "./rows";

/** One project's lanes as the menu lists them: its folder, its name as the Code page writes it, and its lanes in the band's order. */
export interface LaneGroup {
  project: string;
  name: string;
  lanes: LaneInOrder[];
}

/** The groups the menu draws. `lanes`: every lane with its project (its session's folder, as the Code page groups it). `projects`:
 *  the Code page's projects in its order. `open`: the project the Code page shows, which leads when it has a lane listed; with
 *  none, the groups keep the Code page's order, whose first is the project it shows by default. A group whose lanes are all put
 *  away (snoozed or archived) is not drawn. */
export function menuLaneGroups(lanes: readonly { project: string; row: LaneRow }[], projects: readonly string[], open: string | null, marks: RowMarks, now: number): LaneGroup[] {
  const by = new Map<string, LaneRow[]>();
  for (const l of lanes) by.set(l.project, [...(by.get(l.project) ?? []), l.row]);
  // a lane of a folder the list does not name yet comes last, in the order it was given, so no lane is ever out of sight
  const order = [...new Set([...(open ? [open] : []), ...projects, ...by.keys()])];
  return order.flatMap((project) => {
    const rows = by.get(project);
    const shown = rows ? laneOrder(rows, marks, now) : [];
    return shown.length ? [{ project, name: projectName(project), lanes: shown }] : [];
  });
}

/** The menu's lanes read from the stores: every project's lanes, the projects in the Code page's order, and the project it shows
 *  (`picked`, codeProject.ts) first. The Code page lists the folders sessions run in, newest first, before the folders the person
 *  added and the ones kept lanes were made from (KitPanel.tsx `codeProjects`); only the first can hold a lane, so they alone
 *  order the groups. */
export function menuLanesFrom(stores: LaneStores, marks: RowMarks, picked: string | null, now: number): LaneGroup[] {
  const { list } = stores.ss;
  const rows = laneRowsFrom(stores, () => true);
  const projectOf = new Map(list.map((r) => [r.id, pathKey(r.cwd)]));
  const projects = folderGroups(list.filter((r) => !!r.cwd)).map((g) => g.cwd);
  return menuLaneGroups(
    rows.map((row) => ({ row, project: projectOf.get(row.id) ?? "" })),
    projects,
    picked,
    marks,
    now,
  );
}

/** The lanes' ids top to bottom: the order the previous and next lane keys step through. */
export const menuLaneIds = (groups: readonly LaneGroup[]): string[] => groups.flatMap((g) => g.lanes.map((l) => l.row.id));
