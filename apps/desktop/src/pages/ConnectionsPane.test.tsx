// Customize › Connections for the shop's owner (connections.ts, ConnectionsPane.tsx): the canvas's Vault box and every outpost
// of the shop, drawn with react-dom/server in each state the boards draw, the in-place questions (Change, Who uses it, Remove,
// Rename), and above all that the password the owner types leaves the page's state the moment Save is pressed and is shown
// nowhere, that Change never saves a new account or address without it, and that Remove asks first. The views use no hooks,
// so a test calls them as plain functions to read the handlers a string render leaves out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { isOrigin, SIGN_IN_MEMBERS, type ShopConnections, type ShopOutpost, type VaultSignIn } from "../runtime/connections";
import { CustomizeView, type MemoryPaneProps, type RoutinesPaneProps } from "./CustomizePage";
import {
  addedLine,
  addFields,
  addStart,
  changedUsername,
  changeStart,
  changeTodo,
  CONN_START,
  connectionsDo,
  connReduce,
  memberName,
  membersReady,
  nameReady,
  outpostLine,
  passwordNeeded,
  passwordReady,
  readAddress,
  readAddresses,
  signInLine,
  thisMacRecord,
  type AddDraft,
  type ChangeDraft,
  type ConnAction,
  type ConnectionsCalls,
  type ConnUi,
} from "./connections";
import { ShopOutpostsPane, VaultPane, type ConnectionsProps } from "./ConnectionsPane";
import { LOADING } from "./load";
import { MEMORY_START } from "./memory";
import { outpostRow } from "./outpost";
import type { OutpostPaneProps } from "./OutpostPane";
import { ROUTINES_START } from "./routines";

/** 24 November 2026, 10:00 on this computer's clock. */
const NOW = new Date(2026, 10, 24, 10, 0).getTime();
const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).getTime() / 1000;
// Made up for this file, and never a real password.
const PASSWORD = "typed-pw-c0ffee-91";

const signIn = (over: Partial<VaultSignIn> = {}): VaultSignIn => ({
  id: "signin-shopee",
  site: "Shopee Seller Centre",
  username: "baan.mali@example.com",
  origins: ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"],
  members: ["nam", "ton"],
  state: "working",
  passwordSetAt: at(3, 9, 0),
  brokenAt: null,
  brokenBy: null,
  lastUsedAt: at(24, 9, 2),
  lastUsedBy: "nam",
  createdAt: at(3, 9, 0),
  ...over,
});
const carrier = signIn({ id: "signin-carrier", site: "Carrier portal", username: "baanmali", origins: ["https://track.carrier.example"], members: ["nam"],
  state: "broken", brokenAt: at(24, 9, 2), brokenBy: "nam" });
/** Change opened on the carrier portal's row, as its Change button opens it. */
const OPEN_CARRIER: ConnAction = { type: "change", signIn: "signin-carrier", username: "baanmali", origins: ["https://track.carrier.example"] };
const mac: ShopOutpost = { id: "outpost-mac", name: "Front desk Mac", kind: "this_mac", online: true, lastSeenAt: at(24, 9, 59), createdAt: at(3, 9, 0) };
const cloud: ShopOutpost = { id: "outpost-cloud", name: "Cloud outpost", kind: "cloud", online: false, lastSeenAt: null, createdAt: at(1, 8, 0) };
const DATA: ShopConnections = { shop: "pilot:baan-mali", signIns: [signIn(), carrier], outposts: [mac, cloud] };

const props = (over: Partial<ConnectionsProps> = {}): ConnectionsProps => ({
  state: { kind: "ready", value: DATA },
  ui: CONN_START,
  nowMs: NOW,
  dispatch: () => {},
  onSave: () => {},
  onRemove: () => {},
  ...over,
});
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const vault = (p: ConnectionsProps) => renderToString(<VaultPane p={p} />);
const outposts = (p: ConnectionsProps) => renderToString(<ShopOutpostsPane p={p} />);

/** Every element a view draws, with its own components expanded. */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byTestId = (node: ReactNode, id: string) => drawn(node).filter((e) => e.props["data-testid"] === id);

/** The page's state after each action, as `useReducer` keeps it. */
function reduce(...actions: ConnAction[]): ConnUi {
  return actions.reduce(connReduce, CONN_START);
}

/** A runtime client a test is not about: each change fails, so a test that reaches one by mistake says so. */
const noCalls: ConnectionsCalls = {
  add: () => Promise.reject(new Error("not this test's change")),
  password: () => Promise.reject(new Error("not this test's change")),
  members: () => Promise.reject(new Error("not this test's change")),
  change: () => Promise.reject(new Error("not this test's change")),
  removeSignIn: () => Promise.reject(new Error("not this test's change")),
  rename: () => Promise.reject(new Error("not this test's change")),
  remove: () => Promise.reject(new Error("not this test's change")),
};

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("how a sign-in and an outpost are said", () => {
  it("names the members as the team is named, and joins them as each language does", () => {
    expect(memberName("nam")).toBe("Nam");
    expect(signInLine(signIn({ lastUsedAt: null }), NOW)).toBe("Used by Nam and Ton");
    expect(signInLine(signIn({ members: ["nam", "pim", "ton"], lastUsedAt: null }), NOW)).toBe("Used by Nam, Pim and Ton");
  });

  it("says when it was last used, as the canvas does: today by the time, another day with its date", () => {
    expect(signInLine(signIn(), NOW)).toBe("Used by Nam and Ton, last today 09:02");
    expect(signInLine(signIn({ lastUsedAt: at(22, 14, 5) }), NOW)).toBe("Used by Nam and Ton, last 22 November 14:05");
  });

  it("says when the site refused the saved password, in place of who uses it", () => {
    expect(signInLine(carrier, NOW)).toBe("The site refused the saved password today at 09:02.");
    expect(signInLine({ ...carrier, brokenAt: at(22, 14, 5) }, NOW)).toBe("The site refused the saved password on 22 November at 14:05.");
  });

  it("says when a sign-in was added, and what each outpost is", () => {
    expect(addedLine(signIn(), NOW)).toBe("Added 3 November");
    expect(outpostLine(mac, NOW)).toBe("A Mac with the app, added 3 November");
    expect(outpostLine(cloud, NOW)).toBe("Wakes when work arrives. Costs nothing asleep.");
  });
});

describe("the Vault box", () => {
  it("draws the canvas's box: each sign-in, who may use it, whether it works, when it was added, its Change, and Add a sign-in", () => {
    const html = vault(props());
    expect(words(html)).toBe(
      "Vault Passwords are hidden from AI Sign-ins your team may use. The vault types the password in. The AI never sees it. " +
        "Shopee Seller Centre Used by Nam and Ton, last today 09:02 Added 3 November Working Change Who uses it Remove " +
        "Carrier portal The site refused the saved password today at 09:02. Added 3 November Needs a new password Change Who uses it Remove " +
        "Add a sign-in",
    );
    expect(byTestId(VaultPane({ p: props() }), "signin-who").map((e) => [e.props.className, e.props["aria-label"]])).toEqual([
      ["lk", "Who uses it: Shopee Seller Centre"],
      ["lk", "Who uses it: Carrier portal"],
    ]);
    expect(byTestId(VaultPane({ p: props() }), "signin-remove").map((e) => [e.props.className, e.props["aria-label"]])).toEqual([
      ["lk", "Remove: Shopee Seller Centre"],
      ["lk", "Remove: Carrier portal"],
    ]);
    // The row shows the canvas's lines: the account and the addresses are for Change and Remove's question, not the row.
    expect(words(html)).not.toContain("baan.mali@example.com");
    // The states board's two rows: working, with a quiet Change; refused, with a warning tag and a button.
    const [shopee, refused] = byTestId(VaultPane({ p: props() }), "signin-change");
    expect([shopee?.props.className, refused?.props.className]).toEqual(["lk", "btn"]);
    expect(byTestId(VaultPane({ p: props() }), "signin-tag").map((e) => e.props.className)).toEqual(["tag ok", "tag warn"]);
    expect(html).toContain('class="tag run"');
  });

  it("says it is reading, why it could not, or that the vault is empty", () => {
    expect(words(vault(props({ state: LOADING })))).toContain("Reading the vault…");
    // A refusal the tab knows is said in its own words, in the owner's language, whatever words the runtime used.
    expect(words(vault(props({ state: { kind: "unavailable", code: "owner_only", message: "Only Noi sees it." } })))).toContain(
      "Only the shop's owner sees and changes its sign-ins and outposts.",
    );
    expect(words(vault(props({ state: { kind: "unavailable", code: "offline", message: "Offline: the Manut AI API cannot be reached." } })))).toContain(
      "Offline: the Manut AI API cannot be reached.",
    );
    // An empty vault says so, with Add a sign-in under it: the owner adds one from here.
    expect(words(vault(props({ state: { kind: "ready", value: { ...DATA, signIns: [] } } })))).toContain("No sign-ins yet. Add a sign-in");
    // Add a sign-in is there only once the vault was read: not while reading, and not for a helper's refusal.
    expect(vault(props({ state: LOADING }))).not.toContain('data-testid="signin-add"');
    expect(vault(props({ state: { kind: "unavailable", code: "owner_only", message: "Only Noi sees it." } }))).not.toContain('data-testid="signin-add"');
    // Until the vault is read, nothing about the shop's outposts is drawn: the Vault box says why.
    expect(outposts(props({ state: LOADING }))).toBe("");
  });

  it("opens Change in the row with its password first, which saves only what was typed and cancels on Escape", () => {
    const dispatch = vi.fn();
    const change = byTestId(VaultPane({ p: props({ dispatch }) }), "signin-change")[1];
    (change?.props.onClick as () => void)();
    expect(dispatch).toHaveBeenCalledWith(OPEN_CARRIER);

    const onSave = vi.fn();
    const empty = props({ ui: reduce(OPEN_CARRIER), dispatch, onSave });
    const field = byTestId(VaultPane({ p: empty }), "password-input")[0];
    expect(field?.props).toMatchObject({ type: "password", value: "", autoComplete: "new-password", spellCheck: false, maxLength: 1024, autoFocus: true });
    expect(byTestId(VaultPane({ p: empty }), "change-save")[0]?.props.disabled).toBe(true);
    expect(words(vault(empty))).toContain("Password for Carrier portal");
    // Nothing else can be asked while the question is open: the other row's links wait, and this row's give way to it.
    expect([...byTestId(VaultPane({ p: empty }), "signin-change"), ...byTestId(VaultPane({ p: empty }), "signin-remove")].map((e) => e.props.disabled))
      .toEqual([true, true]);

    const typed = props({ ui: reduce(OPEN_CARRIER, { type: "field", field: "password", text: PASSWORD }), dispatch, onSave });
    expect(byTestId(VaultPane({ p: typed }), "change-save")[0]?.props.disabled).toBe(false);
    const form = byTestId(VaultPane({ p: typed }), "change-form")[0];
    (form?.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault() {} });
    expect(onSave).toHaveBeenCalledTimes(1);
    // The field's value is drawn as the browser keeps it for a password field: never as words on the page.
    expect(words(vault(typed))).not.toContain(PASSWORD);
    (form?.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault() {}, nativeEvent: { isComposing: false } });
    expect(dispatch).toHaveBeenCalledWith({ type: "cancel" });
  });
});

describe("the shop's outposts", () => {
  it("lists every outpost by its name, online or asleep, each with Rename and Remove", () => {
    expect(words(outposts(props()))).toBe(
      "Your shop's outposts Every machine your shop has, by the name it was given. Rename one so you can tell them apart. Removing one stops its work at once. " +
        "Front desk Mac A Mac with the app, added 3 November Online Rename Remove " +
        "Cloud outpost Wakes when work arrives. Costs nothing asleep. Asleep Rename Remove",
    );
    expect(byTestId(ShopOutpostsPane({ p: props() }), "outpost-remove").map((e) => e.props["aria-label"])).toEqual(["Remove: Front desk Mac", "Remove: Cloud outpost"]);
  });

  it("renames in the row: the name in a field, saved only when it says something new the vault would take", () => {
    const dispatch = vi.fn();
    (byTestId(ShopOutpostsPane({ p: props({ dispatch }) }), "outpost-rename")[0]?.props.onClick as () => void)();
    expect(dispatch).toHaveBeenCalledWith({ type: "rename", outpost: "outpost-mac", name: "Front desk Mac" });
    const open = (draft: string) => props({ ui: reduce({ type: "rename", outpost: "outpost-mac", name: "Front desk Mac" }, { type: "draft", text: draft }) });
    expect(byTestId(ShopOutpostsPane({ p: open("Front desk Mac") }), "outpost-name-save")[0]?.props.disabled).toBe(true);
    expect(byTestId(ShopOutpostsPane({ p: open("Counter Mac") }), "outpost-name-save")[0]?.props.disabled).toBe(false);
    expect(words(outposts(open("x".repeat(81))))).toContain("A name is 1 to 80 letters.");
    expect(nameReady("  Counter Mac ", "Front desk Mac")).toBe(true);
    expect(nameReady("   ", "Front desk Mac")).toBe(false);
    expect(nameReady("Mac\u0007", "Front desk Mac")).toBe(false);
    expect(nameReady("ร้าน".repeat(20), "Front desk Mac")).toBe(true);
  });

  it("asks once before Remove, with the outpost still named and the safe answer holding the focus", () => {
    const onRemove = vi.fn();
    const p = props({ ui: reduce({ type: "remove", outpost: "outpost-cloud" }), onRemove });
    expect(words(outposts(p))).toContain("Cloud outpost Remove Cloud outpost? Its work stops at once, and it must be registered again to work. Remove Keep");
    const [yes, keep] = [byTestId(ShopOutpostsPane({ p }), "outpost-remove-yes")[0], byTestId(ShopOutpostsPane({ p }), "outpost-remove-keep")[0]];
    expect(keep?.props.autoFocus).toBe(true);
    // Keys of their own, so the question's buttons are new elements and Keep takes the focus as it appears.
    expect([yes?.key, keep?.key]).toEqual(["remove-yes", "remove-keep"]);
    (byTestId(ShopOutpostsPane({ p }), "outpost-remove-yes")[0]?.props.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("the typed password", () => {
  it("leaves the page's state the moment Save is pressed, and is not put back when the send fails", () => {
    const typing = reduce(OPEN_CARRIER, { type: "field", field: "password", text: PASSWORD });
    const opened = { username: "baanmali", addresses: ["https://track.carrier.example"] };
    expect(typing.ask).toEqual({ kind: "change", signIn: "signin-carrier", draft: { ...opened, password: PASSWORD } });
    const sending = connReduce(typing, { type: "begin" });
    expect(sending).toEqual({ ask: { kind: "change", signIn: "signin-carrier", draft: { ...opened, password: "" } }, busy: true, at: "vault", error: null,
      notice: null });
    expect(JSON.stringify(sending)).not.toContain(PASSWORD);
    // Typing is refused while it is on its way, so nothing new collects in the field.
    expect(connReduce(sending, { type: "field", field: "password", text: PASSWORD })).toBe(sending);
    const refused = connReduce(sending, { type: "failed", message: t("conn.err.again"), close: false });
    expect(refused.ask).toEqual({ kind: "change", signIn: "signin-carrier", draft: { ...opened, password: "" } });
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
    const saved = connReduce(sending, { type: "done", notice: t("vault.saved") });
    expect(saved).toEqual({ ask: null, busy: false, at: "vault", error: null, notice: "Saved. The vault types the new password from now on." });
  });

  it("is sent once, for the shop its row was read for, and comes back in no word the page shows", async () => {
    const sent: unknown[][] = [];
    const calls: ConnectionsCalls = {
      ...noCalls,
      password: async (...args) => {
        sent.push(args);
        return { signIn: { ...carrier, state: "working", brokenAt: null, brokenBy: null, passwordSetAt: NOW / 1000 } };
      },
      rename: async () => ({ outpost: mac }),
      remove: async (_shop, outpost) => ({ outpost }),
    };
    const done = await connectionsDo(calls, DATA, { what: "password", signIn: "signin-carrier", password: PASSWORD });
    expect(sent).toEqual([["pilot:baan-mali", "signin-carrier", PASSWORD]]);
    expect(done.data.signIns[1]).toMatchObject({ id: "signin-carrier", state: "working" });
    expect(done.action).toEqual({ type: "done", notice: t("vault.saved") });
    expect(JSON.stringify(done)).not.toContain(PASSWORD);

    // A runtime whose refusal repeated it would still not get it on the page.
    const echoing: ConnectionsCalls = { ...calls, password: async () => Promise.reject({ code: "refused", message: `could not save ${PASSWORD}` }) };
    const failed = await connectionsDo(echoing, DATA, { what: "password", signIn: "signin-carrier", password: PASSWORD });
    expect(failed.action).toEqual({ type: "failed", message: "That did not work. Try again.", close: false });
  });

  it("says each refusal in the owner's words, and drops a row the shop no longer has", async () => {
    const refusing = (code: string, message = "runtime words"): ConnectionsCalls => ({
      add: () => Promise.reject({ code, message }),
      password: () => Promise.reject({ code, message }),
      members: () => Promise.reject({ code, message }),
      change: () => Promise.reject({ code, message }),
      removeSignIn: () => Promise.reject({ code, message }),
      rename: () => Promise.reject({ code, message }),
      remove: () => Promise.reject({ code, message }),
    });
    const gone = await connectionsDo(refusing("sign_in_not_found"), DATA, { what: "password", signIn: "signin-carrier", password: PASSWORD });
    expect(gone.action).toEqual({ type: "failed", message: "That sign-in is no longer in the vault.", close: true });
    expect(gone.data.signIns.map((s) => s.id)).toEqual(["signin-shopee"]);
    const tooLong = await connectionsDo(refusing("invalid_password"), DATA, { what: "password", signIn: "signin-carrier", password: PASSWORD });
    expect(tooLong.action).toEqual({ type: "failed", message: "A password is 1 to 1024 characters.", close: false });
    const helper = await connectionsDo(refusing("owner_only"), DATA, { what: "remove", outpost: "outpost-cloud" });
    expect(helper.action).toEqual({ type: "failed", message: "Only the shop's owner sees and changes its sign-ins and outposts.", close: false });
    const removed = await connectionsDo(refusing("outpost_not_found"), DATA, { what: "rename", outpost: "outpost-cloud", name: "Night" });
    expect(removed.data.outposts.map((o) => o.id)).toEqual(["outpost-mac"]);
    // A refusal the tab has no words of its own for is said in the runtime's.
    const offline = await connectionsDo(refusing("offline", "Offline: the Manut AI API cannot be reached."), DATA, { what: "remove", outpost: "outpost-cloud" });
    expect(offline.action).toEqual({ type: "failed", message: "Offline: the Manut AI API cannot be reached.", close: false });
  });

  it("is ready to save once anything is typed, up to what the vault takes, spaces included", () => {
    expect(passwordReady("")).toBe(false);
    expect(passwordReady(" ")).toBe(true);
    expect(passwordReady("x".repeat(1024))).toBe(true);
    expect(passwordReady("x".repeat(1025))).toBe(false);
  });
});

describe("renaming and removing, step by step", () => {
  it("puts the runtime's answer in its place, and says what was done", async () => {
    const calls: ConnectionsCalls = {
      ...noCalls,
      password: async () => ({ signIn: carrier }),
      rename: async (_shop, outpost, name) => ({ outpost: { ...mac, id: outpost, name } }),
      remove: async (_shop, outpost) => ({ outpost }),
    };
    const renamed = await connectionsDo(calls, DATA, { what: "rename", outpost: "outpost-mac", name: "Counter Mac" });
    expect(renamed.data.outposts.map((o) => o.name)).toEqual(["Counter Mac", "Cloud outpost"]);
    expect(renamed.action).toEqual({ type: "done", notice: "Renamed to Counter Mac." });
    const removed = await connectionsDo(calls, DATA, { what: "remove", outpost: "outpost-cloud" });
    expect(removed.data.outposts.map((o) => o.id)).toEqual(["outpost-mac"]);
    expect(removed.action).toEqual({ type: "done", notice: "Removed. Cloud outpost no longer works for your team." });
  });

  it("shows what a change said in the part of the tab it was in", () => {
    const outpostsSaid = props({ ui: { ...CONN_START, at: "outposts", notice: "Renamed to Counter Mac." } });
    expect(outposts(outpostsSaid)).toContain("Renamed to Counter Mac.");
    expect(vault(outpostsSaid)).not.toContain("Renamed to Counter Mac.");
    const vaultSaid = props({ ui: { ...CONN_START, at: "vault", error: "That sign-in is no longer in the vault." } });
    expect(vault(vaultSaid)).toContain('role="alert"');
    expect(outposts(vaultSaid)).not.toContain("no longer in the vault");
  });

  it("lets nothing new be asked while a change is on its way", () => {
    const busy = connReduce(reduce({ type: "remove", outpost: "outpost-cloud" }), { type: "begin" });
    expect(connReduce(busy, { type: "change", signIn: "signin-shopee", username: "baan.mali@example.com", origins: ["https://seller.shopee.co.th"] })).toBe(busy);
    expect(connReduce(busy, { type: "removeSignIn", signIn: "signin-shopee" })).toBe(busy);
    expect(connReduce(busy, { type: "cancel" })).toBe(busy);
    expect(connReduce(busy, { type: "rename", outpost: "outpost-mac", name: "x" })).toBe(busy);
  });
});

describe("Connections in every language", () => {
  it("has every word of the tab in ko, ja and zh, never the English", () => {
    const english = [words(vault(props())), words(outposts(props())), signInLine(carrier, NOW), outpostLine(cloud, NOW)];
    for (const lang of LANGS.filter((l) => l !== "en")) {
      setLang(lang);
      const drawnNow = [words(vault(props())), words(outposts(props())), signInLine(carrier, NOW), outpostLine(cloud, NOW)];
      drawnNow.forEach((said, i) => {
        expect(said, `${lang} ${i}`).not.toBe(english[i]);
        expect(said.length, `${lang} ${i}`).toBeGreaterThan(0);
      });
      expect(words(vault(props()))).toContain(t("vault.title"));
      // The members' names are the same in every language.
      expect(signInLine(signIn({ lastUsedAt: null }), NOW)).toMatch(/Nam.*Ton/);
    }
  });
});

describe("the Connections tab", () => {
  const memory: MemoryPaneProps = { state: LOADING, ui: MEMORY_START, nowMs: 0, dispatch: () => {}, onRemember: () => {}, onConfirm: () => {}, onCorrect: () => {}, onForget: () => {} };
  const routines: RoutinesPaneProps = { state: LOADING, ui: ROUTINES_START, nowMs: 0, dispatch: () => {}, onAdd: () => {}, onSwitch: () => {}, onRemove: () => {} };
  const thisMac = { row: outpostRow({ kind: "practice" }), busy: false, error: null, onAction: () => {} };

  it("draws the Vault box, then this Mac's Outposts box, then every outpost of the shop", () => {
    const html = renderToString(<CustomizeView memory={memory} routines={routines} tab="connections" onTab={() => {}} connections={thisMac} vault={props()} />);
    const order = ["data-testid=\"vault\"", "data-testid=\"outposts\"", "data-testid=\"shop-outposts\""].map((id) => html.indexOf(id));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("draws this Mac's box alone on a runtime that does not answer the vault, as before", () => {
    const html = renderToString(<CustomizeView memory={memory} routines={routines} tab="connections" onTab={() => {}} connections={thisMac} vault={null} />);
    expect(html).toContain('data-testid="outposts"');
    expect(html).not.toContain('data-testid="vault"');
    expect(html).not.toContain('data-testid="shop-outposts"');
  });
});

describe("this Mac, folded into its own row", () => {
  const memory: MemoryPaneProps = { state: LOADING, ui: MEMORY_START, nowMs: 0, dispatch: () => {}, onRemember: () => {}, onConfirm: () => {}, onCorrect: () => {}, onForget: () => {} };
  const routines: RoutinesPaneProps = { state: LOADING, ui: ROUTINES_START, nowMs: 0, dispatch: () => {}, onAdd: () => {}, onSwitch: () => {}, onRemove: () => {} };
  /** This Mac's Outposts box with what the shell said: running, and the id this Mac's outpost has on the shop's list. */
  const running = (id: string | null): OutpostPaneProps => ({
    row: outpostRow({ kind: "signed_in", view: { state: "running", online: true, steps: 2, name: "This Mac", id } }),
    busy: false,
    error: null,
    onAction: () => {},
    thisMac: id,
  });
  const draw = (connections: OutpostPaneProps, p: ConnectionsProps) =>
    renderToString(<CustomizeView memory={memory} routines={routines} tab="connections" onTab={() => {}} connections={connections} vault={p} />);
  /** The words of one part of the tab, by its test id. */
  const part = (html: string, id: string) => {
    const from = html.indexOf(`data-testid="${id}"`);
    return from < 0 ? "" : words(html.slice(html.lastIndexOf("<section", from), html.indexOf("</section>", from)));
  };

  it("shows this Mac's record in its own row and leaves it out of the shop's list, so it is never shown twice", () => {
    const html = draw(running("outpost-mac"), props());
    expect(part(html, "outposts")).toBe(
      "Outposts The machines your team works on. This Mac Running 2 steps Online Stop Named Front desk Mac Rename Remove " +
        "While your team works here, its browser opens in a window of its own and goes only to your shop's own sites. The vault types passwords in. The AI never sees them.",
    );
    expect(part(html, "shop-outposts")).not.toContain("Front desk Mac");
    expect(part(html, "shop-outposts")).toContain("Cloud outpost");
    expect(words(html).split("Front desk Mac")).toHaveLength(2);
  });

  it("lists every outpost while the shell has not said which is this Mac, or names one the list does not have", () => {
    for (const id of [null, "outpost-gone", "outpost-cloud"]) {
      const html = draw(running(id), props());
      expect(html, String(id)).not.toContain('data-testid="this-mac-record"');
      expect(part(html, "shop-outposts"), String(id)).toContain("Front desk Mac");
      expect(part(html, "shop-outposts"), String(id)).toContain("Cloud outpost");
    }
    expect(thisMacRecord({ kind: "ready", value: DATA }, "outpost-mac")).toEqual(mac);
    expect(thisMacRecord({ kind: "ready", value: DATA }, "outpost-cloud")).toBeNull();
    expect(thisMacRecord(LOADING, "outpost-mac")).toBeNull();
  });

  it("says no other outposts are listed when this Mac was the only one", () => {
    const only = props({ state: { kind: "ready", value: { ...DATA, outposts: [mac] } } });
    expect(part(draw(running("outpost-mac"), only), "shop-outposts")).toContain("No other outposts yet.");
    expect(part(draw(running(null), props({ state: { kind: "ready", value: { ...DATA, outposts: [] } } })), "shop-outposts")).toContain("No outposts yet.");
  });

  it("asks Rename and Remove in this Mac's row, and says what they did there", () => {
    const dispatch = vi.fn();
    const box = () => CustomizeView({ memory, routines, tab: "connections", onTab: () => {}, connections: running("outpost-mac"), vault: props({ dispatch }) }) as ReactNode;
    const record = byTestId(box(), "this-mac-record")[0]!;
    const [rename, remove] = [byTestId(record, "outpost-rename")[0]!, byTestId(record, "outpost-remove")[0]!];
    (rename.props.onClick as () => void)();
    (remove.props.onClick as () => void)();
    expect(dispatch.mock.calls).toEqual([
      [{ type: "rename", outpost: "outpost-mac", name: "Front desk Mac", at: "this_mac" }],
      [{ type: "remove", outpost: "outpost-mac", at: "this_mac" }],
    ]);
    // The question opens in this Mac's row, and the shop's list stays as it was.
    const renaming = draw(running("outpost-mac"), props({ ui: reduce({ type: "rename", outpost: "outpost-mac", name: "Front desk Mac", at: "this_mac" }) }));
    expect(part(renaming, "outposts")).toContain("New name for Front desk Mac");
    expect(part(renaming, "shop-outposts")).not.toContain("New name for");
    const removing = draw(running("outpost-mac"), props({ ui: reduce({ type: "remove", outpost: "outpost-mac", at: "this_mac" }) }));
    expect(part(removing, "outposts")).toContain("Remove Front desk Mac? Its work stops at once");
    // Its words stay with the row through the change, and show there, not in the list.
    expect(connReduce(reduce({ type: "rename", outpost: "outpost-mac", name: "Front desk Mac", at: "this_mac" }), { type: "begin" }).at).toBe("this_mac");
    expect(connReduce(reduce({ type: "rename", outpost: "outpost-cloud", name: "Cloud outpost" }), { type: "begin" }).at).toBe("outposts");
    const sent = connReduce(reduce({ type: "remove", outpost: "outpost-mac", at: "this_mac" }), { type: "begin" });
    expect(sent.at).toBe("this_mac");
    const said = draw(running(null), props({ ui: connReduce(sent, { type: "done", notice: "Removed. Front desk Mac no longer works for your team." }) }));
    expect(part(said, "outposts")).toContain("Removed. Front desk Mac no longer works for your team.");
    expect(part(said, "shop-outposts")).not.toContain("Removed.");
  });

  it("has its words in ko, ja and zh, never the English", () => {
    const english = [part(draw(running("outpost-mac"), props()), "outposts"), part(draw(running("outpost-mac"), props({ state: { kind: "ready", value: { ...DATA, outposts: [mac] } } })), "shop-outposts")];
    for (const lang of LANGS.filter((l) => l !== "en")) {
      setLang(lang);
      expect(part(draw(running("outpost-mac"), props()), "outposts"), lang).not.toBe(english[0]);
      expect(part(draw(running("outpost-mac"), props()), "outposts"), lang).toContain("Front desk Mac");
      expect(part(draw(running("outpost-mac"), props({ state: { kind: "ready", value: { ...DATA, outposts: [mac] } } })), "shop-outposts"), lang).not.toBe(english[1]);
    }
  });
});

// ---- Add a sign-in, and who may use one -------------------------------------------------------------------------------------

/** Add a sign-in, open with `draft` typed into it. */
const adding = (draft: Partial<AddDraft>, over: Partial<ConnectionsProps> = {}) =>
  props({ ui: { ...CONN_START, ask: { kind: "add", draft: { ...addStart(), ...draft } }, at: "vault" }, ...over });
/** Everything a new sign-in needs, as an owner types it: a page's address pasted whole, a space a paste brought. */
const READY: AddDraft = { site: "Carrier portal", addresses: ["https://track.carrier.example/parcels?id=1"], username: "baan.mali ", password: PASSWORD, members: ["nam"] };
type Change = (e: { target: { value: string } }) => void;
const submit = (form: ReactElement<Record<string, unknown>> | undefined) => (form?.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault() {} });
const escape = (form: ReactElement<Record<string, unknown>> | undefined) =>
  (form?.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault() {}, nativeEvent: { isComposing: false } });

describe("Add a sign-in", () => {
  it("opens its form in the canvas's last row, with every field empty and nobody ticked, and nothing else can be asked", () => {
    const dispatch = vi.fn();
    (byTestId(VaultPane({ p: props({ dispatch }) }), "signin-add")[0]?.props.onClick as () => void)();
    expect(dispatch).toHaveBeenCalledWith({ type: "add" });
    const open = reduce({ type: "add" });
    expect(open).toEqual({ ...CONN_START, ask: { kind: "add", draft: { site: "", addresses: [""], username: "", password: "", members: [] } }, at: "vault" });
    const said = words(vault(props({ ui: open })));
    expect(said).toContain("A new sign-in for your team The site's name Its address Paste it from your browser, starting with https://.");
    expect(said).toContain("The account's name on the site The email or name you sign in with there. Its password");
    expect(said).toContain("Who may use it Nam Pim Ton Kit Only the members you tick may use it.");
    const box = VaultPane({ p: props({ ui: open }) });
    // The link gives way to the form, and each row's links wait while it is open.
    expect(byTestId(box, "signin-add")).toEqual([]);
    expect([...byTestId(box, "signin-change"), ...byTestId(box, "signin-who")].map((e) => e.props.disabled)).toEqual([true, true, true, true]);
    expect(byTestId(box, "add-save")[0]?.props.disabled).toBe(true);
    expect(byTestId(box, "add-password")[0]?.props).toMatchObject({ type: "password", value: "", autoComplete: "new-password", maxLength: 1024, spellCheck: false });
    expect(byTestId(box, "add-address")[0]?.props).toMatchObject({ type: "text", inputMode: "url", autoCapitalize: "off", spellCheck: false });
    expect(SIGN_IN_MEMBERS.map((m) => byTestId(box, `member-${m}`)[0]?.props.checked)).toEqual([false, false, false, false]);
  });

  it("reads each address as the vault keeps it: the site's part only, and https only", () => {
    expect(readAddress("https://Seller.Shopee.co.th/portal/sale?type=toship")).toEqual({ kind: "origin", origin: "https://seller.shopee.co.th", changed: true });
    expect(readAddress("  https://seller.shopee.co.th  ")).toEqual({ kind: "origin", origin: "https://seller.shopee.co.th", changed: false });
    expect(readAddress("https://seller.shopee.co.th:443/")).toEqual({ kind: "origin", origin: "https://seller.shopee.co.th", changed: true });
    expect(readAddress("https://seller.shopee.co.th:8443")).toEqual({ kind: "origin", origin: "https://seller.shopee.co.th:8443", changed: false });
    expect(readAddress(" ")).toEqual({ kind: "empty" });
    for (const text of ["http://seller.shopee.co.th", "ftp://files.example", "seller.shopee.co.th:443"]) {
      expect(readAddress(text), text).toEqual({ kind: "problem", problem: "not_https" });
    }
    for (const text of ["seller.shopee.co.th", "shopee", "https://"]) expect(readAddress(text), text).toEqual({ kind: "problem", problem: "not_address" });
    expect(readAddress("https://fon:secret@seller.shopee.co.th")).toEqual({ kind: "problem", problem: "account" });
    expect(readAddress("https://fon@seller.shopee.co.th")).toEqual({ kind: "problem", problem: "account" });
    const reads = readAddresses(["https://a.example/x", "https://A.example", "", "https://b.example"]);
    expect(reads.map((r) => (r.kind === "problem" ? r.problem : r.kind))).toEqual(["origin", "repeated", "empty", "origin"]);
    // Every origin read here is one the vault would keep as it is.
    for (const r of reads) if (r.kind === "origin") expect(isOrigin(r.origin)).toBe(true);
  });

  it("says under each field what the vault would not keep, as it is typed, and says nothing of a field still empty", () => {
    const p = adding({ site: "x".repeat(81), addresses: ["http://seller.shopee.co.th", "https://fon:pw@seller.shopee.co.th", "seller", "https://a.example", "https://a.example/"], username: "fon\u0007" });
    const said = words(vault(p));
    for (const line of [
      "A site's name is 1 to 80 letters.",
      "Only addresses that start with https:// work.",
      "Leave the account's name and password out of the address: each has a field of its own.",
      "Paste the whole address from your browser, starting with https://.",
      "This address is already in the list.",
      "The account's name is 1 to 256 characters.",
    ]) {
      expect(said).toContain(line);
    }
    // An address that holds an account is never said back.
    expect(said).not.toContain("fon:pw");
    // The site's part a page's own address is cut to is said, so the owner sees that it is what counts.
    expect(words(vault(adding({ addresses: ["https://Track.Carrier.example/parcels?id=1"] })))).toContain("Kept as https://track.carrier.example");
    expect(words(vault(adding({ addresses: ["https://track.carrier.example"] })))).not.toContain("Kept as");
    const box = VaultPane({ p });
    expect(byTestId(box, "add-address").map((e) => e.props["aria-invalid"])).toEqual([true, true, true, undefined, true]);
    expect([byTestId(box, "add-site")[0]?.props["aria-invalid"], byTestId(box, "add-username")[0]?.props["aria-invalid"]]).toEqual([true, true]);
    expect(byTestId(box, "add-save")[0]?.props.disabled).toBe(true);
    expect(words(vault(adding({})))).not.toMatch(/Only addresses|Paste the whole|1 to 80|1 to 256|Kept as/);
  });

  it("is ready once the vault would take it: the name trimmed, each address's site, the account's name without a paste's spaces, someone ticked", () => {
    expect(addFields({ ...READY, members: [] })).toBeNull();
    expect(addFields({ ...READY, site: "  " })).toBeNull();
    expect(addFields({ ...READY, addresses: [""] })).toBeNull();
    expect(addFields({ ...READY, addresses: ["https://track.carrier.example", "http://track.carrier.example"] })).toBeNull();
    expect(addFields({ ...READY, password: "" })).toBeNull();
    expect(addFields({ ...READY, username: "   " })).toBeNull();
    expect(addFields({ ...READY, site: " Carrier portal ", addresses: ["https://track.carrier.example/parcels", "", "https://login.carrier.example"] })).toEqual({
      site: "Carrier portal",
      origins: ["https://track.carrier.example", "https://login.carrier.example"],
      username: "baan.mali",
      password: PASSWORD,
      members: ["nam"],
    });
    // A password is kept exactly as typed, spaces and all, up to what the vault takes.
    expect(addFields({ ...READY, password: ` ${PASSWORD} ` })?.password).toBe(` ${PASSWORD} `);
    expect(addFields({ ...READY, password: "x".repeat(1025) })).toBeNull();
    expect(addFields({ ...READY, site: "ร้าน".repeat(20) })?.site).toBe("ร้าน".repeat(20));
    expect(byTestId(VaultPane({ p: adding(READY) }), "add-save")[0]?.props.disabled).toBe(false);
  });

  it("adds and removes address fields, up to five and never none, and keeps the members ticked in the team's order", () => {
    let s = reduce({ type: "add" }, { type: "address", index: 0, text: "https://a.example" });
    for (let i = 0; i < 6; i++) s = connReduce(s, { type: "addressMore" });
    expect(s.ask?.kind === "add" && s.ask.draft.addresses).toEqual(["https://a.example", "", "", "", ""]);
    expect(byTestId(VaultPane({ p: props({ ui: s }) }), "add-address-more")).toEqual([]);
    s = connReduce(connReduce(s, { type: "address", index: 2, text: "https://c.example" }), { type: "addressLess", index: 1 });
    expect(s.ask?.kind === "add" && s.ask.draft.addresses).toEqual(["https://a.example", "https://c.example", "", ""]);
    const one = reduce({ type: "add" }, { type: "addressLess", index: 0 }, { type: "address", index: 3, text: "https://nowhere.example" });
    expect(one.ask?.kind === "add" && one.ask.draft.addresses).toEqual([""]);
    expect(byTestId(VaultPane({ p: props({ ui: one }) }), "add-address-remove")).toEqual([]);
    const ticked = reduce({ type: "add" }, { type: "member", member: "kit" }, { type: "member", member: "nam" }, { type: "member", member: "buddy" }, { type: "member", member: "ton" }, { type: "member", member: "kit" });
    expect(ticked.ask?.kind === "add" && ticked.ask.draft.members).toEqual(["nam", "ton"]);
  });

  it("sends each field's, address's and box's change through the page's own actions, saves only when ready, and cancels on Escape", () => {
    const dispatch = vi.fn();
    const onSave = vi.fn();
    const box = () => VaultPane({ p: adding({ ...READY, addresses: ["https://a.example", ""] }, { dispatch, onSave }) });
    (byTestId(box(), "add-site")[0]?.props.onChange as Change)({ target: { value: "Carrier" } });
    (byTestId(box(), "add-username")[0]?.props.onChange as Change)({ target: { value: "fon" } });
    (byTestId(box(), "add-password")[0]?.props.onChange as Change)({ target: { value: "pw" } });
    (byTestId(box(), "add-address")[1]?.props.onChange as Change)({ target: { value: "https://b.example" } });
    (byTestId(box(), "add-address-remove")[0]?.props.onClick as () => void)();
    (byTestId(box(), "add-address-more")[0]?.props.onClick as () => void)();
    (byTestId(box(), "member-pim")[0]?.props.onChange as () => void)();
    expect(dispatch.mock.calls.map(([a]) => a)).toEqual([
      { type: "field", field: "site", text: "Carrier" },
      { type: "field", field: "username", text: "fon" },
      { type: "field", field: "password", text: "pw" },
      { type: "address", index: 1, text: "https://b.example" },
      { type: "addressLess", index: 0 },
      { type: "addressMore" },
      { type: "member", member: "pim" },
    ]);
    submit(byTestId(box(), "add-form")[0]);
    expect(onSave).toHaveBeenCalledTimes(1);
    escape(byTestId(box(), "add-form")[0]);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "cancel" });
    // Enter in a form that is not ready saves nothing.
    submit(byTestId(VaultPane({ p: adding({ site: "Carrier portal" }, { onSave }) }), "add-form")[0]);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps no password once Add is pressed: not in the page's state, the lists or its words, and not put back after a refusal", async () => {
    const typing = reduce(
      { type: "add" },
      { type: "field", field: "site", text: "Carrier portal" },
      { type: "address", index: 0, text: "https://track.carrier.example" },
      { type: "field", field: "username", text: "baan.mali" },
      { type: "field", field: "password", text: PASSWORD },
      { type: "member", member: "nam" },
    );
    expect(JSON.stringify(typing)).toContain(PASSWORD);
    // The field's value is drawn as the browser keeps a password field's: never as words on the page.
    expect(words(vault(props({ ui: typing })))).not.toContain(PASSWORD);
    const sending = connReduce(typing, { type: "begin" });
    expect(sending).toEqual({
      ask: { kind: "add", draft: { site: "Carrier portal", addresses: ["https://track.carrier.example"], username: "baan.mali", password: "", members: ["nam"] } },
      busy: true,
      at: "vault",
      error: null,
      notice: null,
    });
    // Nothing collects in the form while it is on its way.
    for (const a of [{ type: "field", field: "password", text: PASSWORD }, { type: "member", member: "kit" }, { type: "addressMore" }, { type: "cancel" }] as ConnAction[]) {
      expect(connReduce(sending, a)).toBe(sending);
    }
    const refused = connReduce(sending, { type: "failed", message: t("conn.err.again"), close: false });
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
    expect(refused.ask?.kind === "add" && refused.ask.draft).toMatchObject({ site: "Carrier portal", password: "" });
    expect(connReduce(sending, { type: "done", notice: "Added." }).ask).toBeNull();

    // The change goes once, to the shop the rows were read for, and what comes back holds none of it.
    const sent: unknown[][] = [];
    const made = signIn({ id: "signin-new", site: "Carrier portal", members: ["nam"], lastUsedAt: null, lastUsedBy: null, createdAt: NOW / 1000, passwordSetAt: NOW / 1000 });
    const calls: ConnectionsCalls = {
      ...noCalls,
      add: async (...args) => {
        sent.push(args);
        return { signIn: made };
      },
    };
    const fields = addFields({ site: "Carrier portal", addresses: ["https://track.carrier.example"], username: "baan.mali", password: PASSWORD, members: ["nam"] })!;
    const step = await connectionsDo(calls, DATA, { what: "add", fields });
    expect(sent).toEqual([["pilot:baan-mali", { site: "Carrier portal", origins: ["https://track.carrier.example"], username: "baan.mali", password: PASSWORD, members: ["nam"] }]]);
    expect(step.data.signIns.map((s) => s.id)).toEqual(["signin-shopee", "signin-carrier", "signin-new"]);
    expect(step.action).toEqual({ type: "done", notice: "Added Carrier portal to the vault. Nam may use it from now on." });
    expect(JSON.stringify(step)).not.toContain(PASSWORD);
    // A runtime whose refusal repeated it would still not get it on the page.
    const echoing: ConnectionsCalls = { ...noCalls, add: () => Promise.reject({ code: "refused", message: `could not add ${PASSWORD}` }) };
    expect((await connectionsDo(echoing, DATA, { what: "add", fields })).action).toEqual({ type: "failed", message: "That did not work. Try again.", close: false });
  });

  it("says each of the vault's refusals in the owner's words, and closes the question for a full vault", async () => {
    const fields = addFields(READY)!;
    const said = async (code: string) =>
      (await connectionsDo({ ...noCalls, add: () => Promise.reject({ code, message: "runtime words" }) }, DATA, { what: "add", fields })).action;
    const failed = (message: string, close = false) => ({ type: "failed", message, close });
    expect(await said("invalid_site")).toEqual(failed("A site's name is 1 to 80 letters."));
    expect(await said("invalid_origins")).toEqual(failed("Add 1 to 5 of the site's own addresses, each starting with https://."));
    expect(await said("invalid_username")).toEqual(failed("The account's name is 1 to 256 characters."));
    expect(await said("invalid_password")).toEqual(failed("A password is 1 to 1024 characters."));
    expect(await said("invalid_members")).toEqual(failed("Choose who may use it: one or more of Nam, Pim, Ton and Kit."));
    expect(await said("vault_not_configured")).toEqual(failed("The vault is not ready yet, so nothing was saved. Ask your operator to set it up."));
    expect(await said("not_saved")).toEqual(failed("runtime words"));
    expect(await said("owner_only")).toEqual(failed("Only the shop's owner sees and changes its sign-ins and outposts."));
    expect(await said("too_many_sign_ins")).toEqual(failed("Your shop already has 50 sign-ins, the most the vault keeps. Ask your operator to remove one.", true));
  });
});

describe("Who uses it", () => {
  it("opens in the sign-in's row with who may use it now ticked, and saves only a change with someone ticked", () => {
    const dispatch = vi.fn();
    (byTestId(VaultPane({ p: props({ dispatch }) }), "signin-who")[0]?.props.onClick as () => void)();
    expect(dispatch).toHaveBeenCalledWith({ type: "who", signIn: "signin-shopee", members: ["nam", "ton"] });
    const open = reduce({ type: "who", signIn: "signin-shopee", members: ["ton", "nam"] });
    expect(open.ask).toEqual({ kind: "members", signIn: "signin-shopee", members: ["nam", "ton"] });
    expect(words(vault(props({ ui: open })))).toContain("Who may use Shopee Seller Centre Nam Pim Ton Kit Only the members you tick may use it. One you take off stops at once. Save Cancel");
    const box = (ui: ConnUi) => VaultPane({ p: props({ ui }) });
    expect(SIGN_IN_MEMBERS.map((m) => byTestId(box(open), `member-${m}`)[0]?.props.checked)).toEqual([true, false, true, false]);
    // Only this row's question is open: its own links give way to it, and the other row's and Add a sign-in wait.
    expect(byTestId(box(open), "members-form")).toHaveLength(1);
    expect([...byTestId(box(open), "signin-change"), ...byTestId(box(open), "signin-who"), ...byTestId(box(open), "signin-add")].map((e) => e.props.disabled)).toEqual([true, true, true]);
    // Unchanged, or nobody ticked, it does not save.
    expect(byTestId(box(open), "members-save")[0]?.props.disabled).toBe(true);
    const nobody = reduce({ type: "who", signIn: "signin-shopee", members: ["nam", "ton"] }, { type: "member", member: "nam" }, { type: "member", member: "ton" });
    expect(byTestId(box(nobody), "members-save")[0]?.props.disabled).toBe(true);
    const more = connReduce(open, { type: "member", member: "kit" });
    expect(more.ask).toEqual({ kind: "members", signIn: "signin-shopee", members: ["nam", "ton", "kit"] });
    expect(byTestId(box(more), "members-save")[0]?.props.disabled).toBe(false);
    expect(membersReady(["ton", "nam"], ["nam", "ton"])).toBe(false);
    expect(membersReady(["nam"], ["nam", "ton"])).toBe(true);
    expect(membersReady(["nam", "pim"], ["nam", "ton"])).toBe(true);
    expect(membersReady([], ["nam"])).toBe(false);
    expect(membersReady(["buddy"], ["nam"])).toBe(false);
  });

  it("ticks through the page's own actions, saves only when ready, and cancels on Escape", () => {
    const dispatch = vi.fn();
    const onSave = vi.fn();
    const ui = reduce({ type: "who", signIn: "signin-carrier", members: ["nam"] }, { type: "member", member: "pim" });
    const box = () => VaultPane({ p: props({ ui, dispatch, onSave }) });
    (byTestId(box(), "member-ton")[0]?.props.onChange as () => void)();
    expect(dispatch).toHaveBeenLastCalledWith({ type: "member", member: "ton" });
    submit(byTestId(box(), "members-form")[0]);
    expect(onSave).toHaveBeenCalledTimes(1);
    escape(byTestId(box(), "members-form")[0]);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "cancel" });
    submit(byTestId(VaultPane({ p: props({ ui: reduce({ type: "who", signIn: "signin-carrier", members: ["nam"] }), onSave }) }), "members-form")[0]);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("sends who to the shop its row was read for, puts the answer in its place, and drops a row the shop no longer has", async () => {
    const sent: unknown[][] = [];
    const calls: ConnectionsCalls = {
      ...noCalls,
      members: async (...args) => {
        sent.push(args);
        return { signIn: signIn({ members: ["nam", "kit"] }) };
      },
    };
    const step = await connectionsDo(calls, DATA, { what: "members", signIn: "signin-shopee", members: ["nam", "kit"] });
    expect(sent).toEqual([["pilot:baan-mali", "signin-shopee", ["nam", "kit"]]]);
    expect(step.data.signIns.map((s) => [s.id, s.members])).toEqual([["signin-shopee", ["nam", "kit"]], ["signin-carrier", ["nam"]]]);
    expect(step.action).toEqual({ type: "done", notice: "Saved. Nam and Kit may use Shopee Seller Centre from now on." });
    const refusing = (code: string): ConnectionsCalls => ({ ...noCalls, members: () => Promise.reject({ code, message: "runtime words" }) });
    const gone = await connectionsDo(refusing("sign_in_not_found"), DATA, { what: "members", signIn: "signin-carrier", members: ["pim"] });
    expect(gone.action).toEqual({ type: "failed", message: "That sign-in is no longer in the vault.", close: true });
    expect(gone.data.signIns.map((s) => s.id)).toEqual(["signin-shopee"]);
    const invalid = await connectionsDo(refusing("invalid_members"), DATA, { what: "members", signIn: "signin-carrier", members: ["pim"] });
    expect(invalid).toEqual({ data: DATA, action: { type: "failed", message: "Choose who may use it: one or more of Nam, Pim, Ton and Kit.", close: false } });
  });
});

describe("Add a sign-in and Who uses it in every language", () => {
  it("have their words in ko, ja and zh, never the English, and name the members the same", () => {
    const drawn = (ui: ConnUi) => words(vault(props({ ui })));
    const asks = [reduce({ type: "add" }, { type: "address", index: 0, text: "http://track.carrier.example" }), reduce({ type: "who", signIn: "signin-shopee", members: ["nam"] })];
    const english = asks.map(drawn);
    for (const lang of LANGS.filter((l) => l !== "en")) {
      setLang(lang);
      asks.forEach((ui, i) => {
        expect(drawn(ui), `${lang} ${i}`).not.toBe(english[i]);
        expect(drawn(ui), `${lang} ${i}`).toMatch(/Nam.*Pim.*Ton.*Kit/);
      });
      expect(drawn(asks[0]!)).toContain(t("vault.add.notHttps"));
      expect(drawn(asks[0]!)).not.toContain("Only addresses that start with https://");
    }
  });
});

// ---- Change, grown to a sign-in's account and addresses, and Remove -----------------------------------------------------

const shopee = signIn();
/** Change open on the Shopee row with `draft` typed into it. */
const changing = (draft: Partial<ChangeDraft>, over: Partial<ConnectionsProps> = {}) =>
  props({ ui: { ...CONN_START, ask: { kind: "change", signIn: "signin-shopee", draft: { ...changeStart(shopee), ...draft } }, at: "vault" }, ...over });
/** A page's address on a host the sign-in was not given for. */
const NEW_ADDRESS = "https://seller-centre.shopee.co.th/portal/sale?type=toship";

describe("Change, with the sign-in's account and addresses", () => {
  it("opens with the account and addresses as the vault has them, no password, and Save waiting for something new", () => {
    const opened = reduce({ type: "change", signIn: "signin-shopee", username: shopee.username, origins: shopee.origins });
    expect(opened.ask).toEqual({ kind: "change", signIn: "signin-shopee", draft: { username: "baan.mali@example.com", addresses: shopee.origins, password: "" } });
    const box = VaultPane({ p: props({ ui: opened }) });
    expect(byTestId(box, "change-username")[0]?.props).toMatchObject({ type: "text", value: "baan.mali@example.com", spellCheck: false });
    expect(byTestId(box, "change-address").map((e) => e.props.value)).toEqual(shopee.origins);
    expect(byTestId(box, "change-save")[0]?.props.disabled).toBe(true);
    expect(changeTodo(shopee, changeStart(shopee))).toBeNull();
    const said = words(vault(props({ ui: opened })));
    for (const line of ["Password for Shopee Seller Centre", "The account's name on the site", "Its address", "Add another address of this site"]) {
      expect(said).toContain(line);
    }
  });

  it("waits for the password typed again before saving a new address or another account, and says so under it", () => {
    for (const draft of [
      { addresses: [...shopee.origins, NEW_ADDRESS] },
      { addresses: [NEW_ADDRESS] },
      { addresses: [shopee.origins[0]!, NEW_ADDRESS] },
      { username: "orders@baanmali.example" },
      { username: "orders@baanmali.example", addresses: [shopee.origins[0]!] },
    ]) {
      const p = changing(draft);
      expect(byTestId(VaultPane({ p }), "change-save")[0]?.props.disabled, JSON.stringify(draft)).toBe(true);
      expect(byTestId(VaultPane({ p }), "change-password-help")[0]?.props.className, JSON.stringify(draft)).toBe("help err");
      expect(words(vault(p))).toContain("A new account or a new address needs the password typed here too");
      expect(passwordNeeded(shopee, { ...changeStart(shopee), ...draft })).toBe(true);
      expect(changeTodo(shopee, { ...changeStart(shopee), ...draft })).toBeNull();
      // With the password typed again, it is a change of the account and addresses that carries it.
      expect(changeTodo(shopee, { ...changeStart(shopee), ...draft, password: PASSWORD })).toMatchObject({ what: "change", signIn: "signin-shopee",
        change: { password: PASSWORD } });
      expect(byTestId(VaultPane({ p: changing({ ...draft, password: PASSWORD }) }), "change-save")[0]?.props.disabled).toBe(false);
    }
    expect(changeTodo(shopee, { ...changeStart(shopee), addresses: [NEW_ADDRESS], password: PASSWORD })).toEqual({ what: "change", signIn: "signin-shopee",
      change: { origins: ["https://seller-centre.shopee.co.th"], username: "baan.mali@example.com", password: PASSWORD } });
  });

  it("takes addresses away with no password, keeping at least one", () => {
    const narrowed = { ...changeStart(shopee), addresses: [shopee.origins[1]!] };
    expect(passwordNeeded(shopee, narrowed)).toBe(false);
    expect(changeTodo(shopee, narrowed)).toEqual({ what: "change", signIn: "signin-shopee",
      change: { origins: [shopee.origins[1]], username: shopee.username, password: null } });
    const p = changing({ addresses: [shopee.origins[1]!] });
    expect(byTestId(VaultPane({ p }), "change-save")[0]?.props.disabled).toBe(false);
    expect(byTestId(VaultPane({ p }), "change-password-help")[0]?.props.className).toBe("help");
    // An emptied field is left out, and no address at all is no sign-in, with a password or without.
    expect(changeTodo(shopee, { ...changeStart(shopee), addresses: ["", shopee.origins[0]!] })).toMatchObject({ change: { origins: [shopee.origins[0]], password: null } });
    expect(changeTodo(shopee, { ...changeStart(shopee), addresses: [""] })).toBeNull();
    expect(changeTodo(shopee, { ...changeStart(shopee), addresses: [""], password: PASSWORD })).toBeNull();
  });

  it("sends a new password alone as one, with the account and addresses as they were", () => {
    expect(changeTodo(shopee, { ...changeStart(shopee), password: PASSWORD })).toEqual({ what: "password", signIn: "signin-shopee", password: PASSWORD });
    // The same addresses in another order, or a paste's spaces at the account's ends, are no change to them.
    expect(changeTodo(shopee, { addresses: [...shopee.origins].reverse(), username: ` ${shopee.username} `, password: PASSWORD }))
      .toEqual({ what: "password", signIn: "signin-shopee", password: PASSWORD });
    expect(changeTodo(shopee, { ...changeStart(shopee), password: "x".repeat(1025) })).toBeNull();
  });

  it("reads the account without a paste's spaces, and keeps one the vault holds with a space at an end", () => {
    expect(changedUsername(shopee, { username: "  orders@baanmali.example " })).toBe("orders@baanmali.example");
    const spaced = signIn({ username: "baan.mali " });
    expect(changedUsername(spaced, { username: "baan.mali" })).toBe("baan.mali ");
    expect(changeTodo(spaced, { ...changeStart(spaced), username: "baan.mali" })).toBeNull();
  });

  it("says under each field what the vault would not keep, and saves nothing while one is wrong", () => {
    const p = changing({ username: "fon\u0007", addresses: ["http://seller.shopee.co.th", "https://fon:pw@seller.shopee.co.th", shopee.origins[0]!], password: PASSWORD });
    const said = words(vault(p));
    for (const line of ["The account's name is 1 to 256 characters.", "Only addresses that start with https:// work.",
      "Leave the account's name and password out of the address: each has a field of its own."]) {
      expect(said).toContain(line);
    }
    expect(said).not.toContain("fon:pw");
    expect(byTestId(VaultPane({ p }), "change-save")[0]?.props.disabled).toBe(true);
    expect(words(vault(changing({ addresses: [NEW_ADDRESS] })))).toContain("Kept as https://seller-centre.shopee.co.th");
  });

  it("changes its fields through the page's own actions, as Add a sign-in's change, and keeps no password once Save is pressed", () => {
    const dispatch = vi.fn();
    const box = () => VaultPane({ p: changing({}, { dispatch }) });
    (byTestId(box(), "change-username")[0]?.props.onChange as Change)({ target: { value: "orders@baanmali.example" } });
    (byTestId(box(), "password-input")[0]?.props.onChange as Change)({ target: { value: "pw" } });
    (byTestId(box(), "change-address")[1]?.props.onChange as Change)({ target: { value: NEW_ADDRESS } });
    (byTestId(box(), "change-address-remove")[0]?.props.onClick as () => void)();
    (byTestId(box(), "change-address-more")[0]?.props.onClick as () => void)();
    expect(dispatch.mock.calls.map(([a]) => a)).toEqual([
      { type: "field", field: "username", text: "orders@baanmali.example" },
      { type: "field", field: "password", text: "pw" },
      { type: "address", index: 1, text: NEW_ADDRESS },
      { type: "addressLess", index: 0 },
      { type: "addressMore" },
    ]);
    let s = reduce({ type: "change", signIn: "signin-shopee", username: shopee.username, origins: shopee.origins });
    for (const a of dispatch.mock.calls.map(([a]) => a as ConnAction)) s = connReduce(s, a);
    // The site's name is Add a sign-in's alone.
    s = connReduce(s, { type: "field", field: "site", text: "Lazada" });
    expect(s.ask).toEqual({ kind: "change", signIn: "signin-shopee", draft: { username: "orders@baanmali.example", addresses: [NEW_ADDRESS, ""], password: "pw" } });
    const sending = connReduce(connReduce(s, { type: "field", field: "password", text: PASSWORD }), { type: "begin" });
    expect(JSON.stringify(sending)).not.toContain(PASSWORD);
    expect(sending.ask).toEqual({ kind: "change", signIn: "signin-shopee", draft: { username: "orders@baanmali.example", addresses: [NEW_ADDRESS, ""], password: "" } });
  });

  it("sends the change once, to the shop its row was read for, and says what it did", async () => {
    const sent: unknown[][] = [];
    const moved = signIn({ origins: ["https://seller-centre.shopee.co.th"], passwordSetAt: NOW / 1000 });
    const calls: ConnectionsCalls = {
      ...noCalls,
      change: async (...args) => {
        sent.push(args);
        return { signIn: moved };
      },
    };
    const change = { origins: ["https://seller-centre.shopee.co.th"], username: shopee.username, password: PASSWORD };
    const done = await connectionsDo(calls, DATA, { what: "change", signIn: "signin-shopee", change });
    expect(sent).toEqual([["pilot:baan-mali", "signin-shopee", change]]);
    expect(done.data.signIns[0]).toEqual(moved);
    expect(done.action).toEqual({ type: "done", notice: "Saved. The vault signs in to Shopee Seller Centre with this account and these addresses from now on." });
    expect(JSON.stringify(done)).not.toContain(PASSWORD);
    const narrowed = await connectionsDo({ ...calls, change: async () => ({ signIn: shopee }) }, DATA,
      { what: "change", signIn: "signin-shopee", change: { ...change, origins: [shopee.origins[0]!], password: null } });
    expect(narrowed.action).toEqual({ type: "done", notice: "Saved. The vault no longer types the password for Shopee Seller Centre at the addresses you took away." });
    // The vault's refusals, in the owner's words; a runtime that repeats the password gets it on no page; a sign-in gone is
    // dropped.
    const refusing = (code: string, message = "runtime words"): ConnectionsCalls => ({ ...noCalls, change: () => Promise.reject({ code, message }) });
    const todo = { what: "change" as const, signIn: "signin-shopee", change };
    expect((await connectionsDo(refusing("password_required"), DATA, todo)).action).toEqual({ type: "failed",
      message: "Type the password again: a new account or a new address needs it, so the vault never types the saved one somewhere new.", close: false });
    expect((await connectionsDo(refusing("no_change"), DATA, todo)).action).toEqual({ type: "failed",
      message: "Nothing changed: that is the account and the addresses it has now.", close: false });
    expect((await connectionsDo(refusing("refused", `kept ${PASSWORD}`), DATA, todo)).action).toEqual({ type: "failed", message: "That did not work. Try again.", close: false });
    const gone = await connectionsDo(refusing("sign_in_not_found"), DATA, todo);
    expect(gone).toEqual({ data: { ...DATA, signIns: [carrier] }, action: { type: "failed", message: "That sign-in is no longer in the vault.", close: true } });
  });
});

describe("Removing a sign-in", () => {
  it("asks first in the row, naming the site and the account, that the team can no longer sign in there and that it cannot be undone", () => {
    const dispatch = vi.fn();
    (byTestId(VaultPane({ p: props({ dispatch }) }), "signin-remove")[1]?.props.onClick as () => void)();
    expect(dispatch).toHaveBeenCalledWith({ type: "removeSignIn", signIn: "signin-carrier" });
    const asking = reduce({ type: "removeSignIn", signIn: "signin-carrier" });
    expect(asking).toEqual({ ...CONN_START, ask: { kind: "removeSignIn", signIn: "signin-carrier" }, at: "vault" });
    const onRemove = vi.fn();
    const p = props({ ui: asking, onRemove, dispatch });
    expect(words(vault(p))).toContain(
      "Carrier portal Remove the sign-in to Carrier portal as baanmali? Your team can no longer sign in there. " +
        "This cannot be undone: to use it again, add it again with its password. Remove Keep",
    );
    const box = VaultPane({ p });
    const [yes, keep] = [byTestId(box, "signin-remove-yes")[0], byTestId(box, "signin-remove-keep")[0]];
    // The safe answer holds the focus, and the question's buttons are new elements, so it takes it as they appear.
    expect(keep?.props.autoFocus).toBe(true);
    expect([yes?.key, keep?.key]).toEqual(["remove-yes", "remove-keep"]);
    // Nothing else can be asked meanwhile, and nothing is removed until the owner says so.
    expect([...byTestId(box, "signin-change"), ...byTestId(box, "signin-who"), ...byTestId(box, "signin-remove"), ...byTestId(box, "signin-add")]
      .map((e) => e.props.disabled)).toEqual([true, true, true, true]);
    expect(onRemove).not.toHaveBeenCalled();
    (keep?.props.onClick as () => void)();
    expect(dispatch).toHaveBeenLastCalledWith({ type: "cancel" });
    (yes?.props.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("removes it from the shop its row was read for, says so, and drops a row already gone", async () => {
    const sent: unknown[][] = [];
    const calls: ConnectionsCalls = {
      ...noCalls,
      removeSignIn: async (...args) => {
        sent.push(args);
        return { signIn: "signin-carrier" };
      },
    };
    const done = await connectionsDo(calls, DATA, { what: "removeSignIn", signIn: "signin-carrier" });
    expect(sent).toEqual([["pilot:baan-mali", "signin-carrier"]]);
    expect(done).toEqual({ data: { ...DATA, signIns: [shopee] }, action: { type: "done", notice: "Removed Carrier portal. Your team can no longer sign in there." } });
    const refusing = (code: string): ConnectionsCalls => ({ ...noCalls, removeSignIn: () => Promise.reject({ code, message: "runtime words" }) });
    const gone = await connectionsDo(refusing("sign_in_not_found"), DATA, { what: "removeSignIn", signIn: "signin-carrier" });
    expect(gone).toEqual({ data: { ...DATA, signIns: [shopee] }, action: { type: "failed", message: "That sign-in is no longer in the vault.", close: true } });
    const helper = await connectionsDo(refusing("owner_only"), DATA, { what: "removeSignIn", signIn: "signin-carrier" });
    expect(helper).toEqual({ data: DATA, action: { type: "failed", message: "Only the shop's owner sees and changes its sign-ins and outposts.", close: false } });
  });
});

describe("Change and Remove in every language", () => {
  it("have their words in ko, ja and zh, never the English, and name the site and the account as they are", () => {
    const drawn = (ui: ConnUi) => words(vault(props({ ui })));
    const asks = [
      { ...CONN_START, ask: { kind: "change" as const, signIn: "signin-shopee", draft: { ...changeStart(shopee), addresses: [NEW_ADDRESS] } }, at: "vault" as const },
      reduce({ type: "removeSignIn", signIn: "signin-carrier" }),
    ];
    const english = asks.map(drawn);
    for (const lang of LANGS.filter((l) => l !== "en")) {
      setLang(lang);
      asks.forEach((ui, i) => expect(drawn(ui), `${lang} ${i}`).not.toBe(english[i]));
      expect(drawn(asks[0]!)).toContain(t("vault.change.again"));
      expect(drawn(asks[1]!)).toContain(t("vault.removeAsk", { site: "Carrier portal", account: "baanmali" }));
      expect(drawn(asks[1]!)).toMatch(/Carrier portal.*baanmali|baanmali.*Carrier portal/);
    }
  });
});
