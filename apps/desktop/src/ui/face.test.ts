// The brand's team faces: which of the kit's states a member's status shows, and each member's colour (the canvas's
// KitFaces, States: team faces and Colour boards; the kit's app.css and tokens.json in packages/ui-kit).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDDY, EXTRA, FACE_COLOURS, FACE_SIZES, HAIR, TEAM_LOOKS, faceBox, faceState, faceStateIn, lookIn, lookOf, teamLooks } from "./face";
import type { MemberStatus } from "../pages/team";
import type { AppState } from "../state/store";

const KIT_DIR = join(__dirname, "..", "..", "..", "..", "packages", "ui-kit");
const KIT = readFileSync(join(KIT_DIR, "app.css"), "utf8");
const FACE_CSS = readFileSync(join(__dirname, "face.css"), "utf8");
/** The kit's fixed colours by name (tokens.json `fixedColor`): the team's, the owner's and the spare. */
const TOKEN: Record<string, string> = Object.fromEntries(
  (JSON.parse(readFileSync(join(KIT_DIR, "tokens.json"), "utf8")).fixedColor as { name: string; value: string }[]).map((c) => [c.name, c.value]),
);

describe("a member's face state", () => {
  it("maps each of the app's statuses to the kit's data-st, and Not connected to the plain face", () => {
    const all: Record<MemberStatus, string | null> = { working: "do", needs: "ask", stuck: "stuck", paused: "pause", idle: "idle", offline: null };
    for (const [status, st] of Object.entries(all)) expect(faceState(status as MemberStatus), status).toBe(st);
  });

  it("names only states the kit draws", () => {
    for (const st of ["do", "ask", "stuck", "pause", "idle"]) expect(KIT, st).toContain(`.face[data-st="${st}"]`);
  });

  const state = () =>
    ({
      bots: [
        { name: "nam", status: "online", running: true },
        { name: "pim", status: "online", running: false },
        { name: "ton", status: "online", running: false, paused: true },
        { name: "kit", status: "offline", running: false },
      ],
      chats: {
        pim: { items: [{ kind: "approval", id: "a1", ts: 1 }], turn: null, lastTurn: null },
        ton: { items: [], turn: null, lastTurn: { id: "l", outcome: "error" } },
      },
    }) as unknown as AppState;

  it("reads the store by the Team page's own rule: working, an ask waiting, paused, not connected, unknown", () => {
    const s = state();
    expect(faceStateIn(s, "nam")).toBe("do");
    expect(faceStateIn(s, "pim")).toBe("ask");
    expect(faceStateIn(s, "ton")).toBe("pause");
    expect(faceStateIn(s, "kit")).toBeNull();
    expect(faceStateIn(s, "nobody")).toBeNull();
  });

  it("works a member's state out again when the store's team or chats change", () => {
    const s = state();
    expect(faceStateIn(s, "nam")).toBe("do");
    const stopped = { ...s, bots: s.bots.map((b) => (b.name === "nam" ? { ...b, running: false } : b)) } as AppState;
    expect(faceStateIn(stopped, "nam")).toBe("idle");
    const failed = { ...stopped, chats: { ...stopped.chats, nam: { items: [], turn: null, lastTurn: { id: "x", outcome: "error" } } } } as unknown as AppState;
    expect(faceStateIn(failed, "nam")).toBe("stuck");
  });
});

describe("a member's colour", () => {
  it("gives the canvas's team their own colour, hair and extra (Colour board, AUTHORING.md)", () => {
    expect(TEAM_LOOKS).toEqual({
      nam: { fill: "#CDDDEB", hair: "short", extra: "headset" },
      pim: { fill: "#DBD6EC", hair: "bun", extra: "none" },
      ton: { fill: "#CEDFCE", hair: "swoop", extra: "glasses" },
      kit: { fill: "#E6D9C2", hair: "beanie", extra: "none" },
    });
    // the same colours the kit's tokens.json names for them
    expect([TEAM_LOOKS.nam.fill, TEAM_LOOKS.pim.fill, TEAM_LOOKS.ton.fill, TEAM_LOOKS.kit.fill]).toEqual([TOKEN.teamNam, TOKEN.teamPim, TOKEN.teamTon, TOKEN.teamKit]);
    const looks = teamLooks(["buddy", "nam", "pim", "ton", "kit"]);
    expect(looks.get("nam")).toBe(TEAM_LOOKS.nam);
    // Buddy keeps the blue face, so Buddy takes none of the six
    expect(looks.has(BUDDY)).toBe(false);
  });

  it("gives a member the person added a colour no one else on the team has: the kit's spare, then the owner's", () => {
    const looks = teamLooks(["buddy", "nam", "pim", "ton", "kit", "stock", "ads"]);
    // sorted by id, ads before stock; the spare ("A sixth team member") is the first colour the canvas's team leaves free
    expect(looks.get("ads")!.fill).toBe(TOKEN.spare);
    expect(looks.get("stock")!.fill).toBe(TOKEN.owner);
    const fills = [...looks.values()].map((l) => l.fill);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it("is the same whatever order the team is listed in, and comes round again only past six", () => {
    const a = teamLooks(["kami", "friren", "default", "omh-tui"]);
    const b = teamLooks(["omh-tui", "default", "friren", "kami"]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    // with none of the canvas's team on it, their colours are free and go first
    expect([...a.values()].map((l) => l.fill).sort()).toEqual([TOKEN.teamNam, TOKEN.teamPim, TOKEN.teamTon, TOKEN.teamKit].sort());
    const many = teamLooks(["a", "b", "c", "d", "e", "f", "g"]);
    expect([..."abcdefg"].map((m) => many.get(m)!.fill)).toEqual([TOKEN.teamNam, TOKEN.teamPim, TOKEN.teamTon, TOKEN.teamKit, TOKEN.spare, TOKEN.owner, TOKEN.teamNam]);
  });

  it("draws an added member with one of the kit's hairs, chosen by id, and no extra", () => {
    const one = teamLooks(["stock"]).get("stock")!;
    expect(Object.keys(HAIR)).toContain(one.hair);
    expect(one.extra).toBe("none");
    expect(teamLooks(["stock", "ads"]).get("stock")!.hair).toBe(one.hair);
    expect(lookOf("stock").hair).toBe(one.hair);
  });

  it("keeps a look for a member the store does not list, from the id alone", () => {
    expect(lookOf("nam")).toBe(TEAM_LOOKS.nam);
    expect(lookOf("gone")).toEqual(lookOf("gone"));
    expect(FACE_COLOURS).toContain(lookOf("gone").fill);
    const s = { bots: [{ name: "nam" }] } as unknown as AppState;
    expect(lookIn(s, "nam")).toBe(lookIn(s, "nam"));
    expect(lookIn(s, "gone")).toEqual(lookOf("gone"));
  });

  it("draws with the kit's six face colours, all from tokens.json, and its hairs and extras", () => {
    expect(new Set(FACE_COLOURS)).toEqual(new Set([TOKEN.teamNam, TOKEN.teamPim, TOKEN.teamTon, TOKEN.teamKit, TOKEN.owner, TOKEN.spare]));
    expect(Object.keys(HAIR)).toEqual(["short", "curly", "bun", "long", "beanie", "swoop"]);
    expect(Object.keys(EXTRA)).toEqual(["none", "glasses", "headset"]);
  });
});

describe("a face's size", () => {
  it("uses the kit's classes for its four sizes and its proportions for the rest, keeping the footprint", () => {
    expect(FACE_SIZES).toEqual({ 24: "", 32: "md", 40: "lg", 96: "xl" });
    // the kit's own: 24 in 32 (-4), 96 in 128 (-16)
    expect(faceBox(24)).toEqual({ width: 32, height: 32, margin: -4 });
    expect(faceBox(96)).toEqual({ width: 128, height: 128, margin: -16 });
    for (const size of [12, 14, 18, 20, 26, 28, 34, 64]) {
      const b = faceBox(size);
      expect(b.width + 2 * b.margin, String(size)).toBeCloseTo(size, 5);
      expect(b.width / size).toBeCloseTo(4 / 3, 1);
    }
  });
});

describe("face.css", () => {
  it("is the kit's face section word for word, with the app's tokens for the kit's short names", () => {
    const section = KIT.slice(KIT.indexOf(".face{position"), KIT.indexOf("/* movement setting */"));
    const asApp = (css: string) =>
      css
        .replace(/var\(--blue\)/g, "var(--aui-blue)")
        .replace(/var\(--ok\)/g, "var(--aui-green)")
        .replace(/var\(--band\)/g, "var(--aui-subtle)")
        .replace(/var\(--mut\)/g, "var(--muted)");
    const rules = (css: string) =>
      css
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const ours = new Set(rules(FACE_CSS));
    // the busy button's spinner is not a face's, and the think dots' delays sit in the shorthand (face.css says why)
    const skip = (l: string) => /fspin/.test(l) || /o-dots circle:nth-child\([23]\)\{animation-delay/.test(l);
    expect(rules(asApp(section)).filter((l) => !skip(l) && !ours.has(l))).toEqual([]);
    expect(ours).toContain('.face[data-st="think"] .o-dots circle:nth-child(2){animation:fdot 1.5s .2s ease-in-out infinite}');
    expect(ours).toContain('.face[data-st="think"] .o-dots circle:nth-child(3){animation:fdot 1.5s .4s ease-in-out infinite}');
    // no keyframes of its own beyond the kit's face moves
    const kitMoves = new Set([...section.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    for (const m of FACE_CSS.matchAll(/@keyframes\s+([\w-]+)/g)) expect(kitMoves, m[1]).toContain(m[1]);
  });
});
