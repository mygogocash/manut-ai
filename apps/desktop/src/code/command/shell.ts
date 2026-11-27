// The shell's words: a line split into its simple commands, with what joins them and what each redirects or substitutes.
// Its own file because it knows nothing of what any program does, and no program's file may reach into it.

/** What joins a simple command to the one before it or after it: `start` and `end` for the line's ends, `;` also for a
 *  line break. */
type Sep = "start" | "end" | ";" | "&&" | "||" | "|" | "&";

export interface Simple {
  words: string[];
  /** What joins it to the command before it, and to the one after it. */
  sep: Sep;
  after: Sep;
  /** Where its output or input goes: each target as written. */
  redirects: string[];
  /** The targets it writes its output into. */
  writes: string[];
  /** It reads the output of the command before it through a pipe. */
  piped: boolean;
}

export interface Lexed {
  cmds: Simple[];
  /** Something in it cannot be read in advance: a substitution, a variable, a here-document, a subshell. */
  opaque: boolean;
  /** It defines a function (`name()`, unquoted), which a later command of the shell may call (item 120). */
  defines: boolean;
}

/** The command line split into simple commands, as a POSIX shell would, without expanding anything. */
export function lex(line: string): Lexed {
  const cmds: Simple[] = [];
  let opaque = false;
  let defines = false;
  let cur: Simple = { words: [], redirects: [], writes: [], piped: false, sep: "start", after: "end" };
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let redirect = false;
  /** The redirect being read writes (`>`, `>>`, `&>`), rather than reads (`<`). */
  let writing = false;
  /** In the word being read: an unquoted `{`, and after it an unquoted `,` or `..`, so that a `}` closes a brace list. */
  let braceOpen = false;
  let braceList = false;
  /** The redirect being read came with `&` (`>&`, `<&`): a stream's number after it is a copy of that stream. */
  let copies = false;

  const endWord = () => {
    if (!inWord) return;
    if (redirect) {
      // `>&2`, `2>&1`, `>&-`: a copy of another stream, or one closed, not a file. Any other word after `>&` is a file
      // the shell writes both streams into, `>& file` as much as `>&file`.
      if (!(copies && /^([0-9]+-?|-)$/.test(word))) {
        cur.redirects.push(word);
        if (writing) cur.writes.push(word);
      }
      redirect = false;
      copies = false;
    } else cur.words.push(word);
    word = "";
    inWord = false;
    braceOpen = false;
    braceList = false;
  };
  const endCmd = (next: Sep) => {
    endWord();
    if (redirect) opaque = true; // a redirect with no target
    if (cur.words.length || cur.redirects.length) {
      cur.after = next;
      cmds.push(cur);
      cur = { words: [], redirects: [], writes: [], piped: next === "|", sep: next, after: "end" };
    } else if (cur.sep === "start" || cur.sep === ";") {
      // `a &&` then a line break goes on with the same list: a command after it is joined by `&&`, not by the break
      cur = { ...cur, piped: next === "|", sep: next };
    }
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== undefined && '"\\$`'.includes(next)) word += line[++i];
      else if (c === "$" || c === "`") {
        opaque = true;
        word += c;
      } else word += c;
      continue;
    }
    if (c === "\\") {
      if (next === "\n") i++;
      else if (next !== undefined) {
        word += line[++i];
        inWord = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < line.length && line[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n" || c === ";") {
      endCmd(";");
      continue;
    }
    if (c === "&" && next === "&") {
      endCmd("&&");
      i++;
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        endCmd("||");
        i++;
      } else {
        if (next === "&") i++;
        endCmd("|");
      }
      continue;
    }
    if (c === "&" && next === ">") {
      endWord();
      redirect = true;
      writing = true;
      i += line[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      endCmd("&");
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      opaque = true;
      word += c;
      inWord = true;
      continue;
    }
    if (c === "<" || c === ">") {
      // a file descriptor written right before it (`2>`) belongs to the redirect, not to the words
      if (inWord && /^[0-9]+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      writing = c === ">";
      // `<>` opens the file to write as well as read, and makes it when it is not there
      if (c === "<" && next === ">") writing = true;
      if (c === "<" && next === "<") {
        // a here-document's text follows on the next lines; a here-string's is a word, not a file
        if (line[i + 2] === "<") {
          i += 2;
          redirect = false;
          continue;
        }
        opaque = true;
        i++;
        continue;
      }
      if (next === ">" || next === "|") i++;
      // zsh reads `>!` and `>>!` as a write that may replace a file, and its target is the word after; bash reads `!` as
      // the file's name. The two differ, so the command is not read in advance.
      if (line[i + 1] === "!") opaque = true;
      if (line[i + 1] === "&") {
        i++;
        copies = true;
      }
      redirect = true;
      continue;
    }
    // `$'…'` decodes escapes (`$'\x2dexec'` is `-exec`) and `$"…"` translates its text: neither is what it looks like.
    // zsh, the shell Codex and Claude Code run commands in on a Mac, expands more after a `$` than bash does: `$=X` and
    // `${=X}` split a variable into words (options among them), `$~X` reads it as a pattern, `$^X`, `$+X`, `${(z)X}` and
    // `${(e)X}` do more again. So a `$` followed by anything but a blank or the line's end is never read as itself, and
    // since no expansion is read, a variable set earlier in the line cannot reach a later word unseen.
    if (c === "`" || (c === "$" && next !== undefined && !/[\s]/.test(next))) {
      opaque = true;
      word += c;
      inWord = true;
      continue;
    }
    if (c === "(" || c === ")" || ((c === "{" || c === "}") && !inWord && (next === undefined || next === " " || next === "\n"))) {
      // `name()` or `name ()`, unquoted, defines a function (item 120); `$()` and `<()` do not
      if (c === "(" && /^[ \t]*\)/.test(line.slice(i + 1)) && (inWord ? !/[$<>=]$/.test(word) : cur.words.length > 0)) defines = true;
      opaque = true;
      continue;
    }
    // The shell expands an unquoted word before the program sees it, and this reading cannot follow it there. A pattern
    // (`*`, `?`, `[`) becomes the names of files, and a file the agent named like an option (`-delete`) then becomes one;
    // a brace list (`-{true,exec}`) becomes several words, so `find . -{true,exec} rm {} \;` runs `rm` while it reads as
    // a plain `find`. A command holding either is one that cannot be read in advance, and asks. Quoted or escaped, each
    // is only itself, and `find`'s `{}`, with no list inside, is not expanded.
    if (c === "*" || c === "?" || c === "[") opaque = true;
    // zsh replaces a word that starts with `=` by the path of the program it names (`=node` is `/usr/local/bin/node`),
    // which is no path the command wrote
    if (c === "=" && !inWord && next !== undefined && !/[\s;|&<>()]/.test(next)) opaque = true;
    if (c === "{") braceOpen = true;
    else if (braceOpen && (c === "," || (c === "." && next === "."))) braceList = true;
    else if (c === "}" && braceOpen && braceList) opaque = true;
    word += c;
    inWord = true;
  }
  if (quote) opaque = true;
  endCmd("end");
  return { cmds, opaque, defines };
}
