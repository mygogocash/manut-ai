// The page's side of the Tailscale door (item 78f-2b): what it tells the shell when it opens and as devices and the Mac's
// state change, how the shell's events become the host's (frames decoded from base64), and that a stopped door asks the shell
// to stop serving and hands the host nothing more.
import { describe, expect, it } from "vitest";
import { DoorLink, fromBase64, toBase64, type DoorEvent, type DoorShell } from "./door";

function stand(fail?: string) {
  const calls: string[] = [];
  let emit: (e: DoorEvent) => void = () => {};
  const shell: DoorShell = {
    async on(hostId, origin, onEvent) {
      calls.push(`on ${hostId} ${origin}`);
      if (fail) throw new Error(fail);
      emit = onEvent;
      return { name: "mac.tail1234.ts.net", port: 47100 };
    },
    async off() {
      calls.push("off");
    },
    async devices(list) {
      calls.push(`devices ${list.map((d) => `${d.id}=${d.tokenHash}`).join(",")}`);
      return true;
    },
    async status(state) {
      calls.push(`status ${state}`);
      return true;
    },
    async send(stream, data) {
      calls.push(`send ${stream} ${data}`);
      return true;
    },
    async close(stream) {
      calls.push(`close ${stream}`);
      return true;
    },
  };
  return { shell, calls, emit: (e: DoorEvent) => emit(e) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the Tailscale door, from the page", () => {
  it("opens with the devices and the Mac's state as they are, and keeps the shell told as they change", async () => {
    const s = stand();
    const heard: string[] = [];
    const door = new DoorLink({ shell: s.shell, hostId: "H", origin: "https://dev.manut.xyz", events: { onOpen: (st, d) => heard.push(`open ${st} ${d}`), onFrame: (st, p) => heard.push(`frame ${st} ${new TextDecoder().decode(p)}`), onClose: (st, r) => heard.push(`close ${st} ${r}`) } });
    door.allowDevice("D1", "h1");
    door.setPresence("paused", 1);
    expect(s.calls).toEqual([]);
    expect(await door.open()).toEqual({ name: "mac.tail1234.ts.net", port: 47100 });
    expect(s.calls).toEqual(["on H https://dev.manut.xyz", "devices D1=h1", "status paused"]);
    door.allowDevice("D2", "h2");
    door.revokeDevice("D1");
    door.setPresence("available", 2);
    await tick();
    expect(s.calls.slice(3)).toEqual(["devices D1=h1,D2=h2", "devices D2=h2", "status available"]);
    // the shell's events become the host's, a frame decoded from base64
    s.emit({ t: "open", stream: 7, device: "D2" });
    s.emit({ t: "frame", stream: 7, data: toBase64(new TextEncoder().encode("sealed")) });
    s.emit({ t: "frame", stream: 7, data: "%%not base64%%" });
    s.emit({ t: "close", stream: 7, reason: "replaced" });
    expect(heard).toEqual(["open 7 D2", "frame 7 sealed", "close 7 replaced"]);
    expect(door.sendFrame(7, new Uint8Array([1, 2, 3]))).toBe(true);
    door.closeStream(7);
    await tick();
    expect(s.calls.slice(6)).toEqual(["send 7 AQID", "close 7"]);
    // stopped: the shell stops serving, and nothing more reaches the host or the shell
    door.stop();
    s.emit({ t: "frame", stream: 7, data: "AQID" });
    expect(door.sendFrame(7, new Uint8Array([1]))).toBe(false);
    await tick();
    expect(s.calls.at(-1)).toBe("off");
    expect(heard).toHaveLength(3);
  });

  it("says why when the shell did not start it", async () => {
    const s = stand("Tailscale is not ready on this Mac");
    const door = new DoorLink({ shell: s.shell, hostId: "H", origin: "https://dev.manut.xyz", events: { onOpen: () => {}, onFrame: () => {}, onClose: () => {} } });
    await expect(door.open()).rejects.toThrow("Tailscale is not ready on this Mac");
    expect(door.sendFrame(1, new Uint8Array([1]))).toBe(false);
  });

  it("carries a frame of any byte through base64 and back", () => {
    const all = new Uint8Array(70000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(all))).toEqual(all);
    expect(fromBase64("!")).toBeNull();
  });
});
