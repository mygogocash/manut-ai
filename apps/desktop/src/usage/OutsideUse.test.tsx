// The Code page's "Outside Manut AI" lines (OutsideUse.tsx): off, reading, nothing found, the numbers, the table, a failed read
// and the skipped files, drawn with react-dom/server in each state, and the words in all four dictionaries.
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { DICT, LANGS, setLang, t } from "../i18n";
import { OutsideView, type Read } from "./OutsideUse";
import type { OutsideReport } from "./outside";

const NOW = 1_795_176_000;
const report = (tool: string, over: Partial<OutsideReport> = {}): OutsideReport => ({
  tool,
  rows: [
    { day: "2026-11-20", project: "shop", input: 1, output: 2, cache_read: 3, cache_write: 4, total: 12_400 },
    { day: "2026-11-19", project: "", input: 1, output: 2, cache_read: 3, cache_write: 4, total: 980 },
  ],
  today: 12_400,
  week: 13_380,
  read_at: NOW - 60,
  files_read: 3,
  files_cached: 0,
  skipped: { links: 0, too_big: 0, not_json: 0, compressed: 0, app_started: 2, over_limit: 0 },
  partial: false,
  ...over,
});
const view = (p: Partial<Parameters<typeof OutsideView>[0]>) =>
  renderToString(<OutsideView on reads={{}} open={null} onOpen={() => {}} openSettings={() => {}} now={NOW} {...p} />);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("Outside Manut AI lines", () => {
  it("offers the switch, and reads nothing, while it is off", () => {
    const html = view({ on: false });
    expect(html).toContain('data-testid="outside-off"');
    expect(text(html)).toContain("Counting them reads each tool&#x27;s own files on this Mac.");
    expect(html).toContain('data-testid="outside-turn-on"');
    expect(html).not.toContain("outside-claude");
  });

  it("says it is reading before the first answer", () => {
    expect(view({})).toContain('data-testid="outside-reading"');
  });

  it("shows tokens today and this week per tool, where they come from, and that the percentage is the tool's own", () => {
    const reads: Record<string, Read> = { claude: { report: report("claude") }, codex: { report: report("codex", { today: 0, week: 5, rows: [{ day: "2026-11-18", project: "app", input: 0, output: 5, cache_read: 0, cache_write: 0, total: 5 }] }) } };
    const html = view({ reads });
    const s = text(html);
    expect(s).toContain("Claude Code outside Manut AI");
    expect(s).toContain("12.4k today · 13.4k this week");
    expect(s).toContain("Codex outside Manut AI");
    expect(s).toContain("0 today · 5 this week");
    expect(s).toContain("Tokens read from each tool&#x27;s own files on this Mac. A plan&#x27;s percentage is only what the tool itself reported.");
    expect(s).toContain("Last read");
    // a table only on a click, and never a price
    expect(html).not.toContain("outside-claude-table");
    expect(s).not.toMatch(/[$฿€£]|USD|cost/i);
  });

  it("opens a table of day, folder and tokens on a click, with a word for a file that named no folder", () => {
    const html = view({ reads: { claude: { report: report("claude") }, codex: { report: report("codex") } }, open: "claude" });
    expect(html).toContain('data-testid="outside-claude-table"');
    expect(html).not.toContain('data-testid="outside-codex-table"');
    const s = text(html);
    expect(s).toContain("Day Folder Tokens");
    expect(s).toContain("2026-11-20 shop 12.4k");
    expect(s).toContain("2026-11-19 No folder named 980");
    expect(html).toContain('aria-expanded="true"');
  });

  it("has an empty state when nothing outside was used, and no table link", () => {
    const empty = (tool: string) => report(tool, { rows: [], today: 0, week: 0 });
    const html = view({ reads: { claude: { report: empty("claude") }, codex: { report: empty("codex") } } });
    expect(html).toContain('data-testid="outside-empty"');
    expect(html).not.toContain("outside-claude-details");
  });

  it("says what could not be read, and how many files were skipped or left unread", () => {
    const skipped = { links: 1, too_big: 1, not_json: 0, compressed: 3, app_started: 0, over_limit: 2 };
    const html = view({ reads: { claude: { error: "busy" }, codex: { report: report("codex", { skipped, partial: true }) } } });
    const s = text(html);
    expect(s).toContain("Could not read: busy");
    expect(s).toContain("5 files skipped: links, too large, not readable or compressed.");
    expect(s).toContain("Older files were left unread to keep this quick.");
  });

  it("has its words in every language, with the same slots", () => {
    const keys = Object.keys(DICT.en).filter((k) => k.startsWith("out."));
    expect(keys.length).toBeGreaterThan(15);
    for (const l of LANGS) {
      setLang(l);
      for (const k of keys) expect(t(k as never), `${l} ${k}`).not.toBe("");
    }
    setLang("en");
  });
});
