// The line under a lane's row that says how far its branch is from its remote (src/code/LaneSync.tsx, item 146). Drawn from props
// with react-dom/server: the view uses no hooks. The shell's counting is tested against real git in src-tauri/src/lane_remote.rs.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { LaneSyncView } from "./LaneSync";
import type { LaneRemote } from "./laneRemote";

const draw = (remote: LaneRemote) => renderToString(createElement(LaneSyncView, { remote }));
const words = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

afterEach(() => setLang("en"));

describe("a lane row's line about its remote", () => {
  it("says how many commits the branch is ahead of its remote branch", () => {
    const html = draw({ upstream: "origin/kit/x", ahead: 2, behind: 0 });
    expect(words(html)).toBe("2 ahead of origin/kit/x");
    expect(html).toContain('data-testid="lane-sync"');
    expect(html).toContain('data-ahead="2"');
    expect(html).toContain('data-behind="0"');
    expect(html).toContain('data-remote="origin/kit/x"');
  });

  it("says how many it is behind, and both when it is both", () => {
    expect(words(draw({ upstream: "origin/kit/x", ahead: 0, behind: 5 }))).toBe("5 behind origin/kit/x");
    expect(words(draw({ upstream: "origin/kit/x", ahead: 2, behind: 1 }))).toBe("2 ahead and 1 behind origin/kit/x");
  });

  it("says it is level when nothing differs", () => {
    expect(words(draw({ upstream: "origin/kit/x", ahead: 0, behind: 0 }))).toBe("Level with origin/kit/x");
  });

  it("says how many commits are not pushed for a branch no remote has, and nothing for one with none", () => {
    expect(words(draw({ upstream: null, ahead: 3, behind: 0 }))).toBe("3 not pushed yet");
    expect(draw({ upstream: null, ahead: 0, behind: 0 })).toBe("");
  });

  it("writes a count past what the page shows as 999+", () => {
    expect(words(draw({ upstream: "origin/x", ahead: 1000, behind: 0 }))).toBe("999+ ahead of origin/x");
  });

  it("says in its tooltip how it was counted: from what git holds, with nothing fetched", () => {
    expect(draw({ upstream: "origin/kit/x", ahead: 1, behind: 0 })).toContain("Nothing is fetched");
  });

  it("is quiet text on the row, like the lines beside it", () => {
    expect(draw({ upstream: "origin/kit/x", ahead: 1, behind: 0 })).toContain('class="mut lline lsync"');
  });
});
