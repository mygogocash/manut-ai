// The runtime choice in Settings › Developer: Practice (the in-process demo, the default) or Connected (an API origin).
import { describe, expect, it } from "vitest";
import { hostOf, parseOrigin, readRuntimeSetting, RUNTIME_KEY, writeRuntimeSetting } from "./setting";

/** A localStorage stand-in that keeps what it is given. */
function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("parseOrigin", () => {
  it("takes an https origin and writes it the one way", () => {
    expect(parseOrigin("https://dev.manut.xyz")).toEqual({ ok: true, origin: "https://dev.manut.xyz" });
    expect(parseOrigin("  HTTPS://Dev.Manut.XYZ/  ")).toEqual({ ok: true, origin: "https://dev.manut.xyz" });
    expect(parseOrigin("https://dev.manut.xyz:8443")).toEqual({ ok: true, origin: "https://dev.manut.xyz:8443" });
  });

  it("reads a bare host as https", () => {
    expect(parseOrigin("dev.manut.xyz")).toEqual({ ok: true, origin: "https://dev.manut.xyz" });
  });

  it("allows plain http only for this computer, where wrangler dev runs", () => {
    expect(parseOrigin("http://localhost:8787")).toEqual({ ok: true, origin: "http://localhost:8787" });
    expect(parseOrigin("http://127.0.0.1:8787")).toEqual({ ok: true, origin: "http://127.0.0.1:8787" });
    expect(parseOrigin("http://[::1]:8787")).toEqual({ ok: true, origin: "http://[::1]:8787" });
    expect(parseOrigin("http://dev.manut.xyz")).toEqual({ ok: false, reason: "not_https" });
    expect(parseOrigin("http://localhost.evil.example")).toEqual({ ok: false, reason: "not_https" });
  });

  it("refuses what is not an origin", () => {
    expect(parseOrigin("")).toEqual({ ok: false, reason: "empty" });
    expect(parseOrigin("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parseOrigin("https://")).toEqual({ ok: false, reason: "not_url" });
    expect(parseOrigin("ftp://dev.manut.xyz")).toEqual({ ok: false, reason: "not_https" });
    expect(parseOrigin("https://dev.manut.xyz/v1")).toEqual({ ok: false, reason: "has_path" });
    expect(parseOrigin("https://dev.manut.xyz/?x=1")).toEqual({ ok: false, reason: "has_path" });
    expect(parseOrigin("https://dev.manut.xyz/#top")).toEqual({ ok: false, reason: "has_path" });
    // a user name in an address can make it read as one host and go to another
    expect(parseOrigin("https://dev.manut.xyz@evil.example")).toEqual({ ok: false, reason: "has_credentials" });
    expect(parseOrigin("https://a:b@dev.manut.xyz")).toEqual({ ok: false, reason: "has_credentials" });
  });

  it("names the host a person reads in the mode line", () => {
    expect(hostOf("https://dev.manut.xyz")).toBe("dev.manut.xyz");
    expect(hostOf("http://localhost:8787")).toBe("localhost:8787");
  });
});

describe("the runtime setting", () => {
  it("is Practice when nothing is saved, the storage is missing or it throws", () => {
    expect(readRuntimeSetting(storage())).toEqual({ mode: "practice" });
    expect(readRuntimeSetting(undefined)).toEqual({ mode: "practice" });
    expect(
      readRuntimeSetting({
        getItem: () => {
          throw new Error("no storage");
        },
      }),
    ).toEqual({ mode: "practice" });
  });

  it("is Practice when what is saved cannot be read or names no usable origin", () => {
    for (const raw of ["{", "null", "[]", '"connected"', '{"mode":"cloud"}', '{"mode":"connected"}', '{"mode":"connected","origin":"http://evil.example"}'])
      expect(readRuntimeSetting(storage({ [RUNTIME_KEY]: raw })), raw).toEqual({ mode: "practice" });
  });

  it("keeps Connected with its origin, written the one way", () => {
    const s = storage();
    writeRuntimeSetting({ mode: "connected", origin: "https://dev.manut.xyz" }, s);
    expect(JSON.parse(s.data.get(RUNTIME_KEY)!)).toEqual({ mode: "connected", origin: "https://dev.manut.xyz" });
    expect(readRuntimeSetting(s)).toEqual({ mode: "connected", origin: "https://dev.manut.xyz" });
    writeRuntimeSetting({ mode: "practice" }, s);
    expect(readRuntimeSetting(s)).toEqual({ mode: "practice" });
  });

  it("refuses to save an origin it would not read back", () => {
    const s = storage();
    expect(() => writeRuntimeSetting({ mode: "connected", origin: "http://evil.example" }, s)).toThrow();
    expect(s.data.has(RUNTIME_KEY)).toBe(false);
  });
});
