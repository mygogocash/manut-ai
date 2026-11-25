import { describe, expect, it } from "vitest";
import { type Bytes, MAX_FRAME_BYTES, RECORD_LIMIT } from "../src/index";
import { bytesOf, flipBit, openSession, read, refusal, text } from "./support";

/// The records of an open session: every message encrypted with AES-256-GCM under a key for its
/// direction, numbered by an implicit counter, and split to fit the relay's frame. The relay
/// (`apps/api/src/relay-object.ts`) forwards each frame unread and could change, repeat, reorder,
/// drop, reflect or swap any of them; each of those must stop the session rather than deliver.

const K = bytesOf(32, 0x4b);

/// A message of `length` bytes whose content says where each byte came from, so a reordering or
/// a lost frame cannot go unnoticed in the comparison.
function patterned(length: number): Bytes {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + (i >> 16)) & 0xff);
}

describe("records", () => {
  it("carries messages in order both ways, an empty one included", async () => {
    const { phone, mac } = await openSession(K);
    const sent = ["one", "", "three", "ไทย ✓"];
    for (const message of sent) {
      const frames = await phone.seal(text(message));
      expect(frames).toHaveLength(1);
      expect(read(await mac.open(frames[0]!))).toBe(message);
    }
    for (const frame of await mac.seal(text("back"))) expect(read(await phone.open(frame))).toBe("back");
  });

  it("keeps the order of messages sealed without waiting for each other", async () => {
    const { phone, mac } = await openSession(K);
    const pending = ["a", "b", "c", "d"].map((message) => phone.seal(text(message)));
    const frames = (await Promise.all(pending)).flat();
    const opened = await Promise.all(frames.map((frame) => mac.open(frame)));
    expect(opened.map(read)).toEqual(["a", "b", "c", "d"]);
  });

  it("a message changed by one bit is refused, and the session then takes nothing more", async () => {
    const { phone, mac } = await openSession(K);
    const [first] = await phone.seal(text("approve nothing"));
    const [second] = await phone.seal(text("next"));
    // Every bit position of the frame: the header byte, the ciphertext and the tag.
    for (let index = 0; index < first!.length; index++) {
      for (const mask of [0x01, 0x80]) {
        const { phone: p, mac: m } = await openSession(K);
        const [frame] = await p.seal(text("approve nothing"));
        expect(await refusal(() => m.open(flipBit(frame!, index, mask))), `byte ${index} bit ${mask}`).not.toBe("none");
      }
    }
    expect(await refusal(() => mac.open(flipBit(first!, 10)))).toBe("unauthenticated");
    expect(mac.isClosed).toBe(true);
    expect(await refusal(() => mac.open(first!))).toBe("closed");
    expect(await refusal(() => mac.open(second!))).toBe("closed");
  });

  it("a message repeated is refused", async () => {
    const { phone, mac } = await openSession(K);
    const [frame] = await phone.seal(text("allow once"));
    expect(read(await mac.open(frame!))).toBe("allow once");
    expect(await refusal(() => mac.open(frame!))).toBe("unauthenticated");
  });

  it("messages reordered are refused", async () => {
    const { phone, mac } = await openSession(K);
    const [first] = await phone.seal(text("first"));
    const [second] = await phone.seal(text("second"));
    expect(await refusal(() => mac.open(second!))).toBe("unauthenticated");
    expect(await refusal(() => mac.open(first!))).toBe("closed");
  });

  it("a message dropped in the middle is noticed at the next one, which is refused", async () => {
    const { phone, mac } = await openSession(K);
    const [first] = await phone.seal(text("first"));
    await phone.seal(text("dropped by the relay"));
    const [third] = await phone.seal(text("third"));
    expect(read(await mac.open(first!))).toBe("first");
    expect(await refusal(() => mac.open(third!))).toBe("unauthenticated");
  });

  it("a message replayed from an earlier session is refused", async () => {
    const earlier = await openSession(K);
    const [recorded] = await earlier.phone.seal(text("from yesterday"));
    const { mac } = await openSession(K);
    expect(await refusal(() => mac.open(recorded!))).toBe("unauthenticated");
  });

  it("a message sent back to the side that sealed it is refused", async () => {
    const { phone, mac } = await openSession(K);
    const [toPhone] = await mac.seal(text("for the phone"));
    expect(await refusal(() => mac.open(toPhone!))).toBe("unauthenticated");
    const [toMac] = await phone.seal(text("for the Mac"));
    expect(await refusal(() => phone.open(toMac!))).toBe("unauthenticated");
  });

  it("a message from another phone's session, swapped onto this stream, is refused", async () => {
    const one = await openSession(K);
    const two = await openSession(bytesOf(32, 0x99));
    const [fromTwo] = await two.phone.seal(text("phone two"));
    expect(await refusal(() => one.mac.open(fromTwo!))).toBe("unauthenticated");
  });

  it("a counter that runs out stops the session before a nonce could repeat", async () => {
    expect(RECORD_LIMIT).toBe(2 ** 24);
    const { phone, mac } = await openSession(K, { phone: { recordLimit: 3 }, mac: { recordLimit: 3 } });
    for (const message of ["1", "2", "3"]) {
      for (const frame of await phone.seal(text(message))) expect(read(await mac.open(frame))).toBe(message);
    }
    expect(await refusal(() => phone.seal(text("4")))).toBe("exhausted");

    // A sender that ignored its limit: the receiver refuses the record past its own.
    const loose = await openSession(K, { mac: { recordLimit: 2 } });
    const frames = [...(await loose.phone.seal(text("1"))), ...(await loose.phone.seal(text("2"))), ...(await loose.phone.seal(text("3")))];
    await loose.mac.open(frames[0]!);
    await loose.mac.open(frames[1]!);
    expect(await refusal(() => loose.mac.open(frames[2]!))).toBe("exhausted");

    // A message that would need more records than are left is refused whole, before any is sent.
    const tight = await openSession(K, { phone: { recordLimit: 2 } });
    expect(await refusal(() => tight.phone.seal(patterned(MAX_FRAME_BYTES * 2)))).toBe("exhausted");
    expect(await tight.phone.seal(text("still fits"))).toHaveLength(1);
  });

  it("a limit can only be lowered", async () => {
    expect(await refusal(() => openSession(K, { phone: { recordLimit: RECORD_LIMIT + 1 } }))).toBe("invalid");
    expect(await refusal(() => openSession(K, { phone: { recordLimit: 0 } }))).toBe("invalid");
  });
});

describe("frames", () => {
  it("splits a message larger than several frames into frames the relay forwards, and gets it back whole and in order", async () => {
    const { phone, mac } = await openSession(K);
    const message = patterned(MAX_FRAME_BYTES * 3 + 12_345);
    const frames = await mac.seal(message);
    expect(frames.length).toBe(4);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    let received: Uint8Array | null = null;
    for (const [index, frame] of frames.entries()) {
      received = await phone.open(frame);
      expect(received === null, `frame ${index}`).toBe(index < frames.length - 1);
    }
    expect(received).toEqual(message);
    // The next message starts clean.
    for (const frame of await mac.seal(text("after"))) expect(read(await phone.open(frame))).toBe("after");
  });

  it("refuses a large message with a frame missing, and never hands over part of one", async () => {
    const { phone, mac } = await openSession(K);
    const frames = await mac.seal(patterned(MAX_FRAME_BYTES * 3));
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(await phone.open(frames[0]!)).toBeNull();
    expect(await refusal(() => phone.open(frames[2]!))).toBe("unauthenticated");

    // A message cut short at its end is never delivered: the frames before the cut give nothing.
    const cut = await openSession(K);
    const cutFrames = await cut.mac.seal(patterned(MAX_FRAME_BYTES * 2));
    for (const frame of cutFrames.slice(0, -1)) expect(await cut.phone.open(frame)).toBeNull();
  });

  it("refuses a frame over the relay's limit, or too short to be a record, or of another type", async () => {
    const { phone, mac } = await openSession(K);
    expect(await refusal(() => mac.open(new Uint8Array(MAX_FRAME_BYTES + 1)))).toBe("too_large");
    const short = await openSession(K);
    expect(await refusal(() => short.mac.open(new Uint8Array(17)))).toBe("malformed");
    const [frame] = await phone.seal(text("x"));
    const retyped = frame!.slice();
    retyped[0] = 0x20;
    const typed = await openSession(K);
    expect(await refusal(() => typed.mac.open(retyped))).toBe("malformed");
  });

  it("refuses a message larger than the receiver takes, and does not seal one larger than the sender allows", async () => {
    const { phone, mac } = await openSession(K, { mac: { maxMessageBytes: 100_000 } });
    const frames = await phone.seal(patterned(150_000));
    expect(await mac.open(frames[0]!)).toBeNull();
    expect(await refusal(() => mac.open(frames[1]!))).toBe("too_large");

    const small = await openSession(K, { phone: { maxMessageBytes: 10 } });
    expect(await refusal(() => small.phone.seal(patterned(11)))).toBe("too_large");
    // Refusing to seal sent nothing, so the session goes on.
    for (const frame of await small.phone.seal(text("fits"))) expect(read(await small.mac.open(frame))).toBe("fits");
  });

  it("a session closed while a frame is on its way hands that frame over to nobody", async () => {
    const { phone, mac } = await openSession(K);
    const [frame] = await phone.seal(text("late"));
    const opening = mac.open(frame!);
    mac.close();
    expect(await refusal(() => opening)).toBe("closed");
  });

  it("a closed session seals and opens nothing", async () => {
    const { phone, mac } = await openSession(K);
    const [frame] = await phone.seal(text("x"));
    mac.close();
    phone.close();
    expect(await refusal(() => mac.open(frame!))).toBe("closed");
    expect(await refusal(() => phone.seal(text("y")))).toBe("closed");
  });
});
