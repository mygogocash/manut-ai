// Bring over's dialog (ImportPast.tsx, item 101e): each step drawn with react-dom/server from the step it is given (what was found
// with nothing picked and the one line that nothing is copied or sent, a folder that is a project already, what was skipped, the
// confirmation, the result, a failed look and an empty one), its buttons pressed through the drawn elements, and the first
// launch's one look: when it opens the offer, when it only counts the offer as made, and when it does not look at all.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { ImportPastView, importParts, offerOnLaunch, skippedLine, type ImportViewProps } from "./ImportPast";
import { closeImport, getImportRecord, importOpen, importReduce, NO_SKIPS, resetImportRecordForTests, setImportRecord, type ImportFound, type ImportStep } from "./offer";

const HOME = "/home/you";
const WEB = "/home/you/code/web-app";
const API = "/home/you/code/shop-api";
const OLD = "/home/you/code/manut";
const NOW = 1_795_176_000_000;
const found: ImportFound = {
  projects: [
    { cwd: WEB, claude: 10, codex: 2, at: NOW / 1000 - 2 * 86_400 },
    { cwd: API, claude: 0, codex: 1, at: NOW / 1000 - 3_600 },
    { cwd: OLD, claude: 3, codex: 0, at: NOW / 1000 - 9 * 86_400 },
  ],
  skipped: { gone: 2, compressed: 14, unreadable: 1, over_limit: 0 },
  partial: false,
};
const pick = (listed: string[] = [OLD]): ImportStep => importReduce({ at: "looking" }, { type: "found", found, listed });
const noop = () => {};
const props = (step: ImportStep, over: Partial<ImportViewProps> = {}): ImportViewProps => ({ step, home: HOME, nowMs: NOW, onEvent: noop, onClose: noop, onBring: noop, onHistory: noop, ...over });
const html = (step: ImportStep, over: Partial<ImportViewProps> = {}) => renderToString(<ImportPastView {...props(step, over)} />);
const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...drawn(el.props.children as ReactNode)];
}
const press = (parts: { body: ReactNode; foot: ReactNode }, id: string) => {
  const el = [...drawn(parts.body), ...drawn(parts.foot)].find((e) => e.props["data-testid"] === id);
  if (!el) throw new Error(`no ${id}`);
  ((el.props.onClick ?? el.props.onChange) as () => void)();
};

beforeEach(() => setLang("en"));

describe("what was found", () => {
  it("lists each folder newest first with its conversations, nothing picked, and says once that nothing is copied or sent", () => {
    const h = html(pick());
    expect(h).toContain('data-step="pick"');
    expect(h).toMatch(/role="dialog"[^>]*aria-modal="true"/);
    const words = text(h);
    expect(words).toContain("Bring over your Claude Code and Codex work");
    expect(words).toContain("Only read: nothing in those agents' files is copied, moved or changed, and nothing leaves this Mac.");
    expect(h.split('data-testid="imp-promise"').length - 1).toBe(1);
    expect(words).toContain("3 folders found");
    // newest first: shop-api, web-app, then manut
    const order = [...h.matchAll(/data-cwd="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([API, WEB, OLD]);
    expect(words).toContain("shop-api ~/code/shop-api");
    expect(words).toContain("12 conversations");
    expect(words).toContain("1 conversation");
    // no box is ticked, and the button says to pick first and cannot be pressed
    expect(h).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(h).toMatch(/disabled=""[^>]*data-testid="imp-next"/);
    expect(words).toContain("Pick a folder");
  });

  it("shows a folder that is a project already without a box to pick, tagged", () => {
    const h = html(pick());
    expect(h.split('data-testid="imp-pick"').length - 1).toBe(2);
    expect(h).toMatch(new RegExp(`data-cwd="${OLD}" data-here="true"`));
    expect(text(h)).toContain("Already a project");
  });

  it("says what was skipped and why, in one line", () => {
    expect(text(html(pick()))).toContain("Skipped: 2 folders no longer on this Mac, 14 compressed Codex conversations that could not be unpacked, 1 file that could not be read.");
    expect(skippedLine(NO_SKIPS)).toBe("");
    expect(skippedLine({ ...NO_SKIPS, over_limit: 1 })).toBe("Skipped: 1 older conversation not looked at.");
  });

  it("counts the picks on its button, and Select all becomes Clear when every new folder is picked", () => {
    let s = importReduce(pick(), { type: "toggle", cwd: WEB });
    expect(text(html(s))).toContain("Bring over 1 project…");
    s = importReduce(s, { type: "all", on: true });
    const h = html(s);
    expect(text(h)).toContain("Bring over 2 projects…");
    expect(h).toMatch(/data-testid="imp-all"[^>]*>Clear</);
  });

  it("sends each press as its event: a box, Select all, Not now and the button", () => {
    const onEvent = vi.fn();
    const onClose = vi.fn();
    const s = importReduce(pick(), { type: "toggle", cwd: WEB });
    const parts = importParts(props(s, { onEvent, onClose }));
    press(parts, "imp-all");
    expect(onEvent).toHaveBeenLastCalledWith({ type: "all", on: true });
    press(parts, "imp-next");
    expect(onEvent).toHaveBeenLastCalledWith({ type: "next" });
    press(parts, "imp-not-now");
    expect(onClose).toHaveBeenCalledTimes(1);
    const box = drawn(parts.body).find((e) => e.props["data-testid"] === "imp-pick");
    (box!.props.onChange as () => void)();
    expect(onEvent.mock.calls.some(([e]) => e.type === "toggle")).toBe(true);
  });

  it("says when nothing is new, and when nothing was found at all, with only Close", () => {
    const all = html(pick([WEB, API, OLD]));
    expect(text(all)).toContain("Nothing new to bring over");
    expect(all).toContain('data-testid="imp-close"');
    expect(all).not.toContain('data-testid="imp-next"');
    const none = html(importReduce({ at: "looking" }, { type: "found", found: { projects: [], skipped: NO_SKIPS, partial: false }, listed: [] }));
    expect(text(none)).toContain("No Claude Code or Codex conversations were found on this Mac.");
    expect(none).not.toContain('data-testid="imp-skipped"');
  });
});

describe("the confirmation and the result", () => {
  const confirm = () => importReduce(importReduce(importReduce(pick(), { type: "toggle", cwd: WEB }), { type: "toggle", cwd: API }), { type: "next" });

  it("names the picks and what bringing them over does, with Back and Bring over", () => {
    const h = html(confirm());
    const words = text(h);
    expect(words).toContain("Bring over 2 projects?");
    expect(words).toContain("They are added to the Code page, and their conversations show in History.");
    expect(words).toContain("Only read: nothing in those agents' files is copied");
    expect([...h.matchAll(/data-cwd="([^"]+)"/g)].map((m) => m[1])).toEqual([API, WEB]);
    expect(h).not.toContain(OLD);
    const onBring = vi.fn();
    const onEvent = vi.fn();
    const parts = importParts(props(confirm(), { onBring, onEvent }));
    press(parts, "imp-back");
    expect(onEvent).toHaveBeenLastCalledWith({ type: "back" });
    expect(onBring).not.toHaveBeenCalled();
    press(parts, "imp-go");
    expect(onBring).toHaveBeenCalledTimes(1);
  });

  it("says where the projects and their conversations now are, with Open History", () => {
    const done = importReduce(confirm(), { type: "brought", brought: [API, WEB], conversations: 13 });
    const h = html(done);
    expect(text(h)).toContain("Brought over 2 projects");
    expect(text(h)).toContain("They are on the Code page now, and their conversations are in History.");
    const one = html({ at: "done", brought: [WEB], conversations: 12 });
    expect(text(one)).toContain("Brought over 1 project");
    expect(text(one)).toContain("It is on the Code page now, and its conversations are in History.");
    const onHistory = vi.fn();
    press(importParts(props(done, { onHistory })), "imp-history");
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  it("says a failed look with its reason", () => {
    expect(text(html({ at: "failed", why: "busy" }))).toContain("Could not look: busy");
    expect(text(html({ at: "looking" }))).toContain("Looking on this Mac for Claude Code and Codex work…");
  });

  it("draws every step in each of the four languages without a missing word", () => {
    for (const lang of ["ko", "ja", "zh"] as const) {
      setLang(lang);
      for (const s of [pick(), confirm(), { at: "done", brought: [WEB], conversations: 12 } as ImportStep, { at: "failed", why: "x" } as ImportStep]) {
        const h = text(html(s));
        expect(h, `${lang} ${s.at}`).not.toMatch(/imp\.[a-zA-Z]/);
        expect(h).not.toMatch(/\{[a-z]+\}/);
      }
    }
  });
});

describe("the first launch's look", () => {
  beforeEach(() => {
    resetImportRecordForTests();
    closeImport();
  });
  afterEach(() => closeImport());

  it("opens the offer once a folder that is not a project yet is found, and the offer is made when it closes", async () => {
    const host = { importScan: vi.fn(async () => found) };
    expect(await offerOnLaunch(host, false, () => [OLD])).toBe("open");
    expect(importOpen()?.found).toBe(found);
    // not made until the person closes it
    expect(getImportRecord().offered).toBe(false);
  });

  it("only counts the offer as made when everything found is a project already, or nothing was", async () => {
    const host = { importScan: vi.fn(async () => found) };
    expect(await offerOnLaunch(host, false, () => [WEB, API, OLD])).toBe("none");
    expect(importOpen()).toBeNull();
    expect(getImportRecord().offered).toBe(true);
    // made once: the next launch does not look
    expect(await offerOnLaunch(host, false, () => [])).toBe("skip");
    expect(host.importScan).toHaveBeenCalledTimes(1);
  });

  it("does not look while the first-run setup fills the window, on a host that cannot, or once the offer was made", async () => {
    const host = { importScan: vi.fn(async () => found) };
    expect(await offerOnLaunch(host, true, () => [])).toBe("skip");
    expect(await offerOnLaunch({}, false, () => [])).toBe("skip");
    setImportRecord({ offered: true, folders: [] });
    expect(await offerOnLaunch(host, false, () => [])).toBe("skip");
    expect(host.importScan).not.toHaveBeenCalled();
  });

  it("tries again on the next launch after a failed look, and opens nothing for a launch that is gone", async () => {
    const failing = { importScan: vi.fn(async (): Promise<ImportFound> => Promise.reject(new Error("busy"))) };
    expect(await offerOnLaunch(failing, false, () => [])).toBe("failed");
    expect(getImportRecord().offered).toBe(false);
    const host = { importScan: vi.fn(async () => found) };
    expect(await offerOnLaunch(host, false, () => [], () => false)).toBe("skip");
    expect(importOpen()).toBeNull();
  });
});
