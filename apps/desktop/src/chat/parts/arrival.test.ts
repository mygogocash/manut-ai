import { describe, expect, it } from "vitest";
import { arrive, startArrival } from "./arrival";

const run = (ids: string[][], loaded = true, quiet?: (id: string) => boolean) => {
  let a = startArrival("kami");
  for (const step of ids) a = arrive(a, "kami", step, loaded, quiet);
  return a;
};

describe("which rows are new", () => {
  it("treats what is there when the chat opens as old", () => {
    expect([...run([["a", "b", "c"]]).fresh]).toEqual([]);
  });
  it("treats what is there when the history finishes loading as old", () => {
    let a = startArrival("kami");
    a = arrive(a, "kami", [], false);
    a = arrive(a, "kami", ["a", "b"], true);
    expect([...a.fresh]).toEqual([]);
    a = arrive(a, "kami", ["a", "b", "c"], true);
    expect([...a.fresh]).toEqual(["c"]);
  });
  it("marks a row added below the last one, and keeps it marked on a re-render", () => {
    const a = run([["a"], ["a", "b"], ["a", "b"], ["a", "b", "c"]]);
    expect([...a.fresh]).toEqual(["b", "c"]);
  });
  it("leaves history paged in above alone", () => {
    expect([...run([["c", "d"], ["a", "b", "c", "d"]]).fresh]).toEqual([]);
  });
  it("starts over for another chat", () => {
    let a = run([["a"], ["a", "b"]]);
    a = arrive(a, "friren", ["x", "y"], true);
    expect([...a.fresh]).toEqual([]);
  });
  it("keeps quiet rows still: a streamed answer, an error", () => {
    const a = run([["a"], ["a", "b", "c"]], true, (id) => id === "b");
    expect([...a.fresh]).toEqual(["c"]);
  });
  it("gives the same state for the same input", () => {
    const a = run([["a"], ["a", "b"]]);
    expect(arrive(a, "kami", ["a", "b"], true)).toBe(a);
  });
});
