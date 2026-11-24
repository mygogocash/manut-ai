// Settings › Developer › Make your shop, drawn with react-dom/server from a given state (MakeShop.tsx), its handlers read
// without a DOM as EmailSignIn.test.tsx reads its own (the view uses no hooks, so it can be called as a plain function and its
// elements walked), and where the page offers it.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { makeNoticeWords, makeShopOffer, MakeShopView, type MakeShopViewProps } from "./MakeShop";
import { MAKE_START, SHOP_KINDS, type MakeShopState } from "./makeShopFlow";

const words = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const tag = (html: string, id: string) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

function props(state: Partial<MakeShopState> = {}, over: Partial<MakeShopViewProps> = {}): MakeShopViewProps {
  return { state: { ...MAKE_START, ...state }, practice: false, onName: vi.fn(), onOwnerName: vi.fn(), onKind: vi.fn(), onMake: vi.fn(), ...over };
}

function draw(state: Partial<MakeShopState> = {}, over: Partial<MakeShopViewProps> = {}) {
  setLang("en");
  return renderToString(<MakeShopView {...props(state, over)} />);
}

/** Every element a view draws, with its own components expanded. */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}

function byId(p: MakeShopViewProps, id: string) {
  const found = drawn(MakeShopView(p)).filter((e) => e.props["data-testid"] === id);
  expect(found, id).toHaveLength(1);
  return found[0]!;
}

afterEach(() => setLang("en"));

describe("the form", () => {
  it("asks for the shop's name, the person's own and the kind of shop, the three templates by name and None of these", () => {
    const html = draw();
    expect(words(html)).toContain("You're signed in and not in a shop yet. Make yours here: you're its owner from the start.");
    expect(words(html)).toContain("Shop name Customers see this name in replies.");
    expect(words(html)).toContain("Your name The name your shop knows you by.");
    for (const name of ["Handmade and gifts", "Clothes and accessories", "Packaged food and drinks", "None of these"]) {
      expect(words(html)).toContain(name);
    }
    expect(words(html)).toContain("Candles, soap, crafts and gift sets.");
    expect(tag(html, "make-submit")).not.toContain("disabled");
    expect(words(html)).toContain("Make my shop");
    // Nothing is said before anything was tried.
    expect(html).not.toContain('data-testid="make-notice"');
    // Each box takes no more than the API keeps.
    expect(tag(html, "make-name")).toContain('maxLength="80"');
    expect(tag(html, "make-owner")).toContain('maxLength="80"');
  });

  it("says in Practice that the shop stays on this computer and nothing is sent", () => {
    expect(words(draw({}, { practice: true }))).toContain("Practice: the shop is made on this computer only. Nothing is sent, and it goes when the app closes.");
  });

  it("hands each field's typing and each pick to the flow, and a submit to Make my shop", () => {
    const p = props({ name: "Khao", kind: "food" });
    (byId(p, "make-name").props.onChange as (e: unknown) => void)({ target: { value: "Khao Hom" } });
    expect(p.onName).toHaveBeenCalledWith("Khao Hom");
    (byId(p, "make-owner").props.onChange as (e: unknown) => void)({ target: { value: "Dao" } });
    expect(p.onOwnerName).toHaveBeenCalledWith("Dao");
    for (const kind of SHOP_KINDS) {
      const radio = byId(p, `make-kind-${kind}`);
      expect(radio.props.checked).toBe(kind === "food");
      (radio.props.onChange as () => void)();
      expect(p.onKind).toHaveBeenLastCalledWith(kind);
    }
    const preventDefault = vi.fn();
    (byId(p, "make-shop").props.onSubmit as (e: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(p.onMake).toHaveBeenCalledTimes(1);
  });

  it("holds every field and the button while the shop is being made", () => {
    const p = props({ busy: true, name: "Khao Hom", ownerName: "Dao", kind: "none" });
    for (const id of ["make-name", "make-owner", "make-submit", ...SHOP_KINDS.map((kind) => `make-kind-${kind}`)]) {
      expect(byId(p, id).props.disabled, id).toBe(true);
    }
    expect(words(draw({ busy: true }))).toContain("Making your shop…");
  });

  it("says what is missing next to the field it is about", () => {
    const html = draw({ notice: { kind: "missing", field: "ownerName" } });
    expect(words(html)).toContain("Give your own name.");
    expect(tag(html, "make-owner")).toContain('aria-invalid="true"');
    expect(tag(html, "make-owner")).toContain('aria-describedby="make-shop-note"');
    expect(tag(html, "make-name")).not.toContain("aria-invalid");
    expect(tag(html, "make-notice")).toContain('role="alert"');
  });

  it("says that the shop is made and is the person's, in place of the form", () => {
    const shop = { id: "pilot:made", name: "Khao Hom", owner: "Dao", role: "owner" as const };
    const html = draw({ made: shop });
    expect(words(html)).toBe("Khao Hom is made, and it's yours It's in your shops now. Its routines wait for you to switch them on.");
    expect(html).not.toContain("make-submit");
    expect(words(draw({ made: shop }, { practice: true }))).toContain("Practice: it's in your shops until the app closes. Nothing was sent.");
  });
});

describe("what each answer says", () => {
  it("says every refusal in plain words, sign-ups not open above all", () => {
    setLang("en");
    const said = (code: string, message = "") => makeNoticeWords({ kind: "refused", code, message });
    expect(said("sign_ups_closed")).toBe("Making your own shop isn't open yet. For now, Manut AI sets each shop up with its owner.");
    expect(said("invalid_name")).toBe("A shop's name is 1 to 80 characters.");
    expect(said("invalid_owner_name")).toBe("Your name is 1 to 80 characters.");
    expect(said("unknown_template")).toBe("Manut AI doesn't have that kind of shop. Pick another, or None of these.");
    expect(said("too_many_shops")).toBe("You've made 3 shops, which is as many as one account can make.");
    expect(said("rate_limited")).toBe("Too many tries from this computer. Wait a minute, then try again.");
    expect(said("unavailable")).toBe("Your shop wasn't made just now. Try again in a minute.");
    expect(said("signed_out")).toBe(t("rt.signedOut"));
    expect(said("offline")).toBe(t("rt.offline"));
    // A code the page has no words for is said in the runtime's own, and one with none in the page's.
    expect(said("not_yet", "Not in this runtime yet.")).toBe("Not in this runtime yet.");
    expect(said("internal")).toBe("That didn't work. Try again.");
    expect(makeNoticeWords({ kind: "missing", field: "kind" })).toBe("Pick the kind of shop, or None of these.");
  });

  it("has every word in each language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      expect(makeNoticeWords({ kind: "refused", code: "sign_ups_closed", message: "" }), lang).not.toMatch(/^make\./);
      expect(makeNoticeWords({ kind: "refused", code: "too_many_shops", message: "" }), lang).toContain("3");
      expect(words(renderToString(<MakeShopView {...props()} />)), lang).not.toMatch(/make\.\w/);
    }
  });
});

describe("where Settings › Developer offers it", () => {
  const signedIn = { kind: "signed_in" as const, tenant: "apple:dao", signedInAt: 1 };
  const connected = { mode: "connected" as const, origin: "https://dev.manut.xyz" };
  const none = { loaded: true, list: [] };
  const base = { kind: "http" as const, saved: connected, restart: false, signIn: signedIn, shops: none, made: false };

  it("offers it to a signed-in person in no shop, on the API the page runs", () => {
    expect(makeShopOffer(base)).toBe("connected");
  });

  it("does not offer it to a person who has a shop, until this page has made their first", () => {
    const one = { loaded: true, list: [{ id: "pilot:a" }] };
    expect(makeShopOffer({ ...base, shops: one })).toBeNull();
    expect(makeShopOffer({ ...base, shops: one, made: true })).toBe("connected");
    // The list not read yet is not "no shops".
    expect(makeShopOffer({ ...base, shops: { loaded: false, list: [] } })).toBeNull();
  });

  it("does not offer it to nobody signed in, while a restart waits, or on the loopback bridge", () => {
    for (const signIn of [null, { kind: "signed_out" as const }, { kind: "loading" as const }, { kind: "signing_in" as const }, { kind: "no_keychain" as const }]) {
      expect(makeShopOffer({ ...base, signIn })).toBeNull();
    }
    expect(makeShopOffer({ ...base, restart: true })).toBeNull();
    expect(makeShopOffer({ ...base, kind: "websocket" })).toBeNull();
  });

  it("offers Practice's own, which sends nothing, whenever the page runs Practice", () => {
    const practice = { ...base, kind: "mock" as const, saved: { mode: "practice" as const }, signIn: null, shops: { loaded: true, list: [{ id: "x" }] } };
    expect(makeShopOffer(practice)).toBe("practice");
    expect(makeShopOffer({ ...practice, restart: true })).toBeNull();
  });
});
