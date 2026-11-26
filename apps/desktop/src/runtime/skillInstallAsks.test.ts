// The ask before skills from a link are installed (skillInstallAsks.ts, item 84): an approval-core request of kind `command` whose
// detail is the shell's own ask; its Yes is refused, and the shell hears nothing, until every file was opened or the tick is set;
// it settles once; and only a settled request reaches the shell, with its id and the answer alone.
import { beforeEach, describe, expect, it } from "vitest";
import type { InstallAsk, InstallDone } from "./skillBundle";
import { answerInstallAsk, installAskRecord, installReview, openInstallAsk, resetInstallAsks, withdrawInstallAsk } from "./skillInstallAsks";

const ASK: InstallAsk = { id: "ask-1", agent: "claude", folder: "~/.claude/skills", skills: [{ name: "promptpay", files: [{ path: "SKILL.md", bytes: 10 }, { path: "qr.sh", bytes: 12 }] }] };

function shell() {
  const calls: [string, boolean][] = [];
  const withdrawn: string[] = [];
  return {
    calls,
    withdrawn,
    skillInstallSettle: async (id: string, yes: boolean): Promise<InstallDone> => {
      calls.push([id, yes]);
      return yes ? { outcome: "installed", installed: ["promptpay"] } : { outcome: "declined", installed: [] };
    },
    skillInstallWithdraw: async (id: string) => void withdrawn.push(id),
  };
}

beforeEach(() => resetInstallAsks());

describe("asking before skills are installed", () => {
  it("is a command for the owner whose detail is the shell's ask, and whose yes waits for every file", async () => {
    const host = shell();
    await openInstallAsk(ASK);
    const record = await installAskRecord(ASK.id);
    expect(record?.request.kind).toBe("command");
    expect(record?.request.detail).toEqual(ASK);
    expect(await answerInstallAsk(host, ASK.id, true)).toEqual({ ok: false, refused: "not_reviewed" });
    installReview(ASK.id)!.open("promptpay/SKILL.md");
    expect(await answerInstallAsk(host, ASK.id, true)).toEqual({ ok: false, refused: "not_reviewed" });
    // the shell heard nothing while the files were not looked at
    expect(host.calls).toEqual([]);
    installReview(ASK.id)!.open("promptpay/qr.sh");
    expect(await answerInstallAsk(host, ASK.id, true)).toEqual({ ok: true, done: { outcome: "installed", installed: ["promptpay"] } });
    expect(host.calls).toEqual([["ask-1", true]]);
    // settled once
    expect((await answerInstallAsk(host, ASK.id, true)).ok).toBe(false);
    expect(host.calls).toHaveLength(1);
  });

  it("takes the tick, lets a no through with no review, and a withdrawn ask writes nothing", async () => {
    const host = shell();
    await openInstallAsk(ASK);
    expect(await answerInstallAsk(host, ASK.id, false)).toEqual({ ok: true, done: { outcome: "declined", installed: [] } });
    await openInstallAsk({ ...ASK, id: "ask-2" });
    installReview("ask-2")!.tick(true);
    await withdrawInstallAsk(host, "ask-2");
    expect(host.withdrawn).toEqual(["ask-2"]);
    expect((await answerInstallAsk(host, "ask-2", true)).ok).toBe(false);
    expect(host.calls).toEqual([["ask-1", false]]);
  });
});
