/// Bounded JSON body reader for Durable Objects. The Worker's content-length
/// pre-check is bypassable with chunked encoding, so every object counts exact
/// bytes while reading and stops before retaining an over-limit chunk. Internal
/// worker-orchestrated endpoints with small fixed schemas
/// may keep request.json(); anything reachable with a client-controlled body
/// must go through this.
export async function readBodyBytes(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: ArrayBuffer } | { ok: false; status: 413; error: string }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("invalid_body_limit");
  if (!request.body) return { ok: true, value: new ArrayBuffer(0) };
  const reader = request.body.getReader();
  // Retain one bounded buffer: a byte cap alone does not bound the number of
  // tiny or empty input chunks an unauthenticated sender can make us allocate.
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maxBytes - size) {
        await reader.cancel();
        return { ok: false, status: 413, error: "body_too_large" };
      }
      if (chunk.value.byteLength === 0) continue;
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > bytes.byteLength) {
        const capacity = Math.min(maxBytes, Math.max(nextSize, bytes.byteLength * 2, 4_096));
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    reader.releaseLock();
  }
  // Return exactly the received bytes, without spare capacity in HMAC input.
  return { ok: true, value: bytes.byteLength === size ? bytes.buffer : bytes.slice(0, size).buffer };
}

export async function readJsonBody<T>(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; raw: string; value: T } | { ok: false; status: 400 | 413; error: string }> {
  const body = await readBodyBytes(request, maxBytes);
  if (!body.ok) return body;
  const raw = new TextDecoder().decode(body.value);
  try {
    return { ok: true, raw, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

/// Bounded read for a Worker route that decides on a body's intent before
/// forwarding it to an object. Same byte bound as readJsonBody, but
/// unparseable JSON is not answered here: it comes back as `value:
/// undefined` beside its raw text, so the route forwards the identical bytes
/// and the object answers exactly as it would have without the peek.
/// Forwarding the raw text rather than a re-serialization also keeps the
/// object's idempotency hash for the request unchanged.
export async function peekJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; raw: string; value: unknown } | { ok: false; status: 413; error: string }> {
  const body = await readBodyBytes(request, maxBytes);
  if (!body.ok) return body;
  const raw = new TextDecoder().decode(body.value);
  try {
    return { ok: true, raw, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: true, raw, value: undefined };
  }
}
