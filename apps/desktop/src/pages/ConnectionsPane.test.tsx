// Customize › Connections for the shop's owner (connections.ts, ConnectionsPane.tsx): the canvas's Vault box and every outpost
// of the shop, drawn with react-dom/server in each state the boards draw, the in-place questions (Change, Rename, Remove), and
// above all that the password the owner types leaves the page's state the moment Save is pressed and is shown nowhere. The
// views use no hooks, so a test calls them as plain functions to read the handlers a string render leaves out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import type { ShopConnections, ShopOutpost, VaultSignIn } from "../runtime/connections";
import { CustomizeView, type MemoryPaneProps, type RoutinesPaneProps } from "./CustomizePage";
import {
  addedLine,
  CONN_START,
  connectionsDo,
  connReduce,
  memberName,
  nameReady,
  outpostLine,
  passwordReady,
  signInLine,
  type ConnAction,
  type ConnectionsCalls,
  type ConnUi,
} from "./connections";
import { ShopOutpostsPane, VaultPane, type ConnectionsProps } from "./ConnectionsPane";
import { LOADING } from "./load";
import { MEMORY_START } from "./memory";
import { outpostRow } from "./outpost";
import { ROUTINES_START } from "./routines";

/** 24 November 2026, 10:00 on this computer's clock. */
const NOW = new Date(2026, 10, 24, 10, 0).getTime();
const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).getTime() / 1000;
// Made up for this file, and never a real password.
const PASSWORD = "typed-pw-c0ffee-91";

const signIn = (over: Partial<VaultSignIn> = {}): VaultSignIn => ({
  id: "signin-shopee",
  site: "Shopee Seller Centre",
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
const carrier = signIn({ id: "signin-carrier", site: "Carrier portal", members: ["nam"], state: "broken", brokenAt: at(24, 9, 2), brokenBy: "nam" });
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
  it("draws the canvas's box: each sign-in, who may use it, whether it works, when it was added, and its Change", () => {
    const html = vault(props());
    expect(words(html)).toBe(
      "Vault Passwords are hidden from AI Sign-ins your team may use. The vault types the password in. The AI never sees it. " +
        "Shopee Seller Centre Used by Nam and Ton, last today 09:02 Added 3 November Working Change " +
        "Carrier portal The site refused the saved password today at 09:02. Added 3 November Needs a new password Change",
    );
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
    expect(words(vault(props({ state: { kind: "ready", value: { ...DATA, signIns: [] } } })))).toContain("No sign-ins yet. Your operator adds them for now.");
    // Until the vault is read, nothing about the shop's outposts is drawn: the Vault box says why.
    expect(outposts(props({ state: LOADING }))).toBe("");
  });

  it("opens a password field in the row on Change, which saves only what was typed and cancels on Escape", () => {
    const dispatch = vi.fn();
    const change = byTestId(VaultPane({ p: props({ dispatch }) }), "signin-change")[1];
    (change?.props.onClick as () => void)();
    expect(dispatch).toHaveBeenCalledWith({ type: "change", signIn: "signin-carrier" });

    const onSave = vi.fn();
    const empty = props({ ui: reduce({ type: "change", signIn: "signin-carrier" }), dispatch, onSave });
    const field = byTestId(VaultPane({ p: empty }), "password-input")[0];
    expect(field?.props).toMatchObject({ type: "password", value: "", autoComplete: "new-password", spellCheck: false, maxLength: 1024 });
    expect(byTestId(VaultPane({ p: empty }), "password-save")[0]?.props.disabled).toBe(true);
    expect(words(vault(empty))).toContain("New password for Carrier portal");
    // Nothing else can be asked while the question is open.
    expect(byTestId(VaultPane({ p: empty }), "signin-change").map((e) => e.props.disabled)).toEqual([true]);

    const typed = props({ ui: reduce({ type: "change", signIn: "signin-carrier" }, { type: "draft", text: PASSWORD }), dispatch, onSave });
    const form = byTestId(VaultPane({ p: typed }), "password-form")[0];
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
    const typing = reduce({ type: "change", signIn: "signin-carrier" }, { type: "draft", text: PASSWORD });
    expect(typing.ask).toEqual({ kind: "password", signIn: "signin-carrier", draft: PASSWORD });
    const sending = connReduce(typing, { type: "begin" });
    expect(sending).toEqual({ ask: { kind: "password", signIn: "signin-carrier", draft: "" }, busy: true, at: "vault", error: null, notice: null });
    expect(JSON.stringify(sending)).not.toContain(PASSWORD);
    // Typing is refused while it is on its way, so nothing new collects in the field.
    expect(connReduce(sending, { type: "draft", text: PASSWORD })).toBe(sending);
    const refused = connReduce(sending, { type: "failed", message: t("conn.err.again"), close: false });
    expect(refused.ask).toEqual({ kind: "password", signIn: "signin-carrier", draft: "" });
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
    const saved = connReduce(sending, { type: "done", notice: t("vault.saved") });
    expect(saved).toEqual({ ask: null, busy: false, at: "vault", error: null, notice: "Saved. The vault types the new password from now on." });
  });

  it("is sent once, for the shop its row was read for, and comes back in no word the page shows", async () => {
    const sent: unknown[][] = [];
    const calls: ConnectionsCalls = {
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
      password: () => Promise.reject({ code, message }),
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
    expect(connReduce(busy, { type: "change", signIn: "signin-shopee" })).toBe(busy);
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
  const routines: RoutinesPaneProps = { state: LOADING, ui: ROUTINES_START, nowMs: 0, dispatch: () => {}, onAdd: () => {}, onSwitch: () => {} };
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
