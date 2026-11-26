import { describe, expect, it } from "vitest";
import { pad } from "./pad";

describe("pad", () => {
  it("fills with zeros to two places, or to the width asked for", () => {
    expect(pad(7)).toBe("07");
    expect(pad(12)).toBe("12");
    expect(pad(123)).toBe("123");
    expect(pad(7, 4)).toBe("0007");
  });
});
