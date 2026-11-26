// The Artifacts page (item 83), drawn from the state it is given as menuPages.test.tsx draws the menu's pages: why Share cannot be used
// yet in each case, with nothing to send; the ask, which shows exactly what will be published and that anyone with the link can open
// it; the list with Open, Copy link and Remove; and Practice, which refuses every link op.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang, t } from "../i18n";
import type { BridgeError } from "../lib/protocol";
import { MockHost, MockRuntime } from "../runtime/mock";
import type { ArtifactLink, SharePlan } from "../runtime/artifacts";
import { ArtifactsPage, ArtifactsView, gate, type ArtifactsViewProps } from "./ArtifactsPage";
import { blockedReason, ownSkills, planFromFile, planFromReads, sizeText } from "./artifacts";
import { FileReview } from "../runtime/fileReview";
import type { ReadSkill, SkillsPlan } from "../runtime/skillBundle";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const NOW = Date.UTC(2026, 10, 25, 5);
const LINK: ArtifactLink = { id: "art-1", title: "Menu", kind: "html", bytes: 2560, createdAt: NOW / 1000 - 3600, url: "https://links.example/a/s.k" };
const PLAN: SharePlan = { shop: "pilot:shop-a", title: "Opening hours", kind: "markdown", text: "# Open every day", bytes: 16 };

function draw(over: Partial<ArtifactsViewProps>): string {
  const noop = () => {};
  return renderToString(
    <ArtifactsView state={{ kind: "ready", shop: "pilot:shop-a", publishing: "on" }} links={[]} ask={null} busy={false} error={null} notice={null} copied={null} nowMs={NOW}
      onShare={noop} onAnswer={noop} onOpen={noop} onCopy={noop} onRemove={noop} onSettings={noop} onRetry={noop} {...over} />,
  );
}
const shareDisabled = (html: string) => /<button[^>]*disabled=""[^>]*data-testid="art-share"/.test(html);

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

beforeEach(() => setLang("en"));
afterEach(() => vi.unstubAllGlobals());

describe("why Share cannot be used yet", () => {
  it("says it in plain words for the switch, Practice, no sign-in, and the API's own reasons, with Share off", () => {
    const cases: [ArtifactsViewProps["state"], string][] = [
      [{ kind: "switched_off" }, "Publishing public links is off on this Mac. Turn it on in Settings › Artifacts."],
      [{ kind: "practice" }, "Public links can be made once Manut AI is connected to your shop."],
      [{ kind: "signed_out" }, "Sign in to your shop first: a link belongs to your shop's account."],
      [{ kind: "ready", shop: "s", publishing: "feature_disabled" }, "Public links are not turned on for Manut AI yet."],
      [{ kind: "ready", shop: "s", publishing: "artifact_origin_not_configured" }, "Public links have no web address of their own yet, so none can be made."],
      [{ kind: "failed", code: "owner_only", message: t("art.err.ownerOnly") }, "Only the shop's owner shares or removes its links."],
    ];
    for (const [state, said] of cases) {
      const html = draw({ state });
      expect(words(html), state.kind).toContain(said);
      expect(shareDisabled(html), state.kind).toBe(true);
    }
    expect(draw({ state: { kind: "switched_off" } })).toContain('data-testid="art-open-settings"');
    expect(blockedReason({ kind: "ready", shop: "s", publishing: "on" })).toBeNull();
    expect(shareDisabled(draw({}))).toBe(false);
  });

  it("waits for the switch, then the runtime, then the sign-in, before anything is read", () => {
    expect(gate(false, false, { kind: "signed_in" })).toEqual({ kind: "switched_off" });
    expect(gate(true, true, null)).toEqual({ kind: "practice" });
    // the keychain has not answered yet: nobody is told to sign in who may be signed in
    expect(gate(true, false, { kind: "loading" })).toEqual({ kind: "reading" });
    expect(gate(true, false, { kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(gate(true, false, { kind: "no_keychain" })).toEqual({ kind: "signed_out" });
    expect(gate(true, false, { kind: "signed_in" })).toBeNull();
  });

  it("opens with the switch off by default, saying so, before anything is read", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    const html = renderToString(<ArtifactsPage />);
    expect(html).toContain('data-testid="page-artifacts"');
    expect(html).toContain('data-state="switched_off"');
    expect(shareDisabled(html)).toBe(true);
  });
});

describe("the ask", () => {
  it("shows the title, the kind, the size and that anyone with the link can open it, with yes and no, and Share waits", () => {
    const html = draw({ ask: { kind: "share", id: "a1", plan: PLAN } });
    const text = words(html);
    expect(text).toContain("Publish “Opening hours” as a public link?");
    expect(text).toContain("Markdown page");
    expect(text).toContain("16 bytes");
    expect(text).toContain("Anyone with the link can open it, without signing in. It stays open until you remove it.");
    expect(html).toContain('data-testid="art-ask-yes"');
    expect(html).toContain('data-testid="art-ask-no"');
    expect(shareDisabled(html)).toBe(true);
  });

  it("asks before a removal too, and says it cannot be undone", () => {
    const text = words(draw({ links: [LINK], ask: { kind: "remove", id: "r1", plan: { shop: "s", id: LINK.id, title: LINK.title, url: LINK.url } } }));
    expect(text).toContain("Remove the link to “Menu”?");
    expect(text).toContain("This cannot be undone.");
  });
});

describe("the list", () => {
  it("lists each link with its kind, size, day and address, and Open, Copy link and Remove", () => {
    const html = draw({ links: [LINK] });
    const text = words(html);
    expect(text).toContain("Menu");
    expect(text).toContain("HTML page · 2.5 KB · Published 25 November");
    expect(text).toContain(LINK.url!);
    for (const id of ["art-open", "art-copy", "art-remove"]) expect(html).toContain(`data-testid="${id}"`);
    expect(words(draw({ links: [LINK], copied: LINK.id }))).toContain("Copied");
  });

  it("offers only Remove for a link with no web address, and says it has none", () => {
    const html = draw({ links: [{ ...LINK, url: null }] });
    expect(words(html)).toContain("No web address yet");
    expect(html).not.toContain('data-testid="art-copy"');
    expect(html).toContain('data-testid="art-remove"');
  });

  it("says what shows here while there is no link", () => {
    expect(words(draw({}))).toContain("No public links yet");
  });

  it("says sizes as a person reads them", () => {
    expect([900, 2560, 40 * 1024].map(sizeText)).toEqual(["900 bytes", "2.5 KB", "40 KB"]);
  });
});

describe("a chosen file", () => {
  const file = (name: string, text: string) => ({ name, text: async () => text });

  it("becomes the plan the ask shows, titled by its name", async () => {
    expect(await planFromFile(file("Opening hours.md", "# Open every day"), "pilot:shop-a")).toEqual({ ok: true, plan: PLAN });
  });

  it("is refused in words, with nothing asked, when it is not HTML or Markdown, is empty, too large or cannot be read", async () => {
    expect(await planFromFile(file("photo.png", "x"), "s")).toEqual({ ok: false, message: t("art.err.kind") });
    expect(await planFromFile(file("empty.md", ""), "s")).toEqual({ ok: false, message: t("art.err.empty") });
    expect(await planFromFile(file("big.html", "a".repeat(129 * 1024)), "s")).toEqual({ ok: false, message: t("art.err.tooLarge", { max: 128 }) });
    expect(await planFromFile({ name: "gone.md", text: () => Promise.reject(new Error("gone")) }, "s")).toEqual({ ok: false, message: t("art.err.read") });
  });
});

describe("in Practice", () => {
  it("refuses every link op, so nothing is published or kept", async () => {
    const rt = new MockRuntime(new MockHost());
    await rt.connect();
    const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<unknown>;
    for (const [op, params] of [["artifacts.list", {}], ["artifacts.publish", { ask: "a" }], ["artifacts.remove", { ask: "a" }]] as const) {
      const refused = await req(op, params).then(() => null, (e: BridgeError) => e);
      expect(refused, op).toEqual({ code: "practice", message: t("art.err.practice") });
    }
  });
});

describe("sharing skills as a link (item 84)", () => {
  const KEY = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const read = (over: Partial<ReadSkill> = {}): ReadSkill => ({
    name: "promptpay",
    files: [{ path: "SKILL.md", text: "Make a QR.", bytes: 10, exec: false }, { path: "bin/qr", text: "echo qr", bytes: 7, exec: true }],
    refused: [],
    leftOut: [],
    ...over,
  });
  const PLAN_SKILLS: SkillsPlan = { shop: "pilot:shop-a", title: "promptpay", bytes: 120, scripts: ["promptpay/bin/qr"],
    skills: [{ name: "promptpay", files: [{ path: "SKILL.md", text: "Make a QR." }, { path: "bin/qr", text: "echo qr" }] }] };

  it("offers only the person's own skills, never a plugin's or a project's", () => {
    expect(ownSkills([{ agent: "claude", found: true, servers: [], skills: [
      { name: "promptpay", from: "home", state: "on", folder: "promptpay" },
      { name: "helping", from: "plugin", plugin: "helper", state: "on", folder: "helping" },
      { name: "shop-copy", from: "project", state: "on", folder: "shop-copy" },
      { name: "no-folder", from: "home", state: "on" },
    ] }])).toEqual([{ agent: "claude", folder: "promptpay", name: "promptpay" }]);
  });

  it("names every file that stops the publish (a link, a binary, a key) and never shows the key", () => {
    const made = planFromReads([read({ refused: [{ path: "linked.txt", why: "link" }, { path: "logo.png", why: "binary" }] }),
      read({ name: "deploy", files: [{ path: "SKILL.md", text: `push with ${KEY}`, bytes: 50, exec: false }], leftOut: [".env"] })], "pilot:shop-a");
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.lines).toEqual([
      t("skl.err.link", { file: "promptpay/linked.txt" }),
      t("skl.err.binary", { file: "promptpay/logo.png" }),
      t("skl.err.secret", { file: "deploy/SKILL.md" }),
    ]);
    expect(made.leftOut).toEqual(["deploy/.env"]);
    expect(JSON.stringify(made)).not.toContain(KEY);
  });

  it("makes the plan with each script marked, by its executable bit too", () => {
    const made = planFromReads([read()], "pilot:shop-a");
    expect(made.ok && made.plan).toMatchObject({ title: "promptpay", scripts: ["promptpay/bin/qr"], skills: PLAN_SKILLS.skills });
  });

  it("shows every file with its size and scripts marked, and holds Yes back until every file was looked at", () => {
    const review = new FileReview(["promptpay/SKILL.md", "promptpay/bin/qr"]);
    const ask = { kind: "skills" as const, id: "a1", plan: PLAN_SKILLS };
    const skills = { review, shown: null, leftOut: [".env"], onView: () => {}, onTick: () => {} };
    const yesDisabled = (html: string) => /<button[^>]*disabled=""[^>]*data-testid="art-ask-yes"/.test(html);
    let html = draw({ ask, skills });
    expect(html).toContain('data-kind="skills"');
    expect((html.match(/data-testid="skl-file"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-path="promptpay\/bin\/qr" data-script="1"/);
    expect(html).toMatch(/data-path="promptpay\/SKILL.md" data-script="0"/);
    expect(words(html)).toContain(t("skl.ask.public"));
    expect(words(html)).toContain("Hidden files are never shared, so these are left out: .env");
    expect(words(html)).toContain(t("skl.wait"));
    expect(yesDisabled(html)).toBe(true);
    review.open("promptpay/SKILL.md");
    expect(yesDisabled(draw({ ask, skills }))).toBe(true);
    review.open("promptpay/bin/qr");
    html = draw({ ask, skills });
    expect(yesDisabled(html)).toBe(false);
    expect(html).not.toContain('data-testid="skl-wait"');
  });

  it("says why skills cannot be chosen yet, with Settings when the switch is off", () => {
    const html = draw({ picking: { step: "blocked", why: t("skl.why.switchedOff"), settings: true }, onShareSkills: () => {} });
    expect(words(html)).toContain("Sharing skills by link is off on this Mac. Turn it on in Settings › Artifacts.");
    expect(html).toContain('data-testid="skl-pick-settings"');
    // while the picker is open, neither share button can start another
    expect(/<button[^>]*disabled=""[^>]*data-testid="art-share-skills"/.test(html)).toBe(true);
  });
});
