// Whether this page may make a sound. Unit tests, Playwright runs and a page with no AudioContext never do.
//
// Every player asks here first, before it makes an AudioContext, renders or fetches anything, so a silenced sound never
// reaches the audio system at all (the way GoSpark's `SoundGate` keeps its test runs quiet: on a machine with no audio
// service a played sound can hold a whole run up). A new player must ask too; `gate.test.ts` calls each one and counts it.

/** How many sounds this page has kept quiet, so a test can see a sound reach the gate instead of assuming it did. */
let silenced = 0;
/** A test's own answer, in place of the page's. Null: ask the page. */
let override: boolean | null = null;

/** A Playwright spec that swaps in a counting stand-in for AudioContext says so here, since a stand-in cannot make a sound. */
export const FAKE_AUDIO_FLAG = "__manutFakeAudio";

/** What the gate looks at: the build mode, whether a driver controls the browser, whether a spec declared a stand-in
 *  AudioContext, and whether the page has an AudioContext at all. */
export interface GateEnv {
  mode: string | undefined;
  webdriver: boolean;
  fakeAudio: boolean;
  hasAudio: boolean;
}

/** The rule, pure. A sound may play only outside tests (vitest's mode is "test"), outside a driven browser unless its
 *  AudioContext is a counting stand-in (which cannot make a sound), and where an AudioContext exists. */
export function gateOpen(env: GateEnv): boolean {
  if (env.mode === "test") return false;
  if (env.webdriver && !env.fakeAudio) return false;
  return env.hasAudio;
}

function pageEnv(): GateEnv {
  const g = globalThis as unknown as { navigator?: { webdriver?: boolean }; AudioContext?: unknown; webkitAudioContext?: unknown } & Record<string, unknown>;
  return {
    mode: import.meta.env?.MODE,
    webdriver: g.navigator?.webdriver === true,
    fakeAudio: g[FAKE_AUDIO_FLAG] === true,
    hasAudio: typeof g.AudioContext === "function" || typeof g.webkitAudioContext === "function",
  };
}

/** Whether a sound may play now. Counts each refusal. */
export function allowsSound(): boolean {
  const ok = override ?? gateOpen(pageEnv());
  if (!ok) silenced += 1;
  return ok;
}

/** How many sounds the gate has refused. */
export const silencedCount = (): number => silenced;

/** For tests: open or close the gate whatever the page is (null: back to asking the page), and count from zero. */
export function setGateForTests(open: boolean | null): void {
  override = open;
  silenced = 0;
}
