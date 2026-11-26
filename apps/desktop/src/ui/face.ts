// The brand's team faces (the canvas's KitFaces and States: team faces boards; packages/ui-kit/app.css, "team faces"):
// what a member's face looks like and which of the kit's states it shows. Avatar.tsx draws it; face.css holds the kit's
// styles and moves. A face is drawn like the mark, a person in profile in the mark's ink on the member's own colour, and
// Buddy keeps the blue face (AUTHORING.md, "Team faces").
import type { AppState } from "../state/store";
import { selectAsks } from "../state/store";
import { asksOf, memberStatus, type MemberStatus } from "../pages/team";

/** The kit's `data-st` values (KitFaces' "Which state wins"). */
export type FaceState = "idle" | "listen" | "think" | "do" | "solve" | "write" | "ask" | "done" | "stuck" | "pause" | "practice" | "rest";

/** The kit's state for each of the app's member statuses (team.ts `memberStatus`). Not connected has no state in the kit,
 *  so it shows the plain face: no frame, no badge, no move, and the word beside it says why. The app does not yet know
 *  when Buddy has checked a member's work, so the kit's Done is never shown; a member who finished is Idle, as the Team
 *  page says. */
const STATE_OF: Record<MemberStatus, FaceState | null> = {
  paused: "pause",
  needs: "ask",
  offline: null,
  working: "do",
  stuck: "stuck",
  idle: "idle",
};

export function faceState(status: MemberStatus): FaceState | null {
  return STATE_OF[status];
}

/** The member who is Buddy: the lead, whom every runtime lists by this name (runtime/http/view.ts `TEAM`). */
export const BUDDY = "buddy";

/** The kit's hair shapes (KitFaces, "Hair"), each a `d` for the face's `fh` path, word for word. */
export const HAIR = {
  short:
    "M21.64 21.12C21.81 15.45 26.97 10.98 33.67 10.98C41.23 10.98 46.39 16.14 46.39 23.53C46.39 27.83 45.19 30.92 43.47 32.81C42.78 30.58 41.92 28.52 40.72 27.48C40.89 25.42 40.03 23.7 38.48 23.19C35.73 22.5 33.67 20.95 31.09 20.09C28.17 19.23 25.42 19.75 23.7 21.12C23.02 21.64 22.16 21.81 21.64 21.12Z",
  curly:
    "M21.98 20.78C21.3 18.89 21.98 16.66 23.88 15.97C24.22 13.22 27.66 12.02 30.06 13.39C31.44 11.33 35.39 11.5 37.11 13.91C39.69 12.53 43.12 14.94 42.78 17.86C45.7 18.03 46.91 21.81 44.84 23.88C47.42 25.08 47.08 29.03 44.33 30.06C45.7 32.3 43.64 34.7 40.72 34.36C39.69 31.78 38.66 28.34 36.94 26.28C34.36 23.19 29.2 21.12 21.98 20.78Z",
  bun: "M21.64 21.12C21.81 15.45 26.97 10.98 33.67 10.98C36.25 10.98 38.66 11.5 40.55 12.53C40.55 9.61 43.81 8.06 46.05 9.44C48.11 10.81 47.77 14.42 45.53 15.45C46.05 18.03 46.56 20.61 46.39 23.53C46.39 27.83 45.19 30.92 43.47 32.81C42.78 30.58 41.92 28.52 40.72 27.48C40.89 25.42 40.03 23.7 38.48 23.19C35.73 22.5 33.67 20.95 31.09 20.09C28.17 19.23 25.42 19.75 23.7 21.12C23.02 21.64 22.16 21.81 21.64 21.12Z",
  long: "M21.64 21.12C21.81 15.28 27.14 10.81 33.84 10.81C41.58 10.81 46.91 16.48 47.08 24.56C47.25 31.44 47.94 36.08 50 39L50 33.5C47.42 31.78 45.53 29.2 44.33 26.62C42.95 23.7 40.89 22.84 38.66 22.84C35.73 22.33 33.67 20.95 31.09 20.09C28.17 19.23 25.42 19.75 23.7 21.12C23.02 21.64 22.16 21.81 21.64 21.12Z",
  beanie:
    "M20.61 20.44C20.78 14.25 26.45 9.95 33.67 9.95C41.23 9.95 46.73 14.77 47.08 20.44L48.45 20.44C49.14 20.44 49.66 20.95 49.66 21.64L49.66 22.84C49.66 23.53 49.14 24.05 48.45 24.05L20.27 24.05C19.58 24.05 19.06 23.53 19.06 22.84L19.06 21.64C19.06 20.95 19.58 20.44 20.27 20.44ZM31.78 8.06A1.89 1.89 0 1 0 35.56 8.06A1.89 1.89 0 1 0 31.78 8.06Z",
  swoop:
    "M21.47 21.64C18.89 19.75 18.89 15.62 21.98 13.39C25.08 10.98 30.92 9.78 35.56 10.3C42.09 11.16 46.39 16.14 46.39 23.53C46.39 27.83 45.19 30.92 43.47 32.81C42.78 30.58 41.92 28.52 40.72 27.48C40.89 25.42 40.03 23.7 38.48 23.19C35.73 22.5 33.16 20.78 30.06 20.27C27.31 19.75 25.08 20.44 23.53 21.47C22.84 21.98 22.16 22.16 21.47 21.64Z",
} as const;

/** The kit's extras (KitFaces, "Colours and extras"), cut out of the face like the ear. */
export const EXTRA = {
  none: "M0 0",
  glasses: "M21.47 26.11A2.75 2.75 0 1 0 26.97 26.11A2.75 2.75 0 1 0 21.47 26.11ZM26.97 25.77L31.09 26.62",
  headset: "M27.66 15.11C32.81 12.7 39.69 13.56 43.12 18.89M30.92 26.28L34.36 26.28L34.36 30.92L30.92 30.92ZM32.64 30.92C31.95 33.67 27.66 35.05 23.19 34.19",
} as const;

export type Hair = keyof typeof HAIR;
export type Extra = keyof typeof EXTRA;

/** How one member's face is drawn: the tile's colour (its ground), the hair and the extra. */
export interface FaceLook {
  fill: string;
  hair: Hair;
  extra: Extra;
}

/** The six face colours, in the kit's order (KitFaces and MemberLook: Sky, Lilac, Sage, Sand, Peach, Butter). The Colour
 *  board names the first four as Nam's, Pim's, Ton's and Kit's. They are the same in both themes. */
export const FACE_COLOURS = ["#CDDDEB", "#DBD6EC", "#CEDFCE", "#E6D9C2", "#EFD3CC", "#EDE1B6"] as const;

/** The team the canvas draws, each as AUTHORING.md's "Sample world defaults" table and the Colour board give them. */
export const TEAM_LOOKS: Readonly<Record<string, FaceLook>> = {
  nam: { fill: "#CDDDEB", hair: "short", extra: "headset" },
  pim: { fill: "#DBD6EC", hair: "bun", extra: "none" },
  ton: { fill: "#CEDFCE", hair: "swoop", extra: "glasses" },
  kit: { fill: "#E6D9C2", hair: "beanie", extra: "none" },
};

/** The order in which members the person added take the colours the team leaves free: the canvas's team colours first,
 *  then the kit's spare ("A sixth team member", tokens.json), and the owner's own colour last, so a face looks like the
 *  owner's round picture only on a team of six or more. */
const ADDED_ORDER: readonly string[] = ["#CDDDEB", "#DBD6EC", "#CEDFCE", "#E6D9C2", "#EDE1B6", "#EFD3CC"];

/** Hairs a member the person added may get: the kit's six shapes, without "none". */
const ADDED_HAIRS: readonly Hair[] = ["short", "curly", "bun", "long", "beanie", "swoop"];

const hashOf = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

/** An added member's hair, from their id (from other bits of it than a colour picked by id, so the two vary apart). */
const hairOf = (id: string): Hair => ADDED_HAIRS[Math.floor(hashOf(id) / 7) % ADDED_HAIRS.length];

/** Every member's look on a team (`members`: the ids the runtime lists). The canvas's own four keep theirs. A member the
 *  person added gets a colour the team leaves free, by the MemberLook board's rule ("Each team member keeps their own
 *  colour, so two members never look alike in a list"): the added members, in the order of their ids, take the free
 *  colours in ADDED_ORDER, and only when there are more of them than free colours does a colour come round again. Their
 *  hair comes from their id, so it stays the same wherever they show. Buddy is not in the map: Buddy keeps the blue
 *  face. */
export function teamLooks(members: readonly string[]): Map<string, FaceLook> {
  const out = new Map<string, FaceLook>();
  const taken = new Set<string>();
  const added: string[] = [];
  for (const m of new Set(members)) {
    if (m === BUDDY) continue;
    const own = TEAM_LOOKS[m];
    if (own) {
      out.set(m, own);
      taken.add(own.fill);
    } else added.push(m);
  }
  const free = ADDED_ORDER.filter((c) => !taken.has(c));
  const pool = free.length ? free : ADDED_ORDER;
  added.sort().forEach((m, i) => {
    out.set(m, { fill: pool[i % pool.length], hair: hairOf(m), extra: "none" });
  });
  return out;
}

/** One member's look outside a team list (a row about someone the runtime no longer lists): the canvas's own for the four,
 *  else a colour and hair from the id alone. */
export function lookOf(member: string): FaceLook {
  const own = TEAM_LOOKS[member];
  if (own) return own;
  return { fill: ADDED_ORDER[hashOf(member) % ADDED_ORDER.length], hair: hairOf(member), extra: "none" };
}

let looksMemo: { bots: AppState["bots"]; looks: Map<string, FaceLook> } | null = null;

/** A member's look as the store's team has it, the same object while the team is unchanged (so a face that subscribes to
 *  it re-renders only when the team changes). */
export function lookIn(state: Pick<AppState, "bots">, member: string): FaceLook {
  if (!looksMemo || looksMemo.bots !== state.bots) looksMemo = { bots: state.bots, looks: teamLooks(state.bots.map((b) => b.name)) };
  let look = looksMemo.looks.get(member);
  if (!look) {
    look = lookOf(member);
    looksMemo.looks.set(member, look);
  }
  return look;
}

let stateMemo: { bots: AppState["bots"]; chats: AppState["chats"]; out: Map<string, FaceState | null> } | null = null;

/** The state a member's face shows, by the Team page's own rule (team.ts `memberStatus`) from what the store holds: the
 *  member as the runtime lists it, its main chat and the asks waiting on the person. Null for a member the runtime does not
 *  list, and for Not connected. Worked out once per store change for each member, however many faces show them. */
export function faceStateIn(state: Pick<AppState, "bots" | "chats">, member: string): FaceState | null {
  if (!stateMemo || stateMemo.bots !== state.bots || stateMemo.chats !== state.chats) stateMemo = { bots: state.bots, chats: state.chats, out: new Map() };
  const memo = stateMemo.out;
  if (memo.has(member)) return memo.get(member)!;
  const bot = state.bots.find((b) => b.name === member);
  const st = bot ? faceState(memberStatus(bot, state.chats[member], asksOf(selectAsks(state as AppState), member).length)) : null;
  memo.set(member, st);
  return st;
}

/** The kit's size classes, by the footprint they keep (an `av` of the same size): the face itself is a third larger and a
 *  negative margin takes the difference back, so the frame and the badge spill over without moving anything in the row. */
export const FACE_SIZES: Readonly<Record<number, string>> = { 24: "", 32: "md", 40: "lg", 96: "xl" };

/** The face's own box for a footprint the kit has no class for, in the kit's proportions (24 in a 32 box, 4px over each
 *  edge), so a face of any size keeps the same frame and badge and still takes only its footprint. */
export function faceBox(size: number): { width: number; height: number; margin: number } {
  const side = Math.round(((size * 4) / 3) * 2) / 2;
  return { width: side, height: side, margin: -(side - size) / 2 };
}
