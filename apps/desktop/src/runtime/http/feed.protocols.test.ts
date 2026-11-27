// No session token goes in a WebSocket protocol entry (feed.ts; docs/decisions.md, the live feed's ticket). The page's
// WebSocket can send no Authorization header, and the API's host writes the Sec-WebSocket-Protocol header into its logs
// as it is, so the feed's socket carries a one-use ticket instead. The entry that once carried a shop session is checked
// gone from every file the repository holds, code and docs alike, so it cannot come back by a copy from an old note.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TICKET_PROTOCOL } from "./feed";

describe("a session token in a protocol entry", () => {
  /** The repository's root, from this file's place in it (apps/desktop/src/runtime/http). */
  const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
  /** Folders that hold nothing the repository wrote itself: installed packages, builds, caches and git's own records. */
  const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", ".turbo", ".wrangler", "coverage", "playwright-report", "test-results"]);
  const TEXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|rs|toml|html|css|yml|yaml|sh|txt)$/;

  function* sources(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // helpers' git worktrees (`.claude/worktrees/*`) are whole other copies of the repository, not more of it
        if (!SKIP.has(entry.name) && !(entry.name === "worktrees" && dir.endsWith(".claude"))) yield* sources(path);
      } else if (entry.isFile() && TEXT.test(entry.name) && statSync(path).size <= 2_000_000) yield path;
    }
  }

  it("is gone for good: the entry that once carried a shop session is named nowhere in the repository, code or docs", () => {
    expect(readFileSync(join(ROOT, "apps/api/src/feed.ts"), "utf8")).toContain(TICKET_PROTOCOL);
    // Spelled in two halves, so that this file does not name it either.
    const gone = ["manut", "bearer"].join("-");
    const named = [...sources(ROOT)].filter((path) => readFileSync(path, "utf8").includes(gone)).map((path) => path.slice(ROOT.length));
    expect(named).toEqual([]);
  });
});
