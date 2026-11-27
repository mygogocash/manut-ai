// One Mac and its relay for a test: the real RemoteMac with a keyring in memory, a fake relay, chats a test controls and
// a clock it moves by hand.
import type { DoorShell } from "../door";
import type { RelyingParty } from "@manut/remote-channel";
import { expect } from "vitest";
import { RemoteMac, type RemoteSnapshot } from "../host";
import { memoryKeyring } from "../keys";
import { memoryPushStore } from "../push";
import { FakeChats } from "./chats";
import { ManualClock, settle } from "./clock";
import { TestAuthenticator, TestPhone } from "./phone";
import { FakeRelay } from "./relay";

export const ORIGIN = "https://dev.manut.xyz";
export const RP: RelyingParty = { id: "dev.manut.xyz", origin: ORIGIN };

export async function waitFor(check: () => boolean, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waited too long");
}

export function macHarness(options: { origin?: string | null; door?: DoorShell; pushes?: Record<string, string> } = {}) {
  const relay = new FakeRelay();
  const clock = new ManualClock();
  const keyring = memoryKeyring();
  const chats = new FakeChats();
  const pushes = memoryPushStore(options.pushes);
  const probes: string[] = [];
  const remote = new RemoteMac({
    keyring,
    origin: options.origin === undefined ? ORIGIN : options.origin,
    connect: relay.connectMac,
    probe: async () => {
      probes.push("health");
      return relay.enabled ? "on" : "off";
    },
    chats,
    actions: chats.actions,
    now: () => clock.now,
    timers: clock,
    pushes,
    ...(options.door ? { door: options.door } : {}),
  });
  const views: RemoteSnapshot["pairing"][] = [];
  remote.subscribe((s) => {
    // The pairing's own steps, from the first code on.
    if (views.at(-1) !== s.pairing && (s.pairing.phase !== "idle" || views.length > 0)) views.push(s.pairing);
  });
  return { relay, clock, keyring, chats, pushes, remote, probes, views };
}

export type Harness = ReturnType<typeof macHarness>;

/** Turns the Mac on and waits until the relay has it. */
export async function turnOn(h: Harness): Promise<void> {
  await h.remote.turnOn();
  await waitFor(() => h.relay.macConnected && h.remote.snapshot().link === "ready");
}

/** Shows a code and pairs a phone through it, typing the digits the phone shows. */
export async function pairPhone(
  h: Harness,
  params: { name?: string; authenticator?: TestAuthenticator; typed?: (code: string) => string } = {},
): Promise<{ phone: TestPhone; outcome: string }> {
  expect(await h.remote.startPairing()).toBe(true);
  const view = h.remote.snapshot().pairing;
  if (view.phase !== "showing") throw new Error(`pairing shows ${view.phase}`);
  const phone = new TestPhone({ name: params.name ?? "iPhone, Safari", connect: h.relay.connectPhone, ...(params.authenticator ? { authenticator: params.authenticator } : {}) });
  const outcome = await phone.pair(view.link, (code) => h.remote.typeCode(params.typed ? params.typed(code) : code), { rp: RP });
  await settle();
  return { phone, outcome };
}

