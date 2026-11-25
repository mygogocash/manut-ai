// Tailscale's state as the page reads it from the shell, and its four lines in every language (item 78f).
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS } from "../i18n";
import { readTailscale, tailscaleLine, tailscaleNameOk, tailscaleState, type TailscaleState } from "./tailscale";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

afterEach(() => {
  invoke.mockReset();
  vi.unstubAllGlobals();
});

const ready: TailscaleState = { state: "ready", name: "mac.tail1234.ts.net" };

describe("Tailscale on the page", () => {
  it("takes the four states and keeps only the state and the name", () => {
    expect(tailscaleState({ state: "missing" })).toEqual({ state: "missing" });
    expect(tailscaleState({ state: "signed_out" })).toEqual({ state: "signed_out" });
    expect(tailscaleState({ state: "needs_https", name: "mac.tail1234.ts.net" })).toEqual({ state: "needs_https" });
    expect(tailscaleState({ state: "ready", name: "mac.tail1234.ts.net", ip: "100.64.0.7", user: "someone@example.com" })).toEqual(ready);
  });

  it("reads anything it does not understand as signed out, never ready", () => {
    for (const bad of [null, undefined, "ready", 1, [], {}, { state: "Ready", name: "mac.tail1234.ts.net" }, { state: "running" }, { state: ["ready"] }]) {
      expect(tailscaleState(bad), JSON.stringify(bad)).toEqual({ state: "signed_out" });
    }
  });

  it("shows a name only when it is plain DNS labels under ts.net", () => {
    for (const ok of ["mac.tail1234.ts.net", "a-1.b-2.ts.net", "xn--mc-tka.tail1234.ts.net"]) expect(tailscaleNameOk(ok), ok).toBe(true);
    const hostile = [
      "", "MAC.tail1234.ts.net", "mac.tail1234.ts.net.", "my mac.tail1234.ts.net", "a/b.tail1234.ts.net", "mac\u0007.tail1234.ts.net",
      "my_mac.tail1234.ts.net", "evil.com", "x.ts.net.evil.com", "-mac.tail1234.ts.net", "mac-.tail1234.ts.net", "mac..tail1234.ts.net",
      "mäc.tail1234.ts.net", "ts.net", `${"a".repeat(64)}.tail1234.ts.net`, `${["a", "b", "c", "d"].map((c) => c.repeat(63)).join(".")}.ts.net`,
      "<b>mac</b>.tail1234.ts.net",
    ];
    for (const name of hostile) {
      expect(tailscaleNameOk(name), name).toBe(false);
      expect(tailscaleState({ state: "ready", name }), name).toEqual({ state: "needs_https" });
    }
    expect(tailscaleState({ state: "ready" })).toEqual({ state: "needs_https" });
    expect(tailscaleState({ state: "ready", name: 7 })).toEqual({ state: "needs_https" });
  });

  it("asks the shell's one command with nothing sent, and a failed call is not ready", async () => {
    invoke.mockResolvedValueOnce({ state: "ready", name: "mac.tail1234.ts.net" });
    expect(await readTailscale()).toEqual(ready);
    expect(invoke).toHaveBeenLastCalledWith("tailscale_state");
    invoke.mockRejectedValueOnce(new Error("no shell"));
    expect(await readTailscale()).toEqual({ state: "signed_out" });
    invoke.mockResolvedValueOnce({ state: "ready", name: "evil.com" });
    expect(await readTailscale()).toEqual({ state: "needs_https" });
    expect(invoke.mock.calls).toEqual([["tailscale_state"], ["tailscale_state"], ["tailscale_state"]]);
  });

  it("uses the browser stand-in only when a test sets it", async () => {
    vi.stubGlobal("window", { __manutTailscale: { state: "needs_https" } });
    expect(await readTailscale()).toEqual({ state: "needs_https" });
    vi.stubGlobal("window", { __manutTailscale: { state: "ready", name: "x.ts.net.evil.com" } });
    expect(await readTailscale()).toEqual({ state: "needs_https" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("says the design's words, in every language, with the name and the product names as written", () => {
    expect(tailscaleLine({ state: "missing" }, "en")).toBe("Tailscale isn't installed.");
    expect(tailscaleLine({ state: "signed_out" }, "en")).toBe("Open Tailscale and sign in.");
    expect(tailscaleLine({ state: "needs_https" }, "en")).toBe(
      "An admin of your tailnet turns on MagicDNS and HTTPS Certificates (the DNS page of Tailscale's admin console). This publishes this Mac's name in public certificate logs, for good.",
    );
    expect(tailscaleLine(ready, "en")).toBe("Ready: mac.tail1234.ts.net");
    for (const l of LANGS) {
      for (const s of [{ state: "missing" }, { state: "signed_out" }, { state: "needs_https" }] as TailscaleState[]) {
        expect(tailscaleLine(s, l), `${l} ${s.state}`).toContain("Tailscale");
      }
      const https = tailscaleLine({ state: "needs_https" }, l);
      for (const word of ["tailnet", "MagicDNS", "HTTPS Certificates", "DNS", "Mac"]) expect(https, `${l} ${word}`).toContain(word);
      expect(tailscaleLine(ready, l), l).toContain("mac.tail1234.ts.net");
      expect(tailscaleLine(ready, l), l).not.toContain("{name}");
    }
  });
});
