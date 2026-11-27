// The phone's roads as one link (item 78f-2b): devices and the Mac's state reach every road, and a road added later as they
// are then; each road's streams are kept apart under the host's numbers, and a frame or a close goes back down the road its
// stream came by; a road taken away closes only its own streams.
import { describe, expect, it } from "vitest";
import type { RelayPresence } from "./link";
import { Roads, type Road } from "./roads";

function fakeRoad(name: string, log: string[]): Road {
  return {
    start: () => log.push(`${name} start`),
    stop: () => log.push(`${name} stop`),
    allowDevice: (id, hash) => log.push(`${name} allow ${id}=${hash}`),
    revokeDevice: (id) => log.push(`${name} revoke ${id}`),
    setPresence: (state: RelayPresence) => log.push(`${name} presence ${state}`),
    sendFrame: (stream, payload) => (log.push(`${name} send ${stream} ${payload.length}`), true),
    closeStream: (stream) => log.push(`${name} close ${stream}`),
  };
}

function make() {
  const log: string[] = [];
  const heard: string[] = [];
  let next = 1000;
  const roads = new Roads({ onOpen: (s, d) => heard.push(`open ${s} ${d}`), onFrame: (s, p) => heard.push(`frame ${s} ${p.length}`), onClose: (s, r) => heard.push(`close ${s} ${r}`) }, () => next++);
  return { roads, log, heard };
}

describe("the phone's roads", () => {
  it("tells every road the devices and the Mac's state, and a road added later as they are then", () => {
    const { roads, log } = make();
    roads.setRoad("relay", fakeRoad("relay", log));
    roads.allowDevice("D1", "h1");
    roads.setPresence("available", 1);
    roads.setRoad("door", fakeRoad("door", log));
    roads.revokeDevice("D1");
    roads.start();
    expect(log).toEqual(["relay allow D1=h1", "relay presence available", "door allow D1=h1", "door presence available", "relay revoke D1", "door revoke D1", "relay start", "door start"]);
  });

  it("keeps two roads' streams apart and sends each frame and close down the road it came by", () => {
    const { roads, log, heard } = make();
    roads.setRoad("relay", fakeRoad("relay", log));
    roads.setRoad("door", fakeRoad("door", log));
    const relay = roads.eventsFor("relay");
    const door = roads.eventsFor("door");
    relay.onOpen(5, "D1");
    door.onOpen(5, "D2"); // the same number on the other road gets one of its own
    expect(heard).toEqual(["open 5 D1", "open 1000 D2"]);
    door.onFrame(5, new Uint8Array(3));
    relay.onFrame(5, new Uint8Array(4));
    expect(heard.slice(2)).toEqual(["frame 1000 3", "frame 5 4"]);
    expect(roads.sendFrame(1000, new Uint8Array(2))).toBe(true);
    expect(roads.sendFrame(5, new Uint8Array(9))).toBe(true);
    expect(roads.sendFrame(42, new Uint8Array(1))).toBe(false);
    expect(log).toEqual(["door send 5 2", "relay send 5 9"]);
    // the host closes the door's stream: the door closes its own number, and the host hears nothing back for it
    roads.closeStream(1000);
    door.onClose(5, "closed");
    expect(log.at(-1)).toBe("door close 5");
    expect(heard).toHaveLength(4);
    // the relay closes its stream: the host hears it under its number
    relay.onClose(5, "closed");
    expect(heard.at(-1)).toBe("close 5 closed");
  });

  it("taking a road away closes only its streams, and stops it", () => {
    const { roads, log, heard } = make();
    roads.setRoad("relay", fakeRoad("relay", log));
    roads.setRoad("door", fakeRoad("door", log));
    roads.eventsFor("relay").onOpen(1, "D1");
    roads.eventsFor("door").onOpen(2, "D2");
    roads.eventsFor("door").onOpen(3, "D3");
    roads.removeRoad("door");
    expect(heard.slice(3)).toEqual(["close 2 closed", "close 3 closed"]);
    expect(log.at(-1)).toBe("door stop");
    expect(roads.has("door")).toBe(false);
    expect(roads.sendFrame(2, new Uint8Array(1))).toBe(false);
    expect(roads.sendFrame(1, new Uint8Array(1))).toBe(true);
    // a frame from a road that is gone reaches nobody
    roads.eventsFor("door").onFrame(2, new Uint8Array(1));
    expect(heard).toHaveLength(5);
    roads.stop();
    expect(heard.at(-1)).toBe("close 1 closed");
    expect(log.at(-1)).toBe("relay stop");
  });
});
