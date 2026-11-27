// The browser specs' stand-ins (e2e/standIns.ts, item 129): one mock bridge and dev server per Playwright worker, on
// ports worked out from the base ones, never shared, and one worker when nothing asks for more, as on a person's Mac.
// e2e/stand-ins.spec.ts checks the same from inside each worker of a real run.
import { describe, expect, it } from "vitest";
import { ownStandIn, standIns, workerCount } from "../e2e/standIns";

describe("the number of workers", () => {
  it("is one when MANUT_E2E_WORKERS is unset or empty", () => {
    expect(workerCount(undefined)).toBe(1);
    expect(workerCount("")).toBe(1);
  });

  it("is the number it names", () => {
    expect(workerCount("4")).toBe(4);
  });

  it.each(["0", "-1", "2.5", "four", "17"])("refuses %s", (value) => {
    expect(() => workerCount(value)).toThrow(/MANUT_E2E_WORKERS/);
  });
});

describe("each worker's ports", () => {
  it("keeps the base ports for the first worker, so one worker runs as before", () => {
    expect(standIns({ app: 5307, mock: 5308 }, 1)).toEqual([{ index: 0, app: 5307, mock: 5308 }]);
  });

  it("gives each further worker the next two ports", () => {
    expect(standIns({ app: 5307, mock: 5308 }, 3)).toEqual([
      { index: 0, app: 5307, mock: 5308 },
      { index: 1, app: 5309, mock: 5310 },
      { index: 2, app: 5311, mock: 5312 },
    ]);
  });

  it("never lets two stand-ins share a port", () => {
    for (const workers of [1, 2, 4, 8, 16]) {
      const ports = standIns({ app: 5989, mock: 5990 }, workers).flatMap((s) => [s.app, s.mock]);
      expect(new Set(ports).size).toBe(2 * workers);
    }
  });

  it("refuses base ports whose blocks would overlap, and says how to choose them", () => {
    expect(() => standIns({ app: 5307, mock: 5309 }, 2)).toThrow(/one apart/);
    // one worker has no neighbour to collide with
    expect(standIns({ app: 5307, mock: 5309 }, 1)).toHaveLength(1);
  });

  it("refuses a port that is not a usable number", () => {
    expect(() => standIns({ app: Number("x"), mock: 5308 }, 1)).toThrow(/MANUT_PORT/);
    expect(() => standIns({ app: 5307, mock: 65535 }, 2)).toThrow(/MANUT_MOCK_PORT/);
  });
});

describe("this process's stand-in", () => {
  const all = standIns({ app: 5307, mock: 5308 }, 2);

  it("is the first in the runner, which starts the servers and runs no test", () => {
    expect(ownStandIn(all, undefined)).toEqual(all[0]);
  });

  it("is a worker's own, by its parallelIndex", () => {
    expect(ownStandIn(all, "1")).toEqual(all[1]);
  });

  it("refuses a worker beyond the stand-ins, as --workers set higher than MANUT_E2E_WORKERS would start", () => {
    expect(() => ownStandIn(all, "2")).toThrow(/MANUT_E2E_WORKERS instead of --workers/);
  });
});
