/// Reads a project's `.env.example`, given as text, into the variables the
/// code editor's preview needs (docs/code-editor.md, "Left for later").
///
/// Text in, values out: this never reads a file or the process's environment,
/// and it never throws. A line it cannot read is reported in `skipped`.

export interface EnvVar {
  name: string;
  /// The value written in the file, or empty.
  sample: string;
  /// The comment lines directly above the variable, joined with one space.
  comment: string;
  /// True when the name or the sample looks like a real secret.
  secret: boolean;
}

export interface SkippedLine {
  /// 1-based line number in the text.
  line: number;
  text: string;
}

export interface EnvExample {
  vars: EnvVar[];
  skipped: SkippedLine[];
  /// Names written more than once, each listed once. The later value is kept.
  repeated: string[];
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const SECRET_NAME_END = /_(KEY|SECRET|TOKEN|PASSWORD)$/i;
const SECRET_SAMPLE_PREFIX = /^(sk-|ghp_|xoxb-)/;
/// A long unbroken run of base64 characters is almost always a real key; short
/// words and paths are not.
const LONG_BASE64 = /^[A-Za-z0-9+/]{32,}={0,2}$/;

/// True when a variable should get a fake value in the preview.
export function looksSecret(name: string, sample: string): boolean {
  return (
    SECRET_NAME_END.test(name) ||
    name.toUpperCase().includes("PRIVATE") ||
    SECRET_SAMPLE_PREFIX.test(sample) ||
    LONG_BASE64.test(sample)
  );
}

/// Reads what follows `=`. Returns null when the value is malformed (an
/// unclosed quote, or text after a closing quote that is not a comment).
function readValue(rest: string): string | null {
  const text = rest.trimStart();
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    let value = "";
    let i = 1;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === quote) break;
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        const next = text[i + 1]!;
        if (next === "n") value += "\n";
        else if (next === '"' || next === "\\") value += next;
        else value += ch + next; // Any other escape is kept as written.
        i++;
        continue;
      }
      value += ch;
    }
    if (i >= text.length) return null; // No closing quote.
    const after = text.slice(i + 1);
    if (after.trim() !== "" && !/^\s+#/.test(after)) return null;
    return value;
  }
  // Unquoted: whitespace then `#` starts a comment, a `#` inside a word does not.
  const cut = rest.search(/\s#/);
  return (cut === -1 ? rest : rest.slice(0, cut)).trim();
}

export function readEnvExample(text: string): EnvExample {
  const vars: EnvVar[] = [];
  const skipped: SkippedLine[] = [];
  const repeated: string[] = [];
  const index = new Map<string, number>();
  let comments: string[] = [];

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((raw, n) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      comments = [];
      return;
    }
    if (trimmed.startsWith("#")) {
      comments.push(trimmed.replace(/^#+\s?/, "").trim());
      return;
    }
    const match = LINE.exec(raw);
    const value = match ? readValue(match[2]!) : null;
    if (!match || value === null) {
      skipped.push({ line: n + 1, text: raw });
      comments = [];
      return;
    }
    const name = match[1]!;
    const entry: EnvVar = {
      name,
      sample: value,
      comment: comments.filter((c) => c !== "").join(" "),
      secret: looksSecret(name, value),
    };
    comments = [];
    const seen = index.get(name);
    if (seen === undefined) {
      index.set(name, vars.length);
      vars.push(entry);
    } else {
      vars[seen] = entry; // Keeps the first position in the file, the later value.
      if (!repeated.includes(name)) repeated.push(name);
    }
  });

  return { vars, skipped, repeated };
}

/// The values the preview runs with: a plainly fake value for every secret, the
/// written sample for the rest.
export function sampleEnv(vars: readonly EnvVar[]): Record<string, string> {
  return Object.fromEntries(
    vars.map((v) => [v.name, v.secret ? `sample-${v.name.toLowerCase()}` : v.sample]),
  );
}
