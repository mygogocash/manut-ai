import { SELF } from "cloudflare:test";

/// SELF bypasses the Cloudflare edge that supplies CF-Connecting-IP. Each
/// unrelated fixture request gets a documentation-only source address so auth
/// and tenant tests exercise their own boundaries without sharing a rate bucket.
/// Ingress rate tests use real bindings with deliberate shared source addresses.
export const sourceWorker = {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
    request.headers.set("cf-connecting-ip", `2001:db8:${groups.join(":")}`);
    return SELF.fetch(request);
  },
};
