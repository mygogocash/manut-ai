// How the phone reads an approval from the Mac (src/app/mac/wire.ts `readAsk`), item 117: the command whole with its line
// breaks, and a command the Mac marked too long for a phone never offers Allow once here, whatever the offers say.
import { describe, expect, it } from "vitest";
import { readAsk } from "../src/app/mac/wire";

const approval = (over: Record<string, unknown> = {}) => ({ kind: "approval", id: "r", revision: 1, open: true, ts: 1, title: "Run this command?", command: "pnpm test\ngit push origin main", offers: ["once", "deny"], ...over });

describe("an approval as the phone reads it", () => {
  it("keeps the command whole, its line breaks too", () => {
    expect(readAsk(approval())).toMatchObject({ command: "pnpm test\ngit push origin main", offers: ["once", "deny"] });
    expect(readAsk(approval())).not.toHaveProperty("long");
  });

  it("never offers Allow once for a command the Mac could not send whole", () => {
    expect(readAsk(approval({ long: true }))).toMatchObject({ long: true, offers: ["deny"] });
    // only `true` marks it: anything else is read as an ordinary command
    expect(readAsk(approval({ long: "yes" }))).not.toHaveProperty("long");
  });
});
