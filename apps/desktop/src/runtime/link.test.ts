// What the app says about the runtime it runs on: the quiet mode line above the account row, and whether Settings ›
// Developer must offer a restart for a choice saved since the start.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../i18n";
import { leavesShop, modeLine, pendingRestart, readTime, saveRuntimeChoice } from "./link";

const CONNECTED = { mode: "connected", origin: "https://dev.manut.xyz" } as const;
const text = (v: ReturnType<typeof modeLine>) => (v ? t(v.key, v.vars) : null);

afterEach(() => setLang("en"));

describe("the mode line", () => {
  it("says Practice mode for the demo runtime, never a host", () => {
    expect(text(modeLine({ mode: "practice" }, "mock", null))).toBe("Practice mode");
  });

  it("names the host it is connected to, and says plainly when it is not", () => {
    expect(text(modeLine(CONNECTED, "http", "open"))).toBe("Connected to dev.manut.xyz");
    expect(text(modeLine(CONNECTED, "http", "connecting"))).toBe("Connecting to dev.manut.xyz…");
    expect(text(modeLine(CONNECTED, "http", "signed_out"))).toBe("Signed out · dev.manut.xyz");
    expect(text(modeLine(CONNECTED, "http", "offline"))).toBe("Offline · dev.manut.xyz");
    expect(text(modeLine(CONNECTED, "http", "unavailable"))).toBe("Not answering · dev.manut.xyz");
    expect(text(modeLine({ mode: "connected", origin: "http://localhost:8787" }, "http", "open"))).toBe("Connected to localhost:8787");
  });

  it("says nothing when a WebSocket runtime was configured on purpose (the e2e suite), which is neither", () => {
    expect(modeLine({ mode: "practice" }, "websocket", null)).toBeNull();
    expect(modeLine(CONNECTED, "websocket", null)).toBeNull();
  });

  it("speaks the app's language", () => {
    setLang("ja");
    expect(text(modeLine({ mode: "practice" }, "mock", null))).toBe("練習モード");
    expect(text(modeLine(CONNECTED, "http", "offline"))).toBe("オフライン · dev.manut.xyz");
  });
});

describe("a restart to apply", () => {
  it("is needed only when the saved choice is not the one running", () => {
    expect(pendingRestart({ mode: "practice" }, { mode: "practice" })).toBe(false);
    expect(pendingRestart(CONNECTED, { mode: "practice" })).toBe(true);
    expect(pendingRestart({ mode: "practice" }, CONNECTED)).toBe(true);
    expect(pendingRestart(CONNECTED, CONNECTED)).toBe(false);
    expect(pendingRestart({ mode: "connected", origin: "https://staging.manut.xyz" }, CONNECTED)).toBe(true);
  });
});

describe("the mode line while the API cannot be reached", () => {
  // 14:05 on 23 Nov, this computer's time, whatever zone it is in
  const at = new Date(2026, 10, 23, 14, 5).getTime();
  const later = new Date(2026, 10, 23, 16, 0).getTime();
  const line = (link: "offline" | "unavailable", cache: Parameters<typeof modeLine>[3], now = later) => text(modeLine(CONNECTED, "http", link, cache, now));

  it("says what is shown and when it was read, quietly", () => {
    expect(line("offline", { kind: "showing", at })).toBe("Offline. Showing what was here at 14:05");
    expect(line("unavailable", { kind: "showing", at })).toBe("Not answering. Showing what was here at 14:05");
  });

  it("puts the day first when the read was made on another day", () => {
    const yesterday = new Date(2026, 10, 22, 14, 5).getTime();
    expect(line("offline", { kind: "showing", at: yesterday })).toBe("Offline. Showing what was here at Nov 22 14:05");
    expect(readTime(at, later)).toBe("14:05");
    expect(readTime(yesterday, later)).toBe("Nov 22 14:05");
    // a read from just before midnight is another day's at a quarter past
    expect(readTime(new Date(2026, 10, 22, 23, 50).getTime(), new Date(2026, 10, 23, 0, 15).getTime())).toBe("Nov 22 23:50");
  });

  it("says a read older than 7 days is not shown, instead of showing it", () => {
    const old = new Date(2026, 10, 10, 9, 0).getTime();
    expect(line("offline", { kind: "too_old", at: old })).toBe("Offline. The saved copy is more than 7 days old, so it is not shown");
    expect(line("unavailable", { kind: "too_old", at: old })).toBe("Not answering. The saved copy is more than 7 days old, so it is not shown");
  });

  it("says there is no saved copy on a computer with no keychain to lock one, rather than show one kept plain", () => {
    expect(line("offline", { kind: "unkept" })).toBe("Offline. This computer cannot keep a saved copy yet, so none is shown");
    expect(line("unavailable", { kind: "unkept" })).toBe("Not answering. This computer cannot keep a saved copy yet, so none is shown");
    // only while the API cannot be reached, as every other line about the copy
    for (const link of ["open", "connecting", "signed_out"] as const) {
      expect(text(modeLine(CONNECTED, "http", link, { kind: "unkept" }, later)), link).toBe(text(modeLine(CONNECTED, "http", link)));
    }
    setLang("ja");
    expect(line("offline", { kind: "unkept" })).toBe("オフライン。このコンピューターはまだコピーを保存できないため、表示できる内容がありません");
    setLang("ko");
    expect(line("unavailable", { kind: "unkept" })).toBe("응답 없음. 이 컴퓨터는 아직 사본을 저장할 수 없어서 보여 줄 내용이 없어요");
    setLang("zh");
    expect(line("offline", { kind: "unkept" })).toBe("离线。这台电脑还不能保存副本，因此没有可显示的内容");
  });

  it("says what it said before when nothing was kept, or the cache is not in play", () => {
    expect(line("offline", { kind: "none" })).toBe("Offline · dev.manut.xyz");
    expect(line("unavailable", null)).toBe("Not answering · dev.manut.xyz");
    for (const link of ["open", "connecting", "signed_out"] as const) {
      expect(text(modeLine(CONNECTED, "http", link, { kind: "showing", at }, later)), link).toBe(text(modeLine(CONNECTED, "http", link)));
    }
    expect(text(modeLine({ mode: "practice" }, "mock", null, { kind: "showing", at }))).toBe("Practice mode");
  });

  it("speaks the app's language, with the time in its own form", () => {
    setLang("ko");
    expect(line("offline", { kind: "showing", at })).toBe("오프라인. 14:05에 있던 내용을 보여 주고 있어요");
    setLang("ja");
    expect(line("offline", { kind: "showing", at })).toBe("オフライン。14:05 時点の内容を表示しています");
    expect(line("unavailable", { kind: "too_old", at })).toBe("応答なし。保存したコピーは7日より古いため表示しません");
    setLang("zh");
    expect(line("offline", { kind: "showing", at })).toBe("离线。显示的是 14:05 时的内容");
    expect(line("offline", { kind: "too_old", at })).toBe("离线。已保存的副本超过 7 天，因此不再显示");
  });
});

describe("saving the runtime choice", () => {
  const STAGING = { mode: "connected", origin: "https://staging.manut.xyz" } as const;
  const PRACTICE = { mode: "practice" } as const;

  function save(was: Parameters<typeof saveRuntimeChoice>[0], next: Parameters<typeof saveRuntimeChoice>[1]) {
    const log: string[] = [];
    saveRuntimeChoice(was, next, {
      write: (s) => void log.push(`write ${s.mode}`),
      forget: () => void log.push("forget"),
    });
    return log;
  }

  it("forgets the saved read of the shop when the choice leaves it: for Practice, or for another origin", () => {
    expect(leavesShop(CONNECTED, PRACTICE)).toBe(true);
    expect(leavesShop(CONNECTED, STAGING)).toBe(true);
    // the new choice is written first, so what keeps the read (the saved choice) already says to stop when it is removed
    expect(save(CONNECTED, PRACTICE)).toEqual(["write practice", "forget"]);
    expect(save(CONNECTED, STAGING)).toEqual(["write connected", "forget"]);
  });

  it("keeps it when the choice stays on the shop, or when no shop was chosen before", () => {
    expect(leavesShop(CONNECTED, CONNECTED)).toBe(false);
    expect(leavesShop(PRACTICE, PRACTICE)).toBe(false);
    expect(leavesShop(PRACTICE, CONNECTED)).toBe(false);
    expect(save(CONNECTED, CONNECTED)).toEqual(["write connected"]);
    expect(save(PRACTICE, CONNECTED)).toEqual(["write connected"]);
    expect(save(PRACTICE, PRACTICE)).toEqual(["write practice"]);
  });

  it("forgets nothing when the choice could not be saved", () => {
    const log: string[] = [];
    const refuse = () => {
      throw new Error("not an API origin");
    };
    expect(() => saveRuntimeChoice(CONNECTED, PRACTICE, { write: refuse, forget: () => void log.push("forget") })).toThrow();
    expect(log).toEqual([]);
  });
});

describe("saving the choice has one way", () => {
  it("is through saveRuntimeChoice alone: no other file writes the saved choice, so no switch skips forgetting the read", () => {
    const here = join(__dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    const writers = walk(here)
      .filter((f) => /\bwriteRuntimeSetting\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(here, f))
      .sort();
    // only its definition: saveRuntimeChoice hands it on as its default writer without calling it itself
    expect(writers).toEqual(["runtime/setting.ts"]);
  });
});
