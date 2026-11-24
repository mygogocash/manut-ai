// A key typed into the code: found in Kit's changes by the app's one masker (lib/secrets.ts), counted per file so a
// later change that takes it out clears it, and never shown. Every key here is plainly fake.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffView } from "../chat/activity/Work";
import type { DiffFile } from "../lib/protocol";
import { holdsKey, keysAfter, keyFiles } from "./secrets";

const FAKE_KEY = "sk-FAKE0000000000000000TEST";
const file = (path: string, lines: string[], kind: DiffFile["kind"] = "update"): DiffFile => ({
  path,
  kind,
  lines,
  added: lines.filter((l) => l.startsWith("+")).length,
  removed: lines.filter((l) => l.startsWith("-")).length,
});

describe("a key in a line", () => {
  it("is what the app's masker would hide", () => {
    expect(holdsKey(`const KEY = "${FAKE_KEY}";`)).toBe(true);
    expect(holdsKey("password=fake-password-123")).toBe(true);
    expect(holdsKey("export const SHOP_ID = process.env.PROMPTPAY_ID;")).toBe(false);
    expect(holdsKey("const total = order.items.reduce(sum, 0);")).toBe(false);
  });
});

describe("keys in Kit's changes", () => {
  const typed = file("src/config.ts", ["@@ -1,2 +1,3 @@", " export const CURRENCY = 'THB';", `+export const PROMPTPAY_KEY = "${FAKE_KEY}";`]);

  it("counts the keys a change adds, per file", () => {
    expect(keysAfter({}, [typed])).toEqual({ "src/config.ts": 1 });
    expect(keyFiles(keysAfter({}, [typed]))).toEqual(["src/config.ts"]);
  });

  it("clears a file once a later change takes the key out", () => {
    const moved = file("src/config.ts", ["@@ -1,3 +1,3 @@", `-export const PROMPTPAY_KEY = "${FAKE_KEY}";`, "+export const PROMPTPAY_KEY = process.env.PROMPTPAY_KEY;"]);
    expect(keysAfter(keysAfter({}, [typed]), [moved])).toEqual({});
  });

  it("clears a file that is deleted", () => {
    expect(keysAfter({ "src/config.ts": 2 }, [file("src/config.ts", [], "delete")])).toEqual({});
  });

  it("keeps other files as they were, and never counts below none", () => {
    const tidy = file("src/checkout.tsx", ["@@ -1 +1 @@", "-const a = 1;", "+const a = 2;"]);
    expect(keysAfter({ "src/config.ts": 1 }, [tidy])).toEqual({ "src/config.ts": 1 });
    const unrelated = file("src/old.ts", [`-const OLD = "${FAKE_KEY}";`]);
    expect(keysAfter({}, [unrelated])).toEqual({});
  });

  it("holds only file names and counts, never the key", () => {
    expect(JSON.stringify(keysAfter({}, [typed]))).not.toContain(FAKE_KEY);
  });
});

describe("a diff on screen", () => {
  it("shows no key, the rest of the line as it is", () => {
    const html = renderToString(createElement(DiffView, { files: [file("src/config.ts", [`+export const PROMPTPAY_KEY = "${FAKE_KEY}";`])] }));
    expect(html).not.toContain(FAKE_KEY);
    expect(html).toContain("export const PROMPTPAY_KEY = &quot;••••&quot;;");
  });
});
