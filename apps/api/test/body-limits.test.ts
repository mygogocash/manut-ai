import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { peekJsonBody, readBodyBytes, readJsonBody } from "../src/body";
import { receiveLinearWebhook } from "../src/inbound";
import worker, { type Env } from "../src/index";

const LIMIT = 256 * 1024;
const CHUNK = 64 * 1024;
const bindings = env as unknown as Env;

function flood() {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === 8 * 1024 * 1024) { controller.close(); return; }
      state.pulled += CHUNK;
      controller.enqueue(new Uint8Array(CHUNK).fill(120));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, state };
}

function authCounter() {
  let calls = 0;
  const target = { ...bindings, AUTH: {
    idFromName: (name: string) => bindings.AUTH.idFromName(name),
    get: () => ({ fetch: async () => { calls++; return Response.json({ fixture: true }); } }),
  } as unknown as DurableObjectNamespace };
  return { target, calls: () => calls };
}

async function send(request: Request, target: Env) {
  request.headers.set("cf-connecting-ip", `2001:db8::${crypto.randomUUID().slice(0, 4)}`);
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

function fragmentedRequest(bytes: Uint8Array, emptyChunks = 0, chunkBytes = 1) {
  const empty = new Uint8Array(0);
  let position = 0;
  return new Request("https://fixture/body", { method: "POST", body: new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emptyChunks > 0) { emptyChunks--; controller.enqueue(empty); return; }
      if (position === bytes.length) { controller.close(); return; }
      const end = Math.min(position + chunkBytes, bytes.length);
      controller.enqueue(bytes.subarray(position, end));
      position = end;
    },
  }, { highWaterMark: 0 }) });
}

/// Count reader-owned backing stores, excluding the fixture's shared input views.
/// This resource budget permits fixed blocks or geometric growth as well as one buffer.
async function byteArrayAllocations<T>(input: Uint8Array, read: () => Promise<T>) {
  const NativeUint8Array = globalThis.Uint8Array;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array");
  if (!descriptor) throw new Error("missing_byte_array_constructor");
  const seen = new WeakSet<object>();
  seen.add(input.buffer);
  let allocations = 0;
  const observe = (bytes: Uint8Array) => {
    if (!seen.has(bytes.buffer)) { seen.add(bytes.buffer); allocations++; }
  };
  const originalSlice = NativeUint8Array.prototype.slice;
  const slice = vi.spyOn(NativeUint8Array.prototype, "slice").mockImplementation(function (this: Uint8Array, start, end) {
    const copy = originalSlice.call(this, start, end);
    observe(copy);
    return copy;
  });
  try {
    Object.defineProperty(globalThis, "Uint8Array", { ...descriptor, value: new Proxy(NativeUint8Array, {
      construct(target, arguments_, newTarget) {
        const bytes = Reflect.construct(target, arguments_, newTarget) as Uint8Array;
        observe(bytes);
        return bytes;
      },
    }) });
    const value = await read();
    return { value, allocations };
  } finally {
    Object.defineProperty(globalThis, "Uint8Array", descriptor);
    slice.mockRestore();
  }
}

describe("streaming request bounds", () => {
  it.each([readJsonBody, peekJsonBody])("stops an oversized JSON stream before buffering the full body", async (read) => {
    const { body, state } = flood();
    const result = await read(new Request("https://fixture/body", { method: "POST", body }), LIMIT);
    expect(result).toMatchObject({ ok: false, status: 413, error: "body_too_large" });
    expect(state.pulled).toBeLessThanOrEqual(LIMIT + CHUNK);
    expect(state.cancelled).toBe(true);
  });

  it("counts bytes and preserves UTF-8 characters split across chunks at the exact boundary", async () => {
    const raw = JSON.stringify({ value: "🙂" });
    const bytes = new TextEncoder().encode(raw);
    let position = 0;
    const request = () => new Request("https://fixture/body", { method: "POST", body: new ReadableStream({
      pull(controller) {
        if (position === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(position, ++position));
      },
    }, { highWaterMark: 0 }) });
    expect(await readJsonBody(request(), bytes.length)).toEqual({ ok: true, raw, value: { value: "🙂" } });
    position = 0;
    expect(await readJsonBody(request(), bytes.length - 1)).toMatchObject({ ok: false, status: 413 });
  });

  it("bounds backing-store allocation work independently of valid UTF-8 JSON fragmentation", async () => {
    const value = { value: "🙂漢字".repeat(400) };
    const raw = ` \n${JSON.stringify(value)}\n `;
    const bytes = new TextEncoder().encode(raw);
    const limit = 16 * 1024;
    expect(bytes.byteLength).toBeLessThanOrEqual(limit);
    const whole = fragmentedRequest(bytes, 0, bytes.length);
    const baseline = await byteArrayAllocations(bytes, () => readJsonBody(whole, limit));
    expect(baseline.value).toEqual({ ok: true, raw, value });
    expect(baseline.allocations).toBeLessThanOrEqual(32);
    const fragmented = fragmentedRequest(bytes);
    const measured = await byteArrayAllocations(bytes, () => readJsonBody(fragmented, limit));
    expect(measured.value).toEqual({ ok: true, raw, value });
    expect(measured.allocations).toBeLessThanOrEqual(32);
  });

  it("bounds allocation work for finite empty chunks and preserves exact webhook signing bytes", async () => {
    const bytes = new TextEncoder().encode(' {"fixture":"🙂漢字"}\n');
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("resource-test-signing-key"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const signature = await crypto.subtle.sign("HMAC", key, bytes);
    const request = fragmentedRequest(bytes, 4_096, bytes.length);
    const measured = await byteArrayAllocations(bytes, () => readBodyBytes(request, 16 * 1024));
    expect(measured.value.ok).toBe(true);
    if (!measured.value.ok) throw new Error("bounded_fixture_refused");
    expect(new Uint8Array(measured.value.value)).toEqual(bytes);
    expect(await crypto.subtle.verify("HMAC", key, signature, measured.value.value)).toBe(true);
    expect(measured.allocations).toBeLessThanOrEqual(32);
  });

  it("preserves bounded malformed JSON during a peek", async () => {
    const raw = " { broken json ";
    expect(await peekJsonBody(new Request("https://fixture/body", { method: "POST", body: raw }), 100))
      .toEqual({ ok: true, raw, value: undefined });
  });

  it.each(["exchange", "refresh"])("refuses a headerless auth %s without reading or invoking AUTH", async (route) => {
    const { body, state } = flood();
    const counter = authCounter();
    const response = await send(new Request(`https://test/v1/auth/${route}`, { method: "POST", body }), counter.target);
    expect(response.status).toBe(411);
    expect(state.pulled).toBe(0);
    expect(counter.calls()).toBe(0);
  });

  it.each(["exchange", "refresh"])("bounds streamed auth %s despite a forged small length", async (route) => {
    const { body, state } = flood();
    const counter = authCounter();
    const response = await send(new Request(`https://test/v1/auth/${route}`, { method: "POST",
      headers: { "content-length": "1", "content-type": "application/json" }, body }), counter.target);
    expect(response.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(LIMIT + CHUNK);
    expect(state.cancelled).toBe(true);
    expect(counter.calls()).toBe(0);
  });

  it("rejects a malformed Apple identity before invoking AUTH", async () => {
    const counter = authCounter();
    const body = JSON.stringify({ provider: "apple", identityToken: "not.a.token", nonce: "fixture", deviceId: "fixture" });
    const response = await send(new Request("https://test/v1/auth/exchange", { method: "POST",
      headers: { "content-length": String(new TextEncoder().encode(body).length), "content-type": "application/json" }, body }), counter.target);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_identity" });
    expect(counter.calls()).toBe(0);
  });

  it("bounds inbound webhook bytes before signature checks or storage", async () => {
    const { body, state } = flood();
    const response = await receiveLinearWebhook(new Request("https://test/v1/inbound/linear", { method: "POST",
      headers: { "content-length": "1" }, body }), bindings, Date.now());
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
    expect(state.pulled).toBeLessThanOrEqual(LIMIT + CHUNK);
    expect(state.cancelled).toBe(true);
  });
});
