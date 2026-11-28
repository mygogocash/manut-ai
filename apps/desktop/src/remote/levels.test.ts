// levels.ts, permissions for each connection (item 108b): every cell of part 11's table (docs/multi-machine.md), written
// out here by hand rather than computed, so the module's table and the design's are checked against each other; the
// names refused at every level; and who may give which level (R5).
import { describe, expect, it } from "vitest";
import { type Grant, type Passkey, DEFAULT_GRANT, LEVELS, OFFERED_LEVELS, REQUEST_TABLE, STAYS_ON_MACHINE, covers, isGrant, mayGive, ruleFor, within } from "./levels";

const W: Grant = { level: "watch", terminal: false, manage: false };
const A: Grant = { level: "answer", terminal: false, manage: false };
const K: Grant = { level: "work", terminal: false, manage: false };
const KT: Grant = { level: "work", terminal: true, manage: false };
const KM: Grant = { level: "work", terminal: false, manage: true };
const KTM: Grant = { level: "work", terminal: true, manage: true };
/** The six grants a connection can hold, in the order of each row's cells below. */
const GRANTS: [string, Grant][] = [
  ["Watch", W],
  ["Answer", A],
  ["Work", K],
  ["Work and Terminal", KT],
  ["Work and Manage", KM],
  ["Work, Terminal and Manage", KTM],
];

type Form = { no?: true; answer?: string; own?: true };

/** Part 11's table, one row per request and form: the request, the form it is sent in, whether each of the six grants
 *  (Watch, Answer, Work, Work and Terminal, Work and Manage, all) is let through, and its passkey. */
const CELLS: [string, Form, string, Passkey][] = [
  ["list", {}, "111111", "none"],
  ["open", {}, "111111", "none"],
  ["catchup", {}, "111111", "none"],
  ["reply", { no: true }, "111111", "none"],
  ["stop", {}, "111111", "none"],
  ["status", {}, "111111", "none"],
  ["picture", {}, "111111", "none"],
  ["notify", {}, "111111", "none"],
  ["allow", {}, "011111", "each"],
  ["reply", { answer: "Friday" }, "011111", "each"],
  ["projects", {}, "001111", "none"],
  ["start", {}, "001111", "session"],
  ["send", {}, "001111", "session"],
  ["view_open", {}, "001111", "session"],
  ["view_input", {}, "001111", "session"],
  ["view_close", {}, "001111", "session"],
  ["move_list", {}, "001111", "none"],
  ["move_out", {}, "001111", "each"],
  ["move_in", {}, "001111", "each"],
  ["term_open", {}, "000101", "each"],
  ["term_input", {}, "000101", "none"],
  ["term_resize", {}, "000101", "none"],
  ["term_close", {}, "000101", "none"],
  ["update", {}, "000011", "each"],
  ["report", {}, "000011", "none"],
  ["pair_code", {}, "000011", "each"],
  ["pair_allow", {}, "000011", "each"],
  ["set_level", {}, "000011", "each"],
  ["set_level", { own: true }, "111111", "none"],
  ["revoke", {}, "111111", "each"],
  ["revoke", { own: true }, "111111", "none"],
];

describe("the request table (part 11)", () => {
  it("names exactly part 11's requests and notify, none of them refused by name", () => {
    expect([...REQUEST_TABLE.keys()].sort()).toEqual([...new Set(CELLS.map(([name]) => name))].sort());
    for (const name of REQUEST_TABLE.keys()) expect(STAYS_ON_MACHINE.has(name), name).toBe(false);
  });

  for (const [name, form, cells, passkey] of CELLS) {
    const { own, ...request } = form;
    it(`${name} ${JSON.stringify(form)}: ${cells}, passkey ${passkey}`, () => {
      const need = ruleFor(name, request, own === true);
      expect(need).not.toBeNull();
      expect(need!.passkey).toBe(passkey);
      GRANTS.forEach(([label, grant], i) => expect(covers(grant, need!), `${label} for ${name}`).toBe(cells[i] === "1"));
    });
  }

  it("reads a reply as No only when it says no and carries no answer", () => {
    expect(ruleFor("reply", { no: true })?.level).toBe("watch");
    for (const request of [{ no: true, answer: "Friday" }, { no: true, answers: { a: "yes" } }, { no: true, answer: null }, { no: "true" }, { answer: "Friday" }, {}]) {
      expect(ruleFor("reply", request)?.level, JSON.stringify(request)).toBe("answer");
    }
  });

  it("reads nothing a request says about its own level or permissions", () => {
    for (const claim of [{ level: "work" }, { terminal: true, manage: true }, { grant: KTM }, { own: true }]) {
      expect(ruleFor("allow", claim)).toEqual({ level: "answer", permission: null, passkey: "each" });
      expect(ruleFor("update", claim)).toEqual({ level: "work", permission: "manage", passkey: "each" });
    }
  });

  it("knows no other name, the object's own names included", () => {
    for (const name of ["LIST", "send_all", "__proto__", "constructor", "toString", "hasOwnProperty", ""]) expect(ruleFor(name, {}), name).toBeNull();
  });
});

describe("what stays on the machine", () => {
  it("is part 11's fifteen names, each with no rule at any level", () => {
    expect([...STAYS_ON_MACHINE].sort()).toEqual(
      ["always", "allow_always", "session", "allow_session", "folder", "dial", "mode", "pair", "unpair", "switch", "consent", "road", "sign_in", "vault", "settings"].sort(),
    );
    for (const name of STAYS_ON_MACHINE) {
      for (const own of [false, true]) expect(ruleFor(name, { no: true }, own), name).toBeNull();
    }
  });
});

describe("a grant", () => {
  it("is a known level, with Terminal and Manage only beside Work; anything else covers nothing", () => {
    for (const [, grant] of GRANTS) expect(isGrant(grant)).toBe(true);
    const odd: unknown[] = [
      null,
      "answer",
      [],
      {},
      { level: "admin", terminal: false, manage: false },
      { level: "Answer", terminal: false, manage: false },
      { level: "answer" },
      { level: "answer", terminal: true, manage: false },
      { level: "watch", terminal: false, manage: true },
      { level: "work", terminal: "yes", manage: false },
    ];
    for (const grant of odd) {
      expect(isGrant(grant), JSON.stringify(grant)).toBe(false);
      expect(covers(grant as Grant, ruleFor("list", {})!), JSON.stringify(grant)).toBe(false);
    }
  });

  it("is Answer for a device paired before this item and for a new pairing; Settings offers Watch and Answer only", () => {
    expect(DEFAULT_GRANT).toEqual(A);
    expect(Object.isFrozen(DEFAULT_GRANT)).toBe(true);
    expect(OFFERED_LEVELS).toEqual(["watch", "answer"]);
    expect(LEVELS).toEqual(["watch", "answer", "work"]);
  });
});

describe("who may give which level (R5)", () => {
  it("gives nothing without Manage, however narrow", () => {
    for (const [, giver] of GRANTS.filter(([, g]) => !g.manage)) {
      for (const [, wanted] of GRANTS) expect(mayGive(giver, wanted, false)).toBe(false);
    }
  });

  it("gives with Manage up to its own and never above: Manage without Terminal cannot give Terminal", () => {
    const gives = (giver: Grant) => GRANTS.filter(([, wanted]) => mayGive(giver, wanted, false)).map(([label]) => label);
    expect(gives(KM)).toEqual(["Watch", "Answer", "Work", "Work and Manage"]);
    expect(gives(KTM)).toEqual(GRANTS.map(([label]) => label));
  });

  it("always lets a connection narrow its own, and never widen it, Manage or not", () => {
    GRANTS.forEach(([, giver], i) =>
      GRANTS.forEach(([, wanted], j) => {
        // Each grant holds everything of the ones before it in this order but Work and Terminal, which Work and Manage lacks.
        const narrower = j <= i && !(i === 4 && j === 3);
        expect(mayGive(giver, wanted, true), `${i} to ${j}`).toBe(narrower);
        expect(within(wanted, giver), `${i} within ${j}`).toBe(narrower);
      }),
    );
  });

  it("gives nothing to or from a grant it does not understand", () => {
    const odd = { level: "admin", terminal: true, manage: true } as unknown as Grant;
    expect(mayGive(odd, W, true)).toBe(false);
    expect(mayGive(KTM, odd, false)).toBe(false);
  });
});
