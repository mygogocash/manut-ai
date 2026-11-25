import { describe, expect, it } from "vitest";
import { findDevUrl, withoutEscapes } from "../src/index";

const ESC = "\u001b";

describe("each server's own words", () => {
  const samples: Array<[string, string, string, number]> = [
    ["Vite", "  ➜  Local:   http://localhost:5173/", "http://localhost:5173/", 5173],
    ["Next.js", "   - Local:        http://localhost:3000", "http://localhost:3000/", 3000],
    ["webpack-dev-server", "<i> [webpack-dev-server]     Loopback: http://localhost:8080/", "http://localhost:8080/", 8080],
    ["Astro", " ┃ Local    http://localhost:4321/", "http://localhost:4321/", 4321],
    ["wrangler dev", "⎔ Ready on http://localhost:8787", "http://localhost:8787/", 8787],
    ["http.server", "Serving HTTP on :: port 8000 (http://[::]:8000/) ...", "http://localhost:8000/", 8000],
    ["Django", "Starting development server at http://127.0.0.1:8000/", "http://localhost:8000/", 8000],
    ["Flask", " * Running on http://127.0.0.1:5000", "http://localhost:5000/", 5000],
    ["Rails / Puma", "* Listening on http://127.0.0.1:3000", "http://localhost:3000/", 3000],
  ];
  for (const [name, line, url, port] of samples) {
    it(`finds ${name}`, () => {
      expect(findDevUrl(["starting...", line])).toEqual({ url, port, line: 2 });
    });
  }
});

describe("which addresses count", () => {
  it("answers null for a network-only output", () => {
    expect(findDevUrl(["  ➜  Network: http://192.168.1.5:5173/"])).toBeNull();
  });
  it("answers the local address on a line with two", () => {
    expect(findDevUrl(["Network http://192.168.1.5:5173/ and Local http://localhost:5173/"])).toEqual({
      url: "http://localhost:5173/",
      port: 5173,
      line: 1,
    });
  });
  it("skips a network line and finds the local one after it", () => {
    expect(findDevUrl(["Network: http://10.0.0.2:3000/", "Local: http://localhost:3000/"])?.line).toBe(2);
  });
  it("answers the first local address", () => {
    expect(findDevUrl(["http://localhost:1111/", "http://localhost:2222/"])?.port).toBe(1111);
  });
  it("refuses other hosts, including look-alikes", () => {
    expect(findDevUrl(["http://example.com:3000/"])).toBeNull();
    expect(findDevUrl(["http://localhost.evil.example:3000/"])).toBeNull();
    expect(findDevUrl(["http://localhost:3000@evil.example/"])).toBeNull();
    expect(findDevUrl(["ftp://localhost:3000/"])).toBeNull();
  });
  it("shows [::1] as it is and 0.0.0.0 as localhost", () => {
    expect(findDevUrl(["http://[::1]:3000/"])?.url).toBe("http://[::1]:3000/");
    expect(findDevUrl(["http://0.0.0.0:9000"])?.url).toBe("http://localhost:9000/");
  });
  it("keeps https", () => {
    expect(findDevUrl(["https://localhost:5443/"])).toEqual({ url: "https://localhost:5443/", port: 5443, line: 1 });
  });
  it("uses the default port when none is written", () => {
    expect(findDevUrl(["http://localhost/"])).toEqual({ url: "http://localhost/", port: 80, line: 1 });
    expect(findDevUrl(["https://localhost"])?.port).toBe(443);
  });
  it("ignores a full stop after the address", () => {
    expect(findDevUrl(["Open http://localhost:3000."])?.port).toBe(3000);
  });
  it("ignores the case of the host and scheme", () => {
    expect(findDevUrl(["HTTP://LocalHost:3000/"])?.url).toBe("http://localhost:3000/");
  });
});

describe("ports", () => {
  it("refuses 0, 65536 and a port that is not digits", () => {
    expect(findDevUrl(["http://localhost:0/"])).toBeNull();
    expect(findDevUrl(["http://localhost:65536/"])).toBeNull();
    expect(findDevUrl(["http://localhost:abc/"])).toBeNull();
    expect(findDevUrl(["http://localhost:123456/"])).toBeNull();
  });
  it("accepts 1 and 65535", () => {
    expect(findDevUrl(["http://localhost:1/"])?.port).toBe(1);
    expect(findDevUrl(["http://localhost:65535/"])?.port).toBe(65535);
  });
  it("goes on to a later good address after a refused port", () => {
    expect(findDevUrl(["http://localhost:99999/", "http://localhost:3000/"])?.line).toBe(2);
  });
});

describe("terminal escapes", () => {
  it("are taken out of a line as a person reads it, and its words are kept", () => {
    expect(withoutEscapes(`${ESC}[32m✓${ESC}[39m built in ${ESC}[1m212ms${ESC}[22m`)).toBe("✓ built in 212ms");
    expect(withoutEscapes(`${ESC}]0;vite${ESC}\\  ready`)).toBe("  ready");
    expect(withoutEscapes("plain words")).toBe("plain words");
  });
  it("strips colours inside the address", () => {
    const line = `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`;
    expect(findDevUrl([line])).toEqual({ url: "http://localhost:5173/", port: 5173, line: 1 });
  });
  it("strips cursor moves and window titles", () => {
    expect(findDevUrl([`${ESC}[2K${ESC}[1G${ESC}]0;title\u0007Ready on http://localhost:8787`])?.port).toBe(8787);
    expect(findDevUrl([`${ESC}]0;t${ESC}\\http://localhost:1234/`])?.port).toBe(1234);
  });
});

describe("empty input", () => {
  it("answers null for no output", () => {
    expect(findDevUrl([])).toBeNull();
    expect(findDevUrl([""])).toBeNull();
    expect(findDevUrl(["compiling...", "done"])).toBeNull();
  });
});
