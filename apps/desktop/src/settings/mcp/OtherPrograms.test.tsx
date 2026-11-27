// Settings › MCP and Skills › Other programs (item 103, docs/mcp-threads.md), drawn with react-dom/server: off until the person
// turns it on, with nothing else shown; on, the list with each chat's number, a chat that cannot be reached marked, Add while the
// list has room, and the address to copy for Claude Code and for an mcpServers file; the line for an app outside Applications;
// and the line for an edition that does not offer it.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../../i18n";
import type { ReachEntry } from "../../jobs/reachList";
import type { McpSettings } from "../../threadsMcp/shell";
import { claudeLine, movable, OtherProgramsView, serversBlock, type OtherProgramsViewProps } from "./OtherPrograms";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};
const APP = "/Applications/Manut AI.app/Contents/MacOS/manut";
const ON: McpSettings = { on: true, available: true, command: APP, args: ["--threads-mcp"] };
const entry = (n: number, title: string): ReachEntry => ({ n, ref: { kind: "session", id: `s${n}` }, title, scope: {} });

function draw(over: Partial<OtherProgramsViewProps> = {}) {
  return renderToString(<OtherProgramsView state={ON} list={[]} stateOf={() => "idle"} onOn={noop} onAdd={noop} onRemove={noop} {...over} />);
}

afterEach(() => setLang("en"));

describe("Settings › MCP and Skills › Other programs", () => {
  it("is off until the person turns it on, and shows nothing else while off", () => {
    const html = draw({ state: { ...ON, on: false } });
    expect(html).toMatch(/data-testid="tm-switch"[\s\S]*?aria-checked="true"[^>]*>Off</);
    expect(html).not.toContain('data-testid="tm-list"');
    expect(html).not.toContain('data-testid="tm-claude"');
    expect(words(html)).toContain("every read, message and new lane asks you on a card");
  });

  it("lists the chats by number, marks one that cannot be reached, and offers Add while there is room", () => {
    const list = [entry(1, "Fix the login"), entry(3, "Weekly prices")];
    const html = draw({ list, stateOf: (e) => (e.n === 3 ? "moved" : "working") });
    expect(html).toMatch(/data-n="1"[\s\S]*?Fix the login/);
    expect(html).toMatch(/data-n="3"[\s\S]*?Weekly prices[\s\S]*?moved/);
    expect(html).toContain('data-testid="tm-add"');
    const full = draw({ list: Array.from({ length: 10 }, (_, i) => entry(i + 1, `Chat ${i + 1}`)) });
    expect(full).not.toContain('data-testid="tm-add"');
    expect(words(draw({ line: "Fix the login is on the list already." }))).toContain("Fix the login is on the list already.");
  });

  it("gives the address to copy, quoted so the path's space and any other character stay one word", () => {
    expect(claudeLine(ON)).toBe("claude mcp add manut-threads -- '/Applications/Manut AI.app/Contents/MacOS/manut' '--threads-mcp'");
    expect(claudeLine({ command: "/Users/k/it's $HOME/manut", args: ["--threads-mcp"] })).toBe("claude mcp add manut-threads -- '/Users/k/it'\\''s $HOME/manut' '--threads-mcp'");
    expect(JSON.parse(serversBlock(ON))).toEqual({ mcpServers: { "manut-threads": { command: APP, args: ["--threads-mcp"] } } });
    const html = draw();
    expect(words(html)).toContain("claude mcp add manut-threads");
    expect(html).toContain('data-testid="tm-copy-claude"');
    expect(html).toContain('data-testid="tm-copy-json"');
    expect(words(html)).not.toContain("this address changes if you move the app");
  });

  it("says the address changes when the app is not in Applications", () => {
    expect(movable(APP)).toBe(false);
    expect(movable("/Users/k/Downloads/Manut AI.app/Contents/MacOS/manut")).toBe(true);
    expect(movable("/private/var/folders/x/AppTranslocation/y/d/Manut AI.app/Contents/MacOS/manut")).toBe(true);
    expect(words(draw({ state: { ...ON, command: "/Users/k/Downloads/Manut AI.app/Contents/MacOS/manut" } }))).toContain("this address changes if you move the app");
  });

  it("says when this edition does not offer it, with no switch", () => {
    const html = draw({ state: { ...ON, on: false, available: false } });
    expect(words(html)).toContain("only in the Mac app");
    expect(html).not.toContain('data-testid="tm-switch"');
  });
});
