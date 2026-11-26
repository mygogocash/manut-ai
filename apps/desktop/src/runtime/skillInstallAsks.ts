// The ask before skills from a link are installed (item 84), on the page's side, as code/reviewAsk.ts is for a push. The shell
// writes down the exact install (src-tauri/src/skill_links.rs: the bundle it fetched, the skills chosen, the agent's own skills
// folder) and answers it as an ask; this file opens that ask as an approval-core request and settles it there, once, by
// approval-core's own rules. Only a request approval-core settled reaches the shell's `skill_install_settle`, which writes on a Yes,
// once, by the ask's id alone. The host has no call that takes a file to write.
//
// The request's kind is `command`: an install changes what a coding agent on this Mac does, which only the owner decides. Its Yes
// is refused here (`not_reviewed`, the ask still waiting) until every file it would write was opened or the person ticked that they
// looked at every file (fileReview.ts).
import { InMemoryApprovalStore, type ApprovalOption } from "@manut/approval-core";
import type { SessionHost } from "../sessions/host";
import { FileReview } from "./fileReview";
import type { InstallAsk, InstallDone } from "./skillBundle";

export const INSTALL_OPTIONS: readonly ApprovalOption[] = [
  { id: "yes", label: "yes", effect: "approve" },
  { id: "no", label: "no", effect: "decline" },
];

export const DECIDED_BY = "this-mac";

let store = new InMemoryApprovalStore();
let reviews = new Map<string, FileReview>();

/** Tests: start from no asks. */
export function resetInstallAsks(): void {
  store = new InMemoryApprovalStore();
  reviews = new Map();
}

/** Opens the shell's ask as an approval-core request whose detail is the ask as the shell wrote it, and starts its record of the
 *  files looked at. */
export async function openInstallAsk(ask: InstallAsk): Promise<void> {
  const opened = await store.open({ id: ask.id, kind: "command", options: INSTALL_OPTIONS, detail: ask });
  if (!opened.ok) throw new Error(opened.refused);
  reviews.set(ask.id, new FileReview(ask.skills.flatMap((s) => s.files.map((f) => `${s.name}/${f.path}`))));
}

/** The record of what was looked at for install ask `id`. */
export const installReview = (id: string): FileReview | null => reviews.get(id) ?? null;

export type InstallAnswer = { ok: true; done: InstallDone } | { ok: false; refused: string };

/** The person's Yes or No to install ask `id`. A Yes before every file was looked at settles nothing. approval-core settles the
 *  request next; a refusal there stops here and the shell hears nothing. */
export async function answerInstallAsk(host: Pick<SessionHost, "skillInstallSettle">, id: string, yes: boolean): Promise<InstallAnswer> {
  if (yes && !reviews.get(id)?.done) return { ok: false, refused: "not_reviewed" };
  const decided = await store.decide({ requestId: id, optionId: yes ? "yes" : "no", seenRevision: 1, decidedBy: DECIDED_BY, role: "owner" }, { running: {} });
  if (!decided.ok) return { ok: false, refused: decided.refused };
  if (!host.skillInstallSettle) return { ok: false, refused: "no_shell" };
  try {
    return { ok: true, done: await host.skillInstallSettle(id, yes) };
  } catch (e) {
    return { ok: false, refused: e instanceof Error ? e.message : String(e) };
  }
}

/** Takes a waiting ask back on both sides, so a later answer writes nothing. */
export async function withdrawInstallAsk(host: Pick<SessionHost, "skillInstallWithdraw">, id: string): Promise<void> {
  await store.withdraw(id);
  await host.skillInstallWithdraw?.(id).catch(() => undefined);
}

export const installAskRecord = (id: string) => store.get(id);
