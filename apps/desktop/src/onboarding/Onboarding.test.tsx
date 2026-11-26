// The first-run setup, drawn with react-dom/server as smoke.test.tsx draws the first screen: Welcome, then the design
// canvas's three steps (Onboarding.dc.html). The view draws whatever flow it is given; the last test walks the
// connected setup on the app's own store and demo runtime, where Your team lists the runtime's own members.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { DICT, LANGS, setLang, type Lang } from "../i18n";
import { getStore } from "../state/store";
import { EMPTY_SHOP, type ShopProfile } from "./shop";
import type { FlowState, Problem, Screen } from "./flow";
import { Onboarding, OnboardingView, type TeamIntro } from "./Onboarding";
import { HomePage } from "../pages/HomePage";

/** The text a person would read: tags and attribute values removed, entities decoded where tests compare them. */
const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;
const noop = () => {};

const BAAN_MALI: ShopProfile = { person: "Fon", shop: "Baan Mali", sells: "", places: ["line", "shopee"], main: null };
const TEAM: TeamIntro[] = [
  { name: "nam", displayName: "Nam", description: "Sales chat", role: "sales" },
  { name: "pim", displayName: "Pim", description: "Content", role: "content" },
  { name: "ton", displayName: "Ton", description: "Books", role: "books" },
];

function draw(screen: Screen, over: { draft?: ShopProfile; problems?: Problem[]; lang?: Lang; team?: TeamIntro[] } = {}) {
  const lang = over.lang ?? "en";
  setLang(lang);
  const flow: FlowState = { screen, draft: over.draft ?? BAAN_MALI, problems: over.problems ?? [] };
  return renderToString(<OnboardingView flow={flow} lang={lang} team={over.team ?? TEAM} onEvent={noop} onLang={noop} onEnd={noop} />);
}

/** The buttons in the row under a step, in order, by their words. */
const footButtons = (html: string) =>
  [...(/data-testid="frun-foot"[^>]*>(.*?)<\/div>/s.exec(html)?.[1] ?? "").matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => words(m[1]).trim());

describe("Welcome", () => {
  afterEach(() => setLang("en"));

  it("offers one honest way in, says signing in comes later, and keeps the canvas's promise", () => {
    const html = draw("welcome");
    const text = words(html);
    expect(html).toContain('data-testid="first-run"');
    expect(html).toMatch(/<h1[^>]*>.*Manut AI<\/h1>/s);
    expect(text).toContain("One desktop app with an AI assistant, an AI team and an AI code editor for your shop.");
    expect(html).toMatch(/<button type="button" class="btn dark big"[^>]*data-testid="frun-continue"[^>]*>Continue on this computer<\/button>/);
    expect(text).toContain("Signing in comes later. Until then, everything you set up stays on this computer.");
    expect(text).toContain("Nothing is sent, posted or paid until you approve it.");
    // the canvas's sign-in buttons would do nothing yet, so none is drawn
    for (const w of ["Continue with LINE", "Continue with Google", "Use email"]) expect(text, w).not.toContain(w);
    // nothing else to press but the languages, and no steps yet
    expect(count(html, "<button")).toBe(5);
    expect(html).not.toContain('class="stepper"');
    expect(text).not.toContain("Skip for now");
  });

  it("offers the app's own languages, each in its own words, with the one in use pressed", () => {
    const html = draw("welcome", { lang: "ja" });
    expect(html).toMatch(/role="group" aria-label="言語"/);
    const langs = [...html.matchAll(/<button[^>]*class="fchip"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(langs).toEqual(["English", "한국어", "日本語", "中文"]);
    expect(html).toMatch(/aria-pressed="true" lang="ja"[^>]*data-testid="frun-lang-ja"/);
    expect(count(html, 'aria-pressed="true"')).toBe(1);
    // Thai is not one of the app's languages yet
    expect(html).not.toContain("ไทย");
    expect(words(html)).toContain("このコンピューターで続ける");
  });
});

describe("the steps' frame", () => {
  afterEach(() => setLang("en"));

  it("has the brand, the canvas's three steps with the current one marked, and how far along the person is", () => {
    const html = draw("channel");
    expect(html).toMatch(/<ol class="stepper" aria-label="Setup steps"/);
    expect(words(html)).toMatch(/1 Your shop 2 One channel 3 Your team/);
    expect(html).toMatch(/<li class="stp done"><i>1<\/i>Your shop<\/li>/);
    expect(html).toMatch(/<li class="stp now" aria-current="step"><i>2<\/i>One channel<\/li>/);
    expect(html).toMatch(/<li class="stp"><i>3<\/i>Your team<\/li>/);
    expect(count(html, 'aria-current="step"')).toBe(1);
    expect(words(html)).toContain("Step 2 of 3");
  });

  it("places Back, Skip for now and Next as the canvas does, and ends on Open Manut AI", () => {
    expect(footButtons(draw("shop"))).toEqual(["Back", "Skip for now", "Next"]);
    expect(footButtons(draw("channel"))).toEqual(["Back", "Skip for now", "Next"]);
    expect(footButtons(draw("team"))).toEqual(["Back", "Open Manut AI"]);
    expect(draw("shop")).toMatch(/<button type="button" class="lk"[^>]*>Skip for now<\/button><button type="submit" class="btn dark"[^>]*>Next<\/button>/);
    expect(draw("team")).toMatch(/<button type="button" class="btn dark"[^>]*data-testid="frun-open"[^>]*>Open Manut AI<\/button>/);
  });
});

describe("Your shop", () => {
  afterEach(() => setLang("en"));

  it("asks for the person's name, the shop's name, what it sells and where it sells, holding what was typed", () => {
    const html = draw("shop");
    const text = words(html);
    expect(html).toMatch(/<h1[^>]*>Tell Buddy about your shop<\/h1>/);
    expect(text).toContain("Buddy will use this to answer in your shop’s voice. It stays on this computer, and you can change it later in Settings.");
    expect(html).toMatch(/<label for="frun-person">Your name <span class="mut">Optional<\/span><\/label><input id="frun-person"[^>]*value="Fon"/);
    expect(html).toMatch(/<label for="frun-shop">Shop name<\/label><input id="frun-shop"[^>]*required=""[^>]*value="Baan Mali"/);
    expect(html).toMatch(/<label for="frun-sells">What you sell <span class="mut">Optional<\/span><\/label><input id="frun-sells"[^>]*placeholder="For example: scented candles and soap"/);
    expect(text).toContain("The name your customers know.");
    expect(html).toMatch(/role="group" aria-labelledby="frun-where"/);
    const chips = [...html.matchAll(/<button type="button" class="fchip" aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => `${m[2]}:${m[1]}`);
    expect(chips).toEqual(["LINE:true", "Shopee:true", "Lazada:false", "Facebook:false", "Instagram:false"]);
    expect(text).toContain("Pick every place you sell. You can change this later in Settings.");
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("marks what a refused Next found missing, in the canvas's error style, on the field it belongs to", () => {
    const html = draw("shop", { draft: EMPTY_SHOP, problems: ["shop", "places"] });
    expect(html).toMatch(/<input id="frun-shop"[^>]*aria-invalid="true"[^>]*aria-describedby="frun-shop-help"/);
    expect(html).toMatch(/<span class="help err" id="frun-shop-help">Type your shop’s name.<\/span>/);
    expect(html).toMatch(/<span class="help err" id="frun-where-help" aria-live="polite">Pick at least one place you sell.<\/span>/);
    // only what is missing is marked
    const one = draw("shop", { draft: { ...EMPTY_SHOP, shop: "Baan Mali" }, problems: ["places"] });
    expect(one).not.toContain('aria-invalid="true"');
    expect(one).toMatch(/<span class="help" id="frun-shop-help">/);
  });
});

describe("the setup's classes", () => {
  it("leave out the chat's global .hint, which would lift a line out of the page as a popover", () => {
    for (const screen of ["welcome", "shop", "channel", "team"] as const) expect(draw(screen), screen).not.toMatch(/class="hint"/);
    expect(draw("team")).toMatch(/<p class="fnote">You switch each one on from the Team screen/);
  });
});

describe("the places' names", () => {
  it("stay as each brand writes them in every language, and LINE's full name keeps LINE", () => {
    const brands = { "onb.ch.line": "LINE", "onb.ch.shopee": "Shopee", "onb.ch.lazada": "Lazada", "onb.ch.facebook": "Facebook", "onb.ch.instagram": "Instagram" } as const;
    for (const l of LANGS) {
      for (const [k, name] of Object.entries(brands)) expect(DICT[l][k as keyof typeof brands], `${l} ${k}`).toBe(name);
      expect(DICT[l]["onb.ch.lineFull"], l).toContain("LINE");
    }
  });
});

describe("One channel", () => {
  afterEach(() => setLang("en"));

  it("lets the person pick the place that matters most from where they sell, and says plainly that nothing is connected", () => {
    const html = draw("channel", { draft: { ...BAAN_MALI, main: "shopee" } });
    const text = words(html);
    expect(html).toMatch(/<h1[^>]*>Which channel matters most\?<\/h1>/);
    expect(text).toContain("Nothing is connected yet. You connect it later, in Customize, and the team starts there.");
    expect(text).toMatch(/Channels Not connected yet/);
    expect(html).toMatch(/role="radiogroup" aria-labelledby="frun-ch-h"/);
    const radios = [...html.matchAll(/<button type="button" role="radio" class="rad" aria-checked="(true|false)" tabindex="(-?\d)"[^>]*><span>([^<]*)<small>([^<]*)<\/small>/g)].map(
      (m) => [m[3], m[4], m[1], m[2]],
    );
    expect(radios).toEqual([
      ["LINE Official Account", "Customer chats", "false", "-1"],
      ["Shopee", "Orders, chat and refunds", "true", "0"],
    ]);
    expect(text).toContain("One channel is enough to start. You can connect the others later in Customize.");
    // no Connect button, and no Connected state that is not true
    expect(text).not.toMatch(/\bConnected\b/);
    expect(text).not.toMatch(/\bConnect\b/);
  });

  it("lets the keyboard reach the first place while none is picked, and says a pick is missing after a refused Next", () => {
    const html = draw("channel", { problems: ["main"] });
    expect(html).toMatch(/aria-checked="false" tabindex="0"[^>]*data-testid="frun-main-line"/);
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*data-testid="frun-main-shopee"/);
    expect(html).toMatch(/<span class="help err" id="frun-main-help" aria-live="polite">Pick the channel that matters most.<\/span>/);
  });
});

describe("Your team", () => {
  afterEach(() => setLang("en"));

  it("introduces Nam, Pim and Ton in practice mode, in the canvas's words, working for the shop", () => {
    const html = draw("team");
    const text = words(html);
    expect(html).toMatch(/<h1[^>]*>Meet your team<\/h1>/);
    expect(text).toContain("Each one starts in practice mode: they draft and change nothing until you switch them on.");
    expect(text).toMatch(/Working for Baan Mali Drafts only, changes nothing/);
    expect(text).toMatch(/Nam Sales chat Drafts replies to customers on LINE and Shopee Practice mode/);
    expect(text).toMatch(/Pim Content Drafts posts and captions for your shop Practice mode/);
    expect(text).toMatch(/Ton Books Drafts the daily sales summary and flags refunds Practice mode/);
    expect(count(html, '<span class="tag">Practice mode</span>')).toBe(3);
    expect(text).toContain("You switch each one on from the Team screen. Money and public posts always ask you first.");
  });

  it("says your shop before it has a name, and drafts replies without naming places before any is picked", () => {
    const text = words(draw("team", { draft: EMPTY_SHOP }));
    expect(text).toContain("Working for your shop");
    expect(text).toMatch(/Nam Sales chat Drafts replies to customers Practice mode/);
  });

  it("says where the team will show when the runtime lists none of them", () => {
    const html = draw("team", { team: [] });
    expect(html).not.toContain('class="tag"');
    expect(words(html)).toContain("Buddy and the team show here when the app reaches them.");
  });
});

describe("the setup on the app's store", () => {
  afterEach(() => setLang("en"));

  it("opens on Welcome on a first run and walks to Your team, which lists the demo runtime's own members", async () => {
    setLang("en");
    const store = getStore();
    await store.actions.init();
    expect(words(renderToString(<Onboarding />))).toContain("Continue on this computer");
    const a = store.actions;
    a.firstRunDo({ type: "next" });
    a.firstRunDo({ type: "edit", field: "shop", value: "Baan Mali" });
    a.firstRunDo({ type: "place", channel: "line" });
    a.firstRunDo({ type: "next" });
    a.firstRunDo({ type: "next" });
    expect(store.getState().ui.firstRun?.screen).toBe("team");
    const text = words(renderToString(<Onboarding />));
    expect(text).toMatch(/Working for Baan Mali/);
    expect(text).toMatch(/Nam Sales chat Drafts replies to customers on LINE Practice mode Pim Content .* Ton Books/);
    // Buddy and Kit are not part of the practice team
    expect(text).not.toContain("Kit");
    // Open Manut AI lands on Home, which names the shop under the brand
    a.firstRunEnd();
    expect(renderToString(<Onboarding />)).toBe("");
    expect(store.getState().ui.view).toBe("home");
    expect(words(renderToString(<HomePage />))).toContain("For Baan Mali");
  });
});
