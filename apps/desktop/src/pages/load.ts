// What a page knows about data it asked the runtime for: still waiting, there, or refused. A refusal keeps the runtime's
// own code and words, so the connected runtime's "Not yet" reaches the page in its own sentence. The jobs, the activity
// log and the pause page all read this way, and a page that gets nothing draws its unavailable state, never a guess.
import { isBridgeError } from "../lib/protocol";

export type Load<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "unavailable"; code: string; message: string };

export const LOADING: Load<never> = { kind: "loading" };

/** A failed request as a page shows it: the runtime's refusal as sent, or any other failure as an internal one. */
export function unavailable(e: unknown): Load<never> {
  if (isBridgeError(e)) return { kind: "unavailable", code: e.code, message: typeof e.message === "string" && e.message ? e.message : e.code };
  return { kind: "unavailable", code: "internal", message: e instanceof Error ? e.message : String(e) };
}

/** Asks, and says how it went. */
export async function load<T>(ask: () => Promise<T>): Promise<Load<T>> {
  try {
    return { kind: "ready", value: await ask() };
  } catch (e) {
    return unavailable(e);
  }
}
