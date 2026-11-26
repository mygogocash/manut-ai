import { describe, expect, it } from "vitest";
import { errText } from "./errText";

describe("errText", () => {
  it("says the message of an Error or a refusal, and the value of anything else", () => {
    expect(errText(new Error("no"))).toBe("no");
    expect(errText({ message: "refused" })).toBe("refused");
    expect(errText("plain")).toBe("plain");
    expect(errText(null)).toBe("null");
    expect(errText(42)).toBe("42");
    expect(errText({})).toBe("[object Object]");
  });
});
