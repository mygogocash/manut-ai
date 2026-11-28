// How far a lane's branch is from its remote, as the shell answers and as the row says it (laneRemote.ts, item 146). The shell's own
// counting is tested against real git in src-tauri/src/lane_remote.rs; here are the answers it can give, made up.
import { describe, expect, it } from "vitest";
import { COUNT_SHOWN, countText, readLaneRemote, syncWords } from "./laneRemote";

describe("the shell's answer", () => {
  it("is read as the remote branch and the two counts", () => {
    expect(readLaneRemote({ upstream: "origin/kit/x", ahead: 2, behind: 1 })).toEqual({ upstream: "origin/kit/x", ahead: 2, behind: 1 });
    expect(readLaneRemote({ upstream: null, ahead: 3, behind: 0 })).toEqual({ upstream: null, ahead: 3, behind: 0 });
  });

  it("takes no remote for a name that is empty or not text, and 0 for a count that is not a number above zero (a fraction is cut to its whole part)", () => {
    expect(readLaneRemote({ upstream: "", ahead: 1, behind: 0 })?.upstream).toBeNull();
    expect(readLaneRemote({ upstream: 7, ahead: 1, behind: 0 })?.upstream).toBeNull();
    for (const bad of [-1, 0, 1.9, Number.NaN, Infinity, "3", null, undefined]) {
      const got = readLaneRemote({ upstream: "origin/x", ahead: bad, behind: bad });
      expect(got?.ahead, String(bad)).toBe(bad === 1.9 ? 1 : 0);
      expect(got?.behind, String(bad)).toBe(bad === 1.9 ? 1 : 0);
    }
  });

  it("keeps a count only as far as the page shows it", () => {
    expect(readLaneRemote({ upstream: "origin/x", ahead: 5000, behind: 1000 })).toEqual({ upstream: "origin/x", ahead: COUNT_SHOWN + 1, behind: COUNT_SHOWN + 1 });
  });

  it("is nothing when it is not an object", () => {
    for (const bad of [null, undefined, 3, "x", []]) expect(readLaneRemote(bad), String(bad)).toBeNull();
  });
});

describe("a count over what is shown", () => {
  it("is shown with a plus: the shell stops counting at 1,000", () => {
    expect(countText(0)).toBe("0");
    expect(countText(999)).toBe("999");
    expect(countText(1000)).toBe("999+");
    expect(countText(1001)).toBe("999+");
  });
});

describe("what the row says", () => {
  const say = (r: Parameters<typeof syncWords>[0]) => syncWords(r);

  it("says how far ahead of the remote branch, how far behind, or both", () => {
    expect(say({ upstream: "origin/kit/x", ahead: 2, behind: 0 })).toEqual({ key: "lane.sync.ahead", vars: { n: "2", remote: "origin/kit/x" } });
    expect(say({ upstream: "origin/kit/x", ahead: 0, behind: 5 })).toEqual({ key: "lane.sync.behind", vars: { n: "5", remote: "origin/kit/x" } });
    expect(say({ upstream: "origin/kit/x", ahead: 2, behind: 1 })).toEqual({ key: "lane.sync.both", vars: { ahead: "2", behind: "1", remote: "origin/kit/x" } });
  });

  it("says level when a remote branch holds nothing more and lacks nothing", () => {
    expect(say({ upstream: "origin/kit/x", ahead: 0, behind: 0 })).toEqual({ key: "lane.sync.level", vars: { remote: "origin/kit/x" } });
  });

  it("says how many commits are not pushed for a branch no remote has, and nothing when there are none", () => {
    expect(say({ upstream: null, ahead: 3, behind: 0 })).toEqual({ key: "lane.sync.unpushed", vars: { n: "3" } });
    expect(say({ upstream: null, ahead: 0, behind: 0 })).toBeNull();
  });

  it("writes a long way ahead as 999+", () => {
    expect(say({ upstream: "origin/x", ahead: 1000, behind: 0 })?.vars).toEqual({ n: "999+", remote: "origin/x" });
  });
});
