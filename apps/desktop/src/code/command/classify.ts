// One simple command's words as a step: `classify`, and the readers that call it and are called back by it (`packageManager`, `tool`, `find`, which read a command inside their own).
// These live together, in one file, because each calls `classify` and `classify` calls each, and a file may not import the one that imports it.
import { type Where } from "./types";
import { has, hasIn, live, operands, optName, say, sends, strictest, takesWord, textAfter, thisMac, unknownProgram, v, type Verdict } from "./verdict";
import { PKG_ADDRESS, PM_VALUE, script, strangePmOption } from "./packages";
import { knownOptions } from "./options";
import { checker, CHECKERS, checkOptions, FRAMEWORKS, RUNNER_FLAGS, RUNNER_JOINED, RUNNER_VALUES } from "./checkers";
import { parts, resolve, SCP_LIKE, URL_LIKE, within } from "./paths";
import { git } from "./git";
import { gh } from "./gh";
import { search } from "./search";
import { CHANGES, DELETES, ONLY_TEXT, OPAQUE_PROGRAMS, READS, RUNS_PROGRAM, RUNTIMES, SAFE_VAR, SED_FLAGS, sedSafe, SENDS, THIS_MAC, UNIQ_VALUES, WRITES_UNNAMED, XXD_VALUES } from "./programs";
import { JQ_ONE_VALUE, JQ_TWO_VALUES, jqOperands } from "./jq";
import { changeFolder } from "./cd";
import { guardedPath } from "./protected";
import { lang, pip, python } from "./languages";
import { deployer, docker, web } from "./deploy";

/** pnpm, npm, yarn and bun. */
function packageManager(words: string[], where: Where): Verdict {
  const pm = words[0];
  if (has(words, "-g", "--global", "--location")) return thisMac();
  const ops = operands(words, 1, PM_VALUE);
  if (strangePmOption(words, 1, ops.length ? ops[0] : words.length) || (pm === "npm" && strangePmOption(words, 1, words.length))) return unknownProgram(pm);
  if (!ops.length) return pm === "yarn" ? v("install", say("kit.say.installAll"), 1) : v("read", say("kit.say.read"));
  const at = ops[0];
  const sub = words[at];
  const head = at + 1;
  const rest = ops.slice(1).map((i) => words[i]);
  // what a script is handed after its name goes to whatever the script runs
  const handed = (from: number, s: Verdict): Verdict => {
    if (s.action !== "check") return s;
    const known = knownOptions("", words.slice(from), true);
    if (known === "unknown") return unknownProgram(pm);
    return checkOptions("", words.slice(from)) ?? (known === "change" ? v("change", say("kit.say.format"), head) : s);
  };
  if (pm === "yarn" && sub === "global") return thisMac();
  if (["add", "install", "i", "in", "ci"].includes(sub)) {
    if (sub === "ci" || !rest.length) return v("install", say("kit.say.installAll"), head);
    return v("install", rest.length === 1 ? say("kit.say.add1") : say("kit.say.addN", { n: rest.length }), head);
  }
  if (["remove", "rm", "uninstall", "un", "unlink"].includes(sub)) {
    if (!rest.length) return unknownProgram(pm);
    return v("install", rest.length === 1 ? say("kit.say.remove1") : say("kit.say.removeN", { n: rest.length }), head);
  }
  if (["update", "up", "upgrade", "dedupe", "prune"].includes(sub)) return v("install", say("kit.say.update"), head);
  if (sub === "audit") return has(words, "fix", "--fix") ? v("install", say("kit.say.update"), head) : v("check", say("kit.say.check"));
  // bun's `test` is its own runner, which takes a program to load first (`--preload`)
  if (["test", "t", "tst"].includes(sub)) return handed(head, v("check", say("kit.say.test")));
  if (sub === "run" || sub === "run-script") {
    const name = rest[0];
    return name ? handed(words.indexOf(name, head) + 1, script(name, head + 1)) : v("read", say("kit.say.read"));
  }
  // dlx fetches the tool from the registry every time; exec (and bun's x) runs the project's own
  if (sub === "dlx") return v("unknown", say("kit.say.opaque"));
  if (["exec", "x"].includes(sub)) return at$(tool(words.slice(head), where, pm === "npm" ? NPX_FLAGS : undefined), head);
  if (["publish", "deploy"].includes(sub)) return live();
  if (sub === "pack") return v("change", say("kit.say.build"), head);
  // its settings can name the shell every script runs in, so only reading them is a read
  // A key, a token or a password in its settings is printed by `get` of it, and by a listing; an option after the
  // subcommand (yarn's `--no-redacted`) is not read here.
  if (sub === "config") {
    const after = words.slice(at + 1);
    if (rest[0] !== "get" || after.some((w) => w.startsWith("-")) || rest.slice(1).some((w) => /auth|token|passw|secret|cert|key/i.test(w))) return thisMac();
    return v("read", say("kit.say.read"));
  }
  if (["ls", "list", "why", "outdated", "view", "info", "show", "root", "bin", "help", "doctor", "explain", "licenses", "--version", "-v"].includes(sub)) {
    // asking a registry the agent named, or about a package by its address, reaches that computer
    if (has(words, "--registry") || words.some((w) => /^--@[^=\s]*:registry/.test(w)) || rest.some((w) => PKG_ADDRESS.test(w))) return sends();
    return v("read", say("kit.say.read"));
  }
  if (["create", "init", "link"].includes(sub)) return unknownProgram(pm);
  if (pm === "bun" && /[./]/.test(sub)) return unknownProgram(pm);
  if (pm === "npm" && !["start", "stop", "restart"].includes(sub)) return unknownProgram(pm);
  // pnpm, yarn and bun run a tool of the project's by its name when no script has that name
  const asTool = classify(words.slice(at), where);
  if (!(asTool.action === "unknown" && asTool.say.key === "kit.say.unknown")) return at$(asTool, at);
  return handed(head, script(sub, head));
}

/** npx's (and npm exec's) own options that only answer its question about fetching the tool, or say less. npm reads any
 *  other option before the tool as one of its settings: `--node-options` loads a program into the tool, `--registry`
 *  fetches the tool from another computer, `--userconfig` and `--script-shell` change what runs. */
const NPX_FLAGS: ReadonlySet<string> = new Set(["-y", "--yes", "--no", "-q", "--quiet", "-s", "--silent"]);

/** A tool run by name, through npx or a package manager's exec as much as directly. Its runner's own options come before
 *  the tool, and only those in `flags` are read: any other (`--env-file`, `--shell-mode`, a setting) is not read in
 *  advance. One that names the package to fetch (`-p`, `--package`, `-c`) runs what that package holds, not the
 *  project's own tool of that name. */
function tool(words: string[], where: Where, flags: ReadonlySet<string> = new Set()): Verdict {
  let i = 0;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "--") {
      i++;
      break;
    }
    if (!flags.has(words[i])) return v("unknown", say("kit.say.opaque"));
  }
  if (words.slice(i).some((w) => ["-p", "--package", "-c", "--call"].includes(w) || w.startsWith("--package=") || w.startsWith("--call="))) return v("unknown", say("kit.say.opaque"));
  return i < words.length ? at$(classify(words.slice(i), where), i) : v("unknown", say("kit.say.opaque"));
}

/** One simple command's words as a step, wrappers taken off. Word numbers in the result (the rule's head, the words
 *  that are text) count from the program. */
export function classify(words: string[], where: Where): Verdict {
  if (!words.length) return v("read", say("kit.say.read"));
  const raw = words[0];
  const name = raw.split(/[\\/]/).pop() ?? raw;
  const from = (k: number) => at$(classify(words.slice(k), where), k);

  // wrappers: the program after them speaks
  if (["time", "nohup", "command", "builtin", "exec", "stdbuf", "caffeinate"].includes(name)) return from(1);
  if (name === "nice") return from(words[1] === "-n" ? 3 : 1);
  if (name === "timeout") {
    const ops = operands(words, 1, new Set(["-s", "--signal", "-k", "--kill-after"]));
    return ops.length > 1 ? from(ops[1]) : unknownProgram(name);
  }
  // xargs adds the words it reads to the program's: options (`--pre=sh`), paths outside the project, anything. What it
  // runs is not known until it runs.
  if (name === "xargs") return v("unknown", say("kit.say.opaque"));
  // pnpx is `pnpm dlx`, which fetches the tool from the registry every time; bunx's own options are not read here
  if (name === "pnpx") return v("unknown", say("kit.say.opaque"));
  if (name === "npx" || name === "bunx") return at$(tool(words.slice(1), where, name === "npx" ? NPX_FLAGS : undefined), 1);
  if (name === "uv" || name === "poetry" || name === "pipenv" || name === "bundle") {
    const sub = words[1];
    if ((sub === "run" || sub === "exec") && words.length > 2) return from(2);
    if (name === "uv" && sub === "pip") {
      // `sync` installs and removes packages to match a list, and `compile` writes one
      if (["install", "uninstall", "sync"].includes(words[2] ?? "")) return v("install", say("kit.say.update"), 3);
      if (words[2] === "compile") return v("change", say("kit.say.change"), 3);
      // read only with its own options known to change nothing (`--python` runs the program it names)
      return ["list", "show", "freeze", "tree", "check"].includes(words[2] ?? "") && !knownOptions(`uv pip ${words[2]}`, words.slice(3)) ? v("read", say("kit.say.read")) : unknownProgram(name);
    }
    if (name === "uv" && sub === "tool") return thisMac();
    if (["add", "remove", "sync", "lock", "install", "update"].includes(sub ?? "")) return v("install", say("kit.say.update"), 2);
    if (sub === "publish") return live();
    if (sub === "build") return v("change", say("kit.say.build"), 2);
    if (["show", "check", "tree", "list"].includes(sub ?? "")) return v("read", say("kit.say.read"));
    return unknownProgram(name);
  }

  // A tool run by its path is the tool of that name only where the path really leads, `..` taken out, to a
  // `node_modules/.bin` of the project or of a folder in it (item 116). Any other path is a program nobody has read.
  if (/[\\/]/.test(raw)) {
    const abs = resolve(raw, where.cwd || where.root, where.home);
    const p = abs === null ? null : parts(abs).list;
    const inBin = p !== null && p.length >= 3 && p[p.length - 3] === "node_modules" && p[p.length - 2] === ".bin";
    if (inBin && abs !== null && within(abs, where.root)) return classify([p[p.length - 1], ...words.slice(1)], where);
  }
  if (raw.includes("/") || raw.includes("\\")) {
    // a script of the project's own, run by its path: known by name only when it deploys
    const base = name.replace(/\.[A-Za-z0-9]+$/, "");
    return /deploy|release|publish/i.test(base) ? live() : unknownProgram(raw);
  }
  if (["pnpm", "npm", "yarn", "bun"].includes(name)) return packageManager(words, where);
  if (name === "git") return (git(words, where));
  if (name === "gh") return gh(words, where);
  // `glab mr create` opens a merge request as `gh pr create` opens a pull request (item 100b): a push, in its words. With an
  // address among its words, or another project named (`-R`, `--repo`, as item 120 reads `gh pr create -R`), it may go
  // anywhere, and every other glab is a program the dial has not read.
  if (name === "glab")
    return words[1] === "mr" && words[2] === "create" && !words.some((w) => URL_LIKE.test(w) || /^(-R|--repo)(=|$)/.test(w) || /^-R./.test(w))
      ? v("push", say("kit.say.mr"), 3, { saves: true, text: textAfter(words, ["-t", "--title", "-d", "--description", "-m", "--message"]) })
      : unknownProgram(name);
  if (["grep", "egrep", "fgrep"].includes(name)) return (search(words, "grep"));
  if (["rg", "ag"].includes(name)) return (search(words, "rg"));
  if (name === "find") return find(words, where);
  // A list of files read from a file (`--files0-from`, `--files-from`, tar's `-T`, zip's `-@`): the files it reads, or
  // packs into the project, are named nowhere in the command, so whether they are outside it is not known.
  if (
    words.slice(1).some((w) => ["files0-from", "files-from"].includes(optName(w))) ||
    (name === "tar" && (hasIn("fCbTXKNLHV", words.slice(1), "-T") || /^[A-Za-z]*T/.test(words[1] ?? ""))) ||
    (name === "zip" && words.slice(1).some((w) => /^-[^-]*@/.test(w)))
  )
    return unknownProgram(name);
  if (RUNS_PROGRAM[name] && hasIn(RUNS_PROGRAM[name].values, words.slice(1), ...RUNS_PROGRAM[name].opts)) return unknownProgram(name);
  if ((name === "less" || name === "more") && words.some((w) => w.startsWith("+") && /[!|]/.test(w))) return unknownProgram(name);
  if (name === "sed") {
    // Its options are read from a short list. A script given any other way (`-e…` joined, `-ne`, a file) could hide a
    // command that runs a program, so a sed with any other option is not read in advance.
    const scripts: string[] = [];
    const text = new Set<number>();
    const ops: number[] = [];
    let inPlace = false;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === "--") {
        for (let j = i + 1; j < words.length; j++) ops.push(j);
        break;
      }
      if (w === "-e" || w === "--expression") {
        scripts.push(words[i + 1] ?? "");
        text.add(++i);
      } else if (w.startsWith("--expression=")) {
        scripts.push(w.slice("--expression=".length));
        text.add(i);
      } else if (w === "-i" || w === "--in-place") {
        inPlace = true;
        // macOS's `sed -i ''`: the empty word is the backup's suffix, not the script
        if (w === "-i" && words[i + 1] === "") text.add(++i);
      } else if (/^-i\.[A-Za-z0-9]+$/.test(w) || w.startsWith("--in-place=")) inPlace = true;
      else if (SED_FLAGS.has(w)) continue;
      else if (w.startsWith("-") && w !== "-") return unknownProgram(name);
      else ops.push(i);
    }
    if (!scripts.length && ops.length) {
      scripts.push(words[ops[0]]);
      text.add(ops[0]);
    }
    if (!scripts.every(sedSafe)) return unknownProgram(name);
    return inPlace ? v("change", say("kit.say.change"), 1, { text }) : v("read", say("kit.say.read"), undefined, { text });
  }
  if (name === "awk" || name === "gawk") {
    // Its options are read from a short list: a program from a file or a library (`-f`, `-i`, `-l`, `-e`, `--source`)
    // is not read in advance, nor is one that runs a command, pipes, writes or includes another.
    const ops: number[] = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === "--") {
        for (let j = i + 1; j < words.length; j++) ops.push(j);
        break;
      }
      if (w === "-F" || w === "-v") i++;
      else if (/^-[Fv]./.test(w)) continue;
      else if (w.startsWith("-") && w !== "-") return unknownProgram(name);
      else ops.push(i);
    }
    // The program is not parsed. A print that writes or pipes is looked for as any `>` or `|` after the first print,
    // wherever it is: a `}` or a `;` inside a string must not end the search early. `@` is gawk's (`@include`, and
    // `@f()`, which calls whatever function `f` names, `system` among them). ARGV and ARGC name the files it reads, so a
    // program that sets them reads what the command never said, and ENVIRON and PROCINFO hold the keys set for it.
    const prog = ops.length ? words[ops[0]] : "";
    const printAt = prog.search(/\bprintf?\b/);
    if ((printAt >= 0 && /[>|]/.test(prog.slice(printAt))) || /system\s*\(|getline|\|&|@|\bARGV\b|\bARGC\b|\bENVIRON\b|\bPROCINFO\b/.test(prog)) return unknownProgram(name);
    return v("read", say("kit.say.read"), undefined, { text: new Set(ops.slice(0, 1)) });
  }
  if (name === "export") {
    // a value set for the next commands is read in advance only when it is a harmless one
    // with nothing after it, it prints every variable set, keys among them, as printenv does
    const ops = operands(words, 1);
    return ops.length && ops.every((i) => !words[i].includes("=") || SAFE_VAR.test(words[i])) ? v("read", say("kit.say.read"), undefined, { text: new Set(ops) }) : v("unknown", say("kit.say.opaque"));
  }
  // `-R` runs tree again in every folder with `-o`, writing a file in each
  if (name === "tree" && hasIn("LPIHT", words.slice(1), "-o", "-R")) return v("change", say("kit.say.change"), 1);
  // programs that read, but write their output into a file named after the input (uniq, xxd) or by an option
  if ((name === "uniq" || name === "xxd") && operands(words, 1, name === "uniq" ? UNIQ_VALUES : XXD_VALUES).length > 1) return v("change", say("kit.say.change"), 1);
  // lsof's device cache, on a system built with one, is a file it builds and updates
  if (name === "lsof" && words.some((w) => w.startsWith("-D"))) return v("change", say("kit.say.change"), 1);
  if ((name === "less" || name === "more") && hasIn("bhjkpPtTxyz#", words.slice(1), "-o", "-O", "--log-file", "--LOG-FILE")) return v("change", say("kit.say.change"), 1);
  if (name === "file" && hasIn("mfFeP", words.slice(1), "-C", "--compile")) return v("change", say("kit.say.change"), 1);
  if (name === "hostname" && operands(words, 1).length) return thisMac();
  if (name === "jq" || name === "yq") {
    // yq's `--split-exp` writes each result into a file its expression names
    if (hasIn("poIs", words.slice(1), "-i", "--inplace") || (name === "yq" && hasIn("poI", words.slice(1), "-s", "--split-exp"))) return (v("change", say("kit.say.change"), 1));
    // With `-f` the filter comes from a file, which is not read in advance: it may print the environment (`$ENV`) or, in yq,
    // load any file (item 120). jq takes the first file it is given as the filter wherever `-f` stands.
    if (hasIn("L", words.slice(1), "-f", "--from-file")) return unknownProgram(name);
    const all = jqOperands(words);
    // yq takes its expression after `eval` or `eval-all` (`e`, `ea`) when one is written
    const ops = name === "yq" && ["eval", "e", "eval-all", "ea"].includes(words[all[0]] ?? "") ? all.slice(1) : all;
    // Which word is the filter is not read from every option of theirs (yq's `-o json`, `-I 4` and `--expression=` put it
    // elsewhere), so every word but an option's name is looked at, a value joined to one (`--expression=…`) included
    // (item 120). A file named like an operator only asks more.
    const looked: string[] = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      // jq's `--arg NAME VALUE` and the like name a variable and give it text, which the filter only reads
      if (JQ_TWO_VALUES.has(w)) i += 2;
      else if (JQ_ONE_VALUE.has(w)) i++;
      else if (!w.startsWith("-")) looked.push(w);
      else if (w.includes("=")) looked.push(w.slice(w.indexOf("=") + 1));
    }
    // a module a filter imports or includes is read from a folder of jq's own, `~/.jq` among them, or one `-L` names
    if (name === "jq" && looked.some((w) => /\b(import|include)\b/.test(w))) return unknownProgram(name);
    // `env` and `$ENV` (jq), `env(NAME)` and `strenv(NAME)` (yq) print the variables set for this program, keys among them,
    // as printenv does, so they are read as it is. A field or a key called env (`.env`, `{env: 1}`) and jq's own `$env`
    // variable are only names. yq's `load` and its kinds (`load_str`, `load_xml`) read any file the expression names,
    // which no word shows as a path (item 116), and yq's `eval` runs an expression built from strings as it runs (item 120).
    if (looked.some((w) => /(?<![.\w$])(?:env|strenv|envsubst)\b(?!\s*:)|\$ENV\b|\$__prog_args\b/.test(w))) return thisMac();
    if (name === "yq" && looked.some((w) => /(?<![.\w$])load(_\w+)?\s*\(/.test(w))) return thisMac();
    if (name === "yq" && looked.some((w) => /(?<![.\w$])eval\s*\(/.test(w))) return unknownProgram(name);
    return (v("read", say("kit.say.read"), undefined, { text: new Set(ops.slice(0, 1)) }));
  }
  if (name === "sort") return (hasIn("ktST", words.slice(1), "-o", "--output") ? v("change", say("kit.say.change"), 1) : v("read", say("kit.say.read")));
  if (name === "tee") return (v("change", say("kit.say.change"), 1));
  if (name === "cd" || name === "chdir") return changeFolder(words, where);
  // the folder stack, a script read into this shell and text run as a command can each move the shell anywhere
  if (["pushd", "popd", "source", ".", "eval"].includes(name)) return { ...unknownProgram(name), lost: true };
  // bash's and zsh's printf take one option, `-v NAME`, which puts its text into a variable instead of printing it: into
  // PATH, it decides which program every later word of the line runs
  if (name === "printf" && /^-./.test(words[1] ?? "") && words[1] !== "--") return v("unknown", say("kit.say.opaque"));
  // ps prints every program's environment, keys among them, with `-E`, or with `e` in BSD's form without a dash (ps(1));
  // `-e` alone is every process, outside legacy mode
  if (name === "ps" && words.slice(1).some((w, i) => (w.startsWith("-") ? w.slice(1).includes("E") : i === 0 && /^[a-zA-Z]*e[a-zA-Z]*$/.test(w)))) return thisMac();
  if (ONLY_TEXT.has(name)) return v("read", say("kit.say.read"), undefined, { text: new Set(words.map((_, i) => i).slice(1)) });
  if (READS.has(name)) return v("read", say("kit.say.read"));
  if (DELETES.has(name)) return v("delete", say("kit.say.delete"), "exact");
  if (WRITES_UNNAMED.has(name)) return unknownProgram(name);
  if (name === "cp" && hasIn("tS", words.slice(1), "-s", "-l", "--symbolic-link", "--link")) return unknownProgram(name);
  // an archive names its own files, links and folders, `..` among them
  if (name === "tar" && (hasIn("fCbTXKNLHV", words.slice(1), "-x", "--extract", "--get") || /^[a-wyzA-Z]*x/.test(words[1] ?? ""))) return unknownProgram(name);
  if (name === "unzip" && !["-l", "-t", "-v", "-Z", "-p"].includes(words[1] ?? "")) return unknownProgram(name);
  // gunzip writes the file named after the archive, its ending taken off
  if ((name === "gunzip" || (name === "gzip" && has(words.slice(1), "-d", "--decompress"))) && words.slice(1).some((w) => !w.startsWith("-") && guardedPath(w.replace(/(\.gz|\.z|-gz|-z|_z)$/i, ""), where))) return unknownProgram(name);
  if (CHANGES.has(name)) return (v("change", say("kit.say.change"), 1));
  if (name === "rsync") return words.slice(1).some((w) => SCP_LIKE.test(w) || /^[^/\s]+:/.test(w)) ? sends() : (v("change", say("kit.say.change"), 1));
  if (THIS_MAC.has(name)) return thisMac();
  if (SENDS.has(name)) return sends();
  if (OPAQUE_PROGRAMS.has(name)) return unknownProgram(name);
  if (CHECKERS.has(name)) return (checker(name, words));
  if (name === "go" || name === "cargo") return (lang(name, words));
  if (["python", "python3", "py"].includes(name)) return (python(words));
  if (name === "pip" || name === "pip3") return pip(words);
  if (name === "gem") return words[1] === "push" ? live() : words[1] === "install" ? thisMac() : unknownProgram(name);
  if (name === "twine") return words[1] === "upload" ? live() : unknownProgram(name);
  if (name === "composer") return ["require", "install", "update", "remove"].includes(words[1] ?? "") ? (v("install", say("kit.say.update"), 2)) : unknownProgram(name);
  if (["make", "just", "task"].includes(name)) {
    // Read only with its own options that choose how many run at once and how much it says. Any other can name another
    // file of recipes (`-f`, `--justfile`, `-t`), text to read as recipes (`--eval`), the shell they run in (`just
    // --shell`) or a folder to include; and `NAME=value` after it replaces that word in every recipe, `SHELL` among them.
    const values = RUNNER_VALUES[name];
    const targets: number[] = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (!w.startsWith("-") || w === "-") {
        if (w.includes("=")) return unknownProgram(name);
        targets.push(i);
        continue;
      }
      if (RUNNER_FLAGS[name].has(w) || RUNNER_JOINED[name].test(w)) continue;
      if (values.has(w.split("=")[0])) {
        // make's `-j` and `-l` take a number after them only when one is there (GNU make's manual: `-j [jobs]`); no value
        // option takes a word that starts with `-` (item 120: `make -j --file=other.mk test` runs the other file's test)
        const optional = name === "make" && ["-j", "--jobs", "-l", "--load-average"].includes(w);
        if (!w.includes("=") && takesWord(words[i + 1]) && (!optional || /^[0-9.]+$/.test(words[i + 1]))) i++;
        continue;
      }
      return unknownProgram(name);
    }
    if (!targets.length) return unknownProgram(name);
    return (strictest(targets.map((i) => script(words[i], i + 1))));
  }
  if (FRAMEWORKS.has(name)) {
    const sub = words[1] && !words[1].startsWith("-") ? words[1] : "";
    if (name === "turbo" || name === "nx") {
      const task = sub === "run" ? 2 : 1;
      if (!sub || !words[task] || words[task].startsWith("-")) return unknownProgram(name);
      const s = script(words[task], task + 1);
      if (s.action !== "check") return s;
      // its own options are read from its list (nx's from none), and the words after `--` as a script's
      const rest = words.slice(task + 1);
      const dash = rest.indexOf("--");
      const own = dash >= 0 ? rest.slice(0, dash) : rest;
      if (knownOptions(name, own)) return unknownProgram(name);
      if (dash < 0) return s;
      const handed = knownOptions("", rest.slice(dash + 1), true);
      return handed === "unknown" ? unknownProgram(name) : (checkOptions("", rest.slice(dash + 1)) ?? (handed === "change" ? v("change", say("kit.say.format"), task + 1) : s));
    }
    if (sub === "build" || ["webpack", "rollup", "esbuild", "tsup", "parcel"].includes(name)) return (v("change", say("kit.say.build"), sub ? 2 : 1));
    // a framework's lint hands its options to the linter, and no list of them was read: with any, it asks
    if (sub === "lint") return words.slice(2).some((w) => w.startsWith("-")) ? unknownProgram(name) : v("check", say("kit.say.check"));
    if (sub === "deploy") return live();
    return (v("change", say("kit.say.run"), sub ? 2 : 1));
  }
  const d = deployer(name, words);
  if (d) return (d);
  if (["docker", "podman"].includes(name)) return (docker(words));
  if (name === "curl" || name === "wget") return (web(name, words));
  if (RUNTIMES.has(name)) return words[1] === "--version" || words[1] === "-v" ? v("read", say("kit.say.read")) : unknownProgram(name);
  return unknownProgram(name);
}

/** A verdict read from the words from `by` on, with its word numbers counted from the whole command again. */
function at$(r: Verdict, by: number): Verdict {
  if (!by) return r;
  const head = typeof r.head === "number" ? r.head + by : r.head;
  const text = r.text ? new Set([...r.text].map((i) => i + by)) : undefined;
  return { ...r, ...(head === undefined ? {} : { head }), ...(text ? { text } : {}) };
}

/** find's (BSD's and GNU's) options and tests that only choose where it looks, match a file, or print to its own output.
 *  Any other word starting with `-` is not read in advance: it may be one that deletes, writes a file, or reads its list of
 *  files from one (`-files0-from`), or one this list has not met. */
const FIND_FLAGS = new Set([
  "-E", "-H", "-L", "-P", "-X", "-d", "-s", "-x", "-O0", "-O1", "-O2", "-O3", "-depth", "-empty", "-executable", "-readable",
  "-writable", "-false", "-true", "-follow", "-ignore_readdir_race", "-noignore_readdir_race", "-ls", "-mount", "-xdev", "-noleaf",
  "-nogroup", "-nouser", "-print", "-print0", "-prune", "-quit", "-sparse", "-xattr", "-acl", "-not", "-a", "-and", "-o", "-or",
  "-daystart", "-warn", "-nowarn", "-help", "--help", "-version", "--version",
]);

/** Its tests whose value is text: a pattern, a number, a type, a format printed to its own output. */
const FIND_TEXT = new Set([
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename", "-lname", "-ilname", "-type", "-xtype",
  "-perm", "-user", "-group", "-uid", "-gid", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-Btime", "-Bmin",
  "-used", "-maxdepth", "-mindepth", "-links", "-inum", "-fstype", "-flags", "-printf", "-regextype", "-context", "-xattrname", "-D",
]);

/** Its tests that look at another file's times or identity: the file is a path like any other, checked against the project. */
const FIND_FILE = new Set(["-newer", "-anewer", "-cnewer", "-mnewer", "-Bnewer", "-samefile", "-f"]);

const FIND_FILTERS = new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename", "-newer", "-mtime", "-mmin", "-size"]);

/** Its actions that run a program for each file: each one's command runs, however many there are. */
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** A find, read word by word. Every command it runs (each `-exec`, `-execdir`, `-ok` and `-okdir`, not only the first) is
 *  read as a command of its own, and the find is as strict as the strictest of them. A command ends at `;`, or at a `+`
 *  right after `{}` (a `+` anywhere else is one of its words, as find reads it). `-ok` asks on its input, which a pipe can
 *  answer, so it is read as `-exec` is. */
function find(words: string[], where: Where): Verdict {
  const text = new Set<number>();
  const parts: Verdict[] = [];
  /** Its own `-delete`. */
  const own = v("delete", say("kit.say.delete"), "exact");
  let filtered = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (FIND_RUNS.has(w)) {
      let end = i + 1;
      while (end < words.length && words[end] !== ";" && !(words[end] === "+" && words[end - 1] === "{}")) end++;
      const inner = at$(classify(words.slice(i + 1, end), where), i + 1);
      parts.push({ ...inner, head: inner.action === "read" || inner.action === "check" ? undefined : "exact" });
      i = end;
      continue;
    }
    // a place to start from, or an operator (`!`, `(`, `)`, `,`)
    if (!w.startsWith("-") || w === "-") continue;
    if (FIND_FILTERS.has(w)) filtered = true;
    if (FIND_FLAGS.has(w) || /^-[EHLPXdsx]+$/.test(w)) continue;
    if (FIND_TEXT.has(w)) {
      if (i + 1 < words.length) text.add(i + 1);
      i++;
      continue;
    }
    // `-newermt 2026-01-01` and the like compare with a time or a file: a value that is a path is checked as one
    if (FIND_FILE.has(w) || /^-newer[aBcmt][aBcmt]$/.test(w)) {
      i++;
      continue;
    }
    if (w === "-delete") {
      parts.push(own);
      continue;
    }
    // each writes its list into the file it names; `-fprintf`'s format, after the file, is text
    if (["-fprint", "-fprint0", "-fls", "-fprintf"].includes(w)) {
      parts.push(v("change", say("kit.say.change"), "exact"));
      if (w === "-fprintf" && i + 2 < words.length) text.add(i + 2);
      i += w === "-fprintf" ? 2 : 1;
      continue;
    }
    return unknownProgram("find");
  }
  // the words of each command it runs that are text stay text
  for (const p of parts) for (const i of p.text ?? []) text.add(i);
  const whole = strictest([v("read", say("kit.say.read")), ...parts]);
  // `-delete` with a test on the name or the age, wherever it comes in the words, deletes only what matches: its folders
  // are where it looks, not what it deletes
  return { ...whole, text, ...(whole === own && filtered ? { filtered: true as const } : {}), ...(parts.some((p) => p.moves) ? { moves: true as const } : {}) };
}
