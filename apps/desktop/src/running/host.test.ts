import { describe, expect, it } from "vitest";
import shellRows from "../../src-tauri/tests/fixtures/running-rows.json";
import { MockRunningHost, TauriRunningHost, readRow } from "./host";
import type { RunningRow } from "./model";

const good = { kind: "pty", session: 3, folder: "/home/you/code/app", pid: 4242, started: 1_700_000_000_000, argv: ["pnpm", "dev"], ports: [3000, 24678] };
const row = (o: Partial<RunningRow> = {}): RunningRow => ({ ...good, kind: "pty" as const, ...o });

describe("a row from the shell", () => {
  it("is read whole from the file the shell's own test writes it to, so neither side changes the shape alone", () => {
    // src-tauri/src/running.rs (`a_row_is_the_json_the_page_reads`) checks the shell's rows against this same file
    expect(shellRows).toHaveLength(2);
    expect(shellRows.flatMap(readRow)).toEqual(shellRows);
    expect(shellRows[1].started).toBeNull();
  });

  it("is read whole, a missing start as unknown", () => {
    expect(readRow(good)).toEqual([row()]);
    expect(readRow({ ...good, started: null })).toEqual([row({ started: null })]);
    const { started: _gone, ...noStart } = good;
    expect(readRow(noStart)).toEqual([row({ started: null })]);
    expect(readRow({ ...good, kind: "chat", ports: [] })).toEqual([row({ kind: "chat", ports: [] })]);
  });

  it("is dropped when any part is not what it should be", () => {
    for (const bad of [
      null,
      "row",
      [],
      { ...good, kind: "tab" },
      { ...good, session: "3" },
      { ...good, folder: 3 },
      { ...good, pid: "4242" },
      { ...good, pid: Number.NaN },
      { ...good, started: "yesterday" },
      { ...good, argv: ["pnpm", 3] },
      { ...good, argv: "pnpm dev" },
      { ...good, ports: [0] },
      { ...good, ports: [70_000] },
      { ...good, ports: ["3000"] },
      { ...good, ports: 3000 },
    ]) {
      expect(readRow(bad), JSON.stringify(bad)).toEqual([]);
    }
  });
});

/** The shell's bridge stood in by a function, recording what the page invoked. */
class Bridged extends TauriRunningHost {
  calls: { cmd: string; args?: unknown }[] = [];
  constructor(private answer: (cmd: string) => unknown) {
    super();
  }
  protected override async core() {
    return {
      invoke: async (cmd: string, args?: unknown) => {
        this.calls.push({ cmd, args });
        const a = this.answer(cmd);
        if (a instanceof Error) throw a;
        return a as never;
      },
    };
  }
}

describe("the shell's host", () => {
  it("asks for the list and reads each row, dropping one it cannot read", async () => {
    const h = new Bridged(() => [good, { ...good, pid: "x" }, { ...good, pid: 7, ports: [] }]);
    expect((await h.list())?.map((r) => r.pid)).toEqual([4242, 7]);
    expect(h.calls).toEqual([{ cmd: "running_list", args: undefined }]);
  });

  it("answers null where this computer cannot say, and passes on any other failure", async () => {
    expect(await new Bridged(() => new Error("unsupported")).list()).toBeNull();
    expect(await new Bridged(() => new Error("Command running_list not found")).list()).toBeNull();
    await expect(new Bridged(() => new Error("the list is locked")).list()).rejects.toThrow("the list is locked");
    // nothing a list could be: an empty one
    expect(await new Bridged(() => ({})).list()).toEqual([]);
  });

  it("stops by identity alone, and reads gone from stopping", async () => {
    const h = new Bridged(() => "stopping");
    expect(await h.stop({ kind: "chat", session: 2, pid: 9, started: 5 })).toBe("stopping");
    expect(h.calls).toEqual([{ cmd: "running_stop", args: { kind: "chat", session: 2, pid: 9, started: 5 } }]);
    expect(await new Bridged(() => "gone").stop({ kind: "pty", session: 1, pid: 1, started: null })).toBe("gone");
    expect(await new Bridged(() => 7).stop({ kind: "pty", session: 1, pid: 1, started: null })).toBe("stopping");
    await expect(new Bridged(() => new Error("not one of this app's")).stop({ kind: "pty", session: 1, pid: 1, started: null })).rejects.toThrow();
  });
});

describe("the browser's stand-in", () => {
  const make = () => {
    const g: NonNullable<ConstructorParameters<typeof MockRunningHost>[0]> = {};
    const host = new MockRunningHost(g);
    let changed = 0;
    host.onChange = () => changed++;
    return { g, host, changes: () => changed };
  };

  it("lists what a test set, as copies, and tells the page when that changes", async () => {
    const { g, host, changes } = make();
    expect(g.__manutMockRunning).toBe(host.control);
    expect(await host.list()).toEqual([]);
    host.control.set([row()]);
    host.control.add(row({ pid: 5 }));
    expect(changes()).toBe(2);
    const listed = (await host.list())!;
    expect(listed.map((r) => r.pid)).toEqual([4242, 5]);
    listed[0].argv.push("tampered");
    expect((await host.list())![0].argv).toEqual(["pnpm", "dev"]);
    host.control.clear();
    expect(await host.list()).toEqual([]);
    host.control.unsupported = true;
    expect(await host.list()).toBeNull();
  });

  it("ends a command that is stopped, and says gone for one that is not there", async () => {
    const { g, host } = make();
    host.control.set([row(), row({ pid: 5 })]);
    expect(await host.stop({ kind: "pty", session: 3, pid: 4242, started: 1_700_000_000_000 })).toBe("stopping");
    expect((await host.list())!.map((r) => r.pid)).toEqual([5]);
    expect(await host.stop({ kind: "pty", session: 3, pid: 4242, started: 1_700_000_000_000 })).toBe("gone");
    // the same process number from another run is another command
    expect(await host.stop({ kind: "pty", session: 3, pid: 5, started: 1 })).toBe("gone");
    expect(g.__manutRunningCalls?.map((c) => c.pid)).toEqual([4242, 4242, 5]);
  });

  it("can be told to leave a command running or to refuse", async () => {
    const { host } = make();
    host.control.set([row()]);
    host.control.stopMode = "ignore";
    expect(await host.stop({ kind: "pty", session: 3, pid: 4242, started: 1_700_000_000_000 })).toBe("stopping");
    expect(await host.list()).toHaveLength(1);
    host.control.stopMode = "refuse";
    await expect(host.stop({ kind: "pty", session: 3, pid: 4242, started: 1_700_000_000_000 })).rejects.toThrow();
  });
});
