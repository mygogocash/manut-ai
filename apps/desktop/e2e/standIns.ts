// One stand-in per Playwright worker (item 129). A stand-in is the mock bridge (mock-bridge.mjs), which holds state
// that a spec file reads back (the calls log, the running turn, open asks), and the app's dev server, which has the
// bridge's address written in when it starts (VITE_MANUT_BRIDGE). Spec files that ran against one bridge at once would
// read each other's calls, so each worker gets a bridge and a dev server of its own, and runs whole spec files on them
// one after another, as the single worker did before.
//
// Worker i (Playwright's parallelIndex, 0 to workers - 1, which a worker started again after a failure keeps) uses the
// base ports plus 2i: with the defaults, worker 0 is 5307 and 5308 as before, worker 1 is 5309 and 5310, and so on. The
// base ports are MANUT_PORT and MANUT_MOCK_PORT, so a dag node or a helper that chose its own keeps the block above them.
// playwright.config.ts starts every stand-in and gives each worker its own ports; this file only works them out.

/** One worker's stand-in: the dev server's port and the mock bridge's. */
export type StandIn = { index: number; app: number; mock: number };

/** The number of workers, and so of stand-ins, from MANUT_E2E_WORKERS: 1 when it is unset, as on a person's machine,
 *  where several dev servers and browsers at once would only crowd it. */
export function workerCount(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error(`MANUT_E2E_WORKERS must be a whole number from 1 to 16, not "${value}"`);
  return n;
}

/** Every worker's stand-in, from the base ports. Two stand-ins never share a port: ports that would (a dev server's
 *  port landing on another worker's bridge) are refused, with the reason. */
export function standIns(base: { app: number; mock: number }, workers: number): StandIn[] {
  for (const [name, port] of [["MANUT_PORT", base.app], ["MANUT_MOCK_PORT", base.mock]] as const) {
    if (!Number.isInteger(port) || port < 1024 || port + 2 * (workers - 1) > 65535) throw new Error(`${name} must be a port from 1024 up with room for ${workers} workers above it, not ${port}`);
  }
  const all = Array.from({ length: workers }, (_, index) => ({ index, app: base.app + 2 * index, mock: base.mock + 2 * index }));
  const ports = all.flatMap((s) => [s.app, s.mock]);
  if (new Set(ports).size !== ports.length) {
    throw new Error(`MANUT_PORT ${base.app} and MANUT_MOCK_PORT ${base.mock} give ${workers} workers overlapping ports (each worker takes the next two): choose ports one apart, as 5307 and 5308`);
  }
  return all;
}

/** This process's stand-in: a worker's own, by its parallelIndex (TEST_PARALLEL_INDEX), or the first in the runner,
 *  which starts the servers and runs no test. A worker beyond the stand-ins (`--workers` set higher than
 *  MANUT_E2E_WORKERS) is refused, because it would have no bridge of its own. */
export function ownStandIn(all: readonly StandIn[], parallelIndex: string | undefined): StandIn {
  if (parallelIndex === undefined) return all[0];
  const i = Number(parallelIndex);
  const own = all[i];
  if (!Number.isInteger(i) || !own) throw new Error(`worker ${parallelIndex} has no stand-in: there are ${all.length}. Set MANUT_E2E_WORKERS instead of --workers`);
  return own;
}
