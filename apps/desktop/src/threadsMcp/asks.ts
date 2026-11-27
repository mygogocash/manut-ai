// The read, message and new-lane cards' asks for other programs (items 103c and 103d, `docs/mcp-threads.md`, rule M8): one approval-core request a
// card, opened and settled there once by approval-core's own rules (a request leaves waiting once, only an option it offered can be
// chosen, a request whose turn is not the one running is superseded). As 102k's `reachAsks.ts`, this file is the only place such a
// request is opened, decided or withdrawn, and nothing a program sends reaches it: the relay and the door have no verb for it.
//
// A card's turn is its call: the request is stamped with the call's id, and a decision is given the call's id as what runs only
// while the call is open, so a press after the program gave up is refused as superseded. The kind is `command`, as 102k's: reading
// a chat out to another program and putting words into a chat change what runs here, which only the owner decides; on this Mac
// the person is the owner of their own chats.
import { InMemoryApprovalStore, type ApprovalOption, type DecideResult } from "@manut/approval-core";

export type McpAskKind = "read" | "send" | "open";

/** What each card offers: its one yes, and its no. */
export const MCP_OPTIONS: Record<McpAskKind, readonly ApprovalOption[]> = {
  read: [
    { id: "read", label: "let it read", effect: "approve" },
    { id: "no", label: "no", effect: "decline" },
  ],
  send: [
    { id: "send", label: "send there", effect: "approve" },
    { id: "keep", label: "keep out", effect: "decline" },
  ],
  open: [
    { id: "start", label: "start lane", effect: "approve" },
    { id: "notNow", label: "not now", effect: "decline" },
  ],
};

/** Who decides on this Mac, as approval-core records it (102k's own). */
export const DECIDED_BY = "this-mac";

let store = new InMemoryApprovalStore();

/** Tests: start from no asks. */
export function resetMcpAsks(): void {
  store = new InMemoryApprovalStore();
}

/** Opens card `id`'s request, its turn the call itself. Throws when approval-core refuses it (an id already used). */
export async function openMcpAsk(id: string, kind: McpAskKind, detail: unknown): Promise<void> {
  const opened = await store.open({ id, kind: "command", options: MCP_OPTIONS[kind], turnId: id, detail });
  if (!opened.ok) throw new Error(opened.refused);
}

/** The person's yes or no on card `id`. `open` says whether its call still waits: only then is it the turn that runs. Only an
 *  `ok` result settled the request. */
export function answerMcpAsk(id: string, kind: McpAskKind, yes: boolean, open: boolean): Promise<DecideResult> {
  const [approve, decline] = MCP_OPTIONS[kind];
  return store.decide({ requestId: id, optionId: yes ? approve.id : decline.id, seenRevision: 1, decidedBy: DECIDED_BY, role: "owner" }, { running: { turnId: open ? id : null } });
}

/** The call is gone: its request is taken back, so a later press settles nothing. */
export async function withdrawMcpAsk(id: string): Promise<void> {
  await store.withdraw(id);
}

/** Where the request stands in approval-core (tests). */
export const mcpAskRecord = (id: string) => store.get(id);
