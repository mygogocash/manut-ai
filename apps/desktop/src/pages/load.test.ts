// What a page knows about data it asked the runtime for: still waiting, there, or refused. A refusal keeps the
// runtime's own code and words, so a page can say "not yet" in the connected runtime's own sentence.
import { describe, expect, it } from "vitest";
import { load, LOADING } from "./load";

describe("what a page knows about what it asked for", () => {
  it("starts loading", () => {
    expect(LOADING).toEqual({ kind: "loading" });
  });

  it("is ready with the answer", async () => {
    expect(await load(async () => ({ jobs: [] }))).toEqual({ kind: "ready", value: { jobs: [] } });
  });

  it("is unavailable with the runtime's own code and words when it refuses", async () => {
    expect(await load(() => Promise.reject({ code: "not_yet", message: "Not yet: Connected mode cannot show this." }))).toEqual({
      kind: "unavailable",
      code: "not_yet",
      message: "Not yet: Connected mode cannot show this.",
    });
  });

  it("is unavailable as an internal error when what failed was not a refusal", async () => {
    expect(await load(() => Promise.reject(new Error("boom")))).toEqual({ kind: "unavailable", code: "internal", message: "boom" });
    expect(await load(() => Promise.reject("plain text"))).toEqual({ kind: "unavailable", code: "internal", message: "plain text" });
  });
});
