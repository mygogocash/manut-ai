// The desktop shell's side of the connected runtime: one Rust command that makes an API request (the webview's own
// fetch is held to CORS, and the API answers none), and three that keep the session in the keychain.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkDown, shellFetch, shellVault, VaultUnavailable } from "./shell";

type Call = [string, Record<string, unknown> | undefined];

/** Stands in for the shell: records each command and answers with `answer`. */
function shell(answer: (cmd: string, args?: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    return answer(cmd, args);
  };
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shellFetch", () => {
  it("hands the request to the shell, the token apart from the address", async () => {
    const calls = shell(() => ({ status: 200, body: '{"schedules":[]}' }));
    const res = await shellFetch()("https://dev.manut.xyz/v1/schedules", {
      method: "GET",
      headers: { authorization: "Bearer abc123", accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"schedules":[]}');
    expect(calls).toEqual([["api_request", { url: "https://dev.manut.xyz/v1/schedules", method: "GET", bearer: "abc123", body: null }]]);
  });

  it("sends a body and no token when the request has none", async () => {
    const calls = shell(() => ({ status: 401, body: '{"error":"invalid_identity"}' }));
    const res = await shellFetch()("https://dev.manut.xyz/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"provider":"apple"}',
    });
    expect(res.status).toBe(401);
    expect(calls[0][1]).toEqual({ url: "https://dev.manut.xyz/v1/auth/exchange", method: "POST", bearer: null, body: '{"provider":"apple"}' });
  });

  it("says offline when the shell could not reach the host, and failed for anything else", async () => {
    shell(() => {
      throw "offline";
    });
    await expect(shellFetch()("https://dev.manut.xyz/v1/schedules", { method: "GET", headers: {} })).rejects.toEqual(new LinkDown("offline"));
    shell(() => {
      throw "refused";
    });
    const failed = await shellFetch()("https://dev.manut.xyz/v1/schedules", { method: "GET", headers: {} }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(LinkDown);
    expect((failed as LinkDown).kind).toBe("failed");
  });

  it("cannot reach anything outside the desktop app (the browser preview)", async () => {
    const out = await shellFetch()("https://dev.manut.xyz/v1/schedules", { method: "GET", headers: {} }).catch((e: unknown) => e);
    expect((out as LinkDown).kind).toBe("unsupported");
  });
});

describe("shellVault", () => {
  it("reads, writes and clears the one session item through the shell", async () => {
    let kept: string | null = null;
    const calls = shell((cmd, args) => {
      if (cmd === "api_session_write") kept = String(args?.value);
      if (cmd === "api_session_clear") kept = null;
      return cmd === "api_session_read" ? kept : null;
    });
    const vault = shellVault();
    expect(await vault.read()).toBeNull();
    await vault.write('{"v":1}');
    expect(await vault.read()).toBe('{"v":1}');
    await vault.clear();
    expect(await vault.read()).toBeNull();
    expect(calls.map(([cmd]) => cmd)).toEqual(["api_session_read", "api_session_write", "api_session_read", "api_session_clear", "api_session_read"]);
  });

  it("says when this computer's shell has no keychain, apart from a keychain that refused", async () => {
    shell(() => {
      throw "unavailable";
    });
    await expect(shellVault().read()).rejects.toBeInstanceOf(VaultUnavailable);
    shell(() => {
      throw "keychain";
    });
    const refused = await shellVault().write("x").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(VaultUnavailable);
  });

  it("has no keychain outside the desktop app", async () => {
    await expect(shellVault().read()).rejects.toBeInstanceOf(VaultUnavailable);
  });
});
