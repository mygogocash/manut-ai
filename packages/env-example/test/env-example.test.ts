import { describe, expect, it } from "vitest";
import { looksSecret, readEnvExample, sampleEnv } from "../src/index";

const one = (text: string) => readEnvExample(text).vars[0]!;

describe("line forms", () => {
  it("reads NAME=value and export NAME=value", () => {
    expect(readEnvExample("A=1\nexport B=two").vars.map((v) => [v.name, v.sample])).toEqual([
      ["A", "1"],
      ["B", "two"],
    ]);
  });
  it("keeps single quotes as written", () => {
    expect(one(`A='x "y" \\n #z'`).sample).toBe('x "y" \\n #z');
  });
  it("reads \\n and \\\" in double quotes", () => {
    expect(one('A="line1\\nline2 \\"q\\" # not a comment"').sample).toBe('line1\nline2 "q" # not a comment');
  });
  it("keeps other double-quote escapes as written", () => {
    expect(one('A="C:\\\\dir \\t"').sample).toBe("C:\\dir \\t");
  });
  it("ends an unquoted value at ' #'", () => {
    expect(one("A=value # note").sample).toBe("value");
    expect(one("A=http://x/#frag").sample).toBe("http://x/#frag");
    expect(one("A= # nothing").sample).toBe("");
    expect(one("A=\tv\t#c").sample).toBe("v");
  });
  it("allows a comment after a closing quote", () => {
    expect(one(`A='x' # c`).sample).toBe("x");
    expect(one(`A="x"  # c`).sample).toBe("x");
  });
  it("reads an empty value", () => {
    expect(one("A=").sample).toBe("");
  });
  it("ignores blank lines and comment-only lines", () => {
    const r = readEnvExample("\n# only a comment\n\n");
    expect(r).toEqual({ vars: [], skipped: [], repeated: [] });
  });
  it("accepts names with digits and underscores only in the allowed form", () => {
    expect(readEnvExample("_A1=x").vars).toHaveLength(1);
    expect(readEnvExample("1A=x").skipped).toEqual([{ line: 1, text: "1A=x" }]);
  });
});

describe("skipped lines", () => {
  it("lists unreadable lines with their number and never throws", () => {
    const r = readEnvExample("OK=1\nnot a variable\nA-B=2\nQ='open\nR=\"open\nS='x' junk\nT=2");
    expect(r.vars.map((v) => v.name)).toEqual(["OK", "T"]);
    expect(r.skipped.map((s) => s.line)).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("comments", () => {
  it("joins the comment lines directly above", () => {
    expect(one("# First\n# Second\nA=1").comment).toBe("First Second");
  });
  it("is empty after a blank line or another variable", () => {
    expect(readEnvExample("# gone\n\nA=1\nB=2").vars.map((v) => v.comment)).toEqual(["", ""]);
  });
  it("is empty after a skipped line", () => {
    expect(readEnvExample("# gone\nbad line\nA=1").vars[0]!.comment).toBe("");
  });
  it("reads Thai text in comments and values", () => {
    const v = one("# ชื่อร้านที่แสดงให้ลูกค้า\nSHOP_NAME=บ้านมะลิ");
    expect(v.comment).toBe("ชื่อร้านที่แสดงให้ลูกค้า");
    expect(v.sample).toBe("บ้านมะลิ");
  });
});

describe("repeated names", () => {
  it("keeps the later value at the first position and lists the name once", () => {
    const r = readEnvExample("A=1\nB=2\nA=3\nA=4");
    expect(r.vars.map((v) => [v.name, v.sample])).toEqual([
      ["A", "4"],
      ["B", "2"],
    ]);
    expect(r.repeated).toEqual(["A"]);
  });
});

describe("line endings and edges", () => {
  it("reads CRLF", () => {
    const r = readEnvExample("# c\r\nA=1\r\nB='2'\r\n");
    expect(r.vars.map((v) => [v.name, v.sample, v.comment])).toEqual([
      ["A", "1", "c"],
      ["B", "2", ""],
    ]);
  });
  it("reads an empty file", () => {
    expect(readEnvExample("")).toEqual({ vars: [], skipped: [], repeated: [] });
  });
  it("reads a file of only comments", () => {
    expect(readEnvExample("# a\n# b\n#c").vars).toEqual([]);
  });
  it("ignores a byte order mark", () => {
    expect(readEnvExample("\uFEFFA=1").vars[0]!.name).toBe("A");
  });
});

describe("secret rules", () => {
  it.each(["API_KEY", "CLIENT_SECRET", "GH_TOKEN", "DB_PASSWORD", "MY_PRIVATE_URL", "private_thing", "stripe_key"])(
    "name %s is secret",
    (name) => expect(looksSecret(name, "")).toBe(true),
  );
  it.each(["PORT", "KEYBOARD", "SECRETARY", "TOKENS", "PUBLIC_URL"])("name %s is not secret", (name) =>
    expect(looksSecret(name, "x")).toBe(false),
  );
  it.each(["sk-abc123", "ghp_abc123", "xoxb-123-456", "A".repeat(40), `${"Ab1+/".repeat(8)}==`])(
    "sample %s looks like a key",
    (sample) => expect(looksSecret("NOTHING", sample)).toBe(true),
  );
  it.each(["http://localhost:3000", "short", "a".repeat(20), "บ้านมะลิ"])("sample %s is not a key", (sample) =>
    expect(looksSecret("NOTHING", sample)).toBe(false),
  );
  it("sets secret on the read variables", () => {
    expect(readEnvExample("PORT=3000\nAPI_KEY=\nOTHER=sk-live-1").vars.map((v) => v.secret)).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe("sampleEnv", () => {
  it("fakes secrets plainly and keeps other samples", () => {
    const { vars } = readEnvExample("PORT=3000\nSTRIPE_SECRET=sk-live-realvalue\nShop_TOKEN=\nNAME=บ้านมะลิ");
    expect(sampleEnv(vars)).toEqual({
      PORT: "3000",
      STRIPE_SECRET: "sample-stripe_secret",
      Shop_TOKEN: "sample-shop_token",
      NAME: "บ้านมะลิ",
    });
  });
  it("never lets a real-looking value through", () => {
    const { vars } = readEnvExample("X=ghp_realtoken");
    expect(Object.values(sampleEnv(vars)).join()).not.toContain("realtoken");
  });
  it("answers an empty object for no variables", () => {
    expect(sampleEnv([])).toEqual({});
  });
});
