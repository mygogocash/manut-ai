import { describe, expect, it } from "vitest";
import { moved } from "./flip";

describe("moved", () => {
  it("reports the rows that changed place, by how far they must travel back", () => {
    const m = moved(new Map([["a", 0], ["b", 40], ["c", 80]]), new Map([["b", 0], ["a", 40], ["c", 80]]));
    expect(m.get("a")).toBe(-40);
    expect(m.get("b")).toBe(40);
    expect(m.has("c")).toBe(false);
  });
  it("leaves a new row alone and ignores a sub-pixel change", () => {
    expect(moved(new Map([["a", 0]]), new Map([["a", 0.4], ["n", 40]])).size).toBe(0);
  });
});
