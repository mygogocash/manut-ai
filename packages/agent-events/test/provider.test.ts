import { describe, expect, it } from "vitest";
import { decodeModelOption, decodeSessionFeatures, decodeSlashCommand, sortEfforts } from "../src/index";

/// The reasoning ladder reads cheapest first whatever order a provider lists it in. Ported from
/// GoSpark's `Tests/EffortOrderTests.swift`, case for case. Left out: `providerLadders`, which
/// reads two CLI adapters' own level lists, and `modelOptionSortsEveryPath`, which is about
/// Swift's memberwise initializer and property observer (here an option is only ever decoded).
describe("EffortOrderTests", () => {
  it("descendingLadder: a ladder the provider listed from the top comes back cheapest first", () => {
    expect(sortEfforts(["xhigh", "high", "medium", "low"])).toEqual(["low", "medium", "high", "xhigh"]);
    expect(sortEfforts(["max", "high", "medium", "minimal"])).toEqual(["minimal", "medium", "high", "max"]);
  });

  it("ascendingLadder: a list that already counts up is handed back untouched", () => {
    const ladder = ["minimal", "low", "medium", "high", "xhigh", "max"];
    expect(sortEfforts(ladder)).toEqual(ladder);
  });

  it("tiedSpellings: the two spellings of the rung below max keep the order the provider sent", () => {
    expect(sortEfforts(["max", "extra-high", "xhigh"])).toEqual(["extra-high", "xhigh", "max"]);
    expect(sortEfforts(["max", "xhigh", "extra-high"])).toEqual(["xhigh", "extra-high", "max"]);
  });

  it("unknownRungs: an unknown rung sorts above the ladder and keeps its place among strangers", () => {
    expect(sortEfforts(["max", "reasoning", "low"])).toEqual(["low", "max", "reasoning"]);
    expect(sortEfforts(["alpha", "beta", "max"])).toEqual(["max", "alpha", "beta"]);
  });

  it("modeNames: levels named as modes are not shuffled into a ladder they never meant", () => {
    const modes = ["fast", "balanced", "thorough"];
    expect(sortEfforts(modes)).toEqual(modes);
  });

  it("noReasoningRungs: the spellings of no reasoning at all sit below minimal, not above max", () => {
    expect(sortEfforts(["xhigh", "high", "medium", "low", "minimal", "off"])).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(sortEfforts(["xhigh", "high", "medium", "low", "none"])).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });

  it("nothingDropped: nothing is dropped, whatever the list holds", () => {
    const efforts = ["xhigh", "custom", "low", "extra-high", "high"];
    const sorted = sortEfforts(efforts);
    expect(sorted.length).toBe(efforts.length);
    expect(new Set(sorted)).toEqual(new Set(efforts));
  });

  it("casing: a rung is ranked whatever its case", () => {
    expect(sortEfforts(["XHigh", "low"])).toEqual(["low", "XHigh"]);
  });

  it("degenerateLists: an empty or single-entry list is handed straight back", () => {
    expect(sortEfforts([])).toEqual([]);
    expect(sortEfforts(["high"])).toEqual(["high"]);
  });

  it("a level named after something every object has is a stranger like any other", () => {
    expect(sortEfforts(["constructor", "max", "toString", "low"])).toEqual(["low", "max", "constructor", "toString"]);
  });

  it("decodingSorts: a catalogue cached before this order existed decodes into it", () => {
    const decoded = decodeModelOption({ id: "muse", name: "Muse", efforts: ["xhigh", "high", "low"] });
    expect(decoded).toStrictEqual({ id: "muse", name: "Muse", efforts: ["low", "high", "xhigh"], isDefault: false });
  });
});

describe("a model option", () => {
  it("needs its id and its name, and tolerates everything else", () => {
    expect(decodeModelOption({ name: "Nameless" })).toBeUndefined();
    expect(decodeModelOption({ id: "m" })).toBeUndefined();
    expect(decodeModelOption("m")).toBeUndefined();
    expect(decodeModelOption({ id: "m", name: "M", detail: 7, efforts: "high", isDefault: "yes", contextWindow: "big", supportsTools: 1 })).toStrictEqual({
      id: "m",
      name: "M",
      efforts: [],
      isDefault: false,
    });
    expect(decodeModelOption({ id: "m", name: "M", fastTier: "priority", contextWindow: 200_000, supportsTools: false, defaultEffort: "low" })).toStrictEqual({
      id: "m",
      name: "M",
      efforts: [],
      defaultEffort: "low",
      isDefault: false,
      fastTier: "priority",
      contextWindow: 200_000,
      supportsTools: false,
    });
  });
});

describe("a slash command", () => {
  it("needs a name", () => {
    expect(decodeSlashCommand({ detail: "No name" })).toBeUndefined();
    expect(decodeSlashCommand({ name: "" })).toBeUndefined();
    expect(decodeSlashCommand({ name: "compact" })).toStrictEqual({ name: "compact", detail: "", isBuiltIn: false });
  });
});

describe("session features", () => {
  it("read as a session that cannot report when a field is missing: nothing offered, the keyword trigger on", () => {
    expect(decodeSessionFeatures({})).toStrictEqual({
      readsSettings: false,
      ultracodeAvailable: false,
      ultracodeRequested: false,
      ultracodeActive: false,
      keywordTriggerEnabled: true,
    });
    expect(decodeSessionFeatures(null)).toBeUndefined();
  });
});
