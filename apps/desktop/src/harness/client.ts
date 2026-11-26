// The one read this lane adds to the protocol: `runs.node_session` (read-only). Its own small runtime client,
// opened on first use and kept, so the session views never touch the store's client or its events.
import { createRuntime, type RuntimeAdapter } from "../runtime";
import type { NodeSessionResult } from "./session";

export type NodeSessionTarget =
  /** A node of a plan (dag run or delegate fan-out). */
  | { run: string; node: string }
  /** A child an earlier read named (`hermes:<id>`, `claude:<dir>/<id>`, `claude-sub:…`, `codex:<thread>`). */
  | { ref: string }
  /** A subagent row of the bot's own chat: its goal (or its `[dag:run/node]` mark) and when it started (epoch s). */
  | { goal: string; since?: number };

let client: RuntimeAdapter | null = null;

type Request = (op: string, params: Record<string, unknown>) => Promise<unknown>;

export async function nodeSession(bot: string, target: NodeSessionTarget): Promise<NodeSessionResult> {
  if (!client) client = createRuntime();
  await client.connect();
  const request = client.request.bind(client) as unknown as Request;
  return (await request("runs.node_session", { bot, ...target })) as NodeSessionResult;
}

/** Tests: drop the kept connection. */
export function closeNodeSessionClient(): void {
  client?.close();
  client = null;
}
