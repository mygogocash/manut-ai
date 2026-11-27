// The languages' own tools: go and the other languages' programs, python and pip.
// Its own file because they are one family and call only the checkers and the option lists.
import { has, hasExactly, hasNamed, live, operands, say, sends, thisMac, unknownProgram, v, type Verdict } from "./verdict";
import { knownOptions } from "./options";
import { checker, checkOptions } from "./checkers";

export function lang(name: string, words: string[]): Verdict {
  const [, sub, third] = words;
  if (name === "go") {
    // a test or a vet built with another program (`-exec`, `-toolexec`, `-vettool`), or writing a file, is not a check
    if (["test", "vet"].includes(sub) && knownOptions(`go ${sub}`, words.slice(2))) return unknownProgram(name);
    if (["test", "vet", "list"].includes(sub)) {
      const opts = checkOptions("go", words.slice(2));
      if (opts) return opts;
    }
    if (["test", "vet"].includes(sub)) return v("check", sub === "test" ? say("kit.say.test") : say("kit.say.check"));
    // a module at a version, its versions, its updates or its retractions are looked up through the module proxy, which
    // fetches them from the host the module's name begins with
    if (sub === "list" && (words.slice(2).some((w) => !w.startsWith("-") && w.includes("@")) || hasNamed(words.slice(2), "versions", "u", "retracted"))) return sends();
    if (["build", "generate"].includes(sub)) return v("change", say("kit.say.build"), 2);
    if (sub === "fmt") return v("change", say("kit.say.format"), 2);
    if (sub === "get" || (sub === "mod" && ["tidy", "download", "vendor"].includes(third))) return v("install", say("kit.say.update"), sub === "mod" ? 3 : 2);
    if (sub === "install") return thisMac();
    if (sub === "env" && has(words, "-w", "-u")) return thisMac();
    if (["version", "env", "list", "doc"].includes(sub)) return v("read", say("kit.say.read"));
    return unknownProgram(name);
  }
  // cargo: `--config` sets what runs a test binary (`target.<triple>.runner`), and `-Z` turns on what is not settled yet
  if (["test", "check", "bench", "clippy"].includes(sub)) {
    if (has(words.slice(2), "--config", "-Z")) return unknownProgram(name);
    const known = knownOptions(`cargo ${sub}`, words.slice(2));
    if (known === "unknown") return unknownProgram(name);
    const opts = checkOptions("cargo", words.slice(2));
    if (opts) return opts;
  }
  if (["test", "check", "bench"].includes(sub)) return v("check", sub === "test" ? say("kit.say.test") : say("kit.say.check"));
  if (sub === "clippy") return has(words, "--fix") ? v("change", say("kit.say.format"), 2) : v("check", say("kit.say.check"));
  if (sub === "fmt") return hasExactly(words, "--check") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 2);
  if (["build", "doc"].includes(sub)) return v("change", say("kit.say.build"), 2);
  if (["add", "remove", "update"].includes(sub)) {
    const n = operands(words, 2).length;
    if (sub === "update") return v("install", say("kit.say.update"), 2);
    return v("install", sub === "add" ? (n === 1 ? say("kit.say.add1") : say("kit.say.addN", { n })) : n === 1 ? say("kit.say.remove1") : say("kit.say.removeN", { n }), 2);
  }
  if (sub === "install") return thisMac();
  if (sub === "publish") return live();
  if (sub === "clean") return v("delete", say("kit.say.delete"), "exact");
  return unknownProgram(name);
}

export function python(words: string[]): Verdict {
  const [, flag, mod] = words;
  if (flag === "--version" || flag === "-V") return v("read", say("kit.say.read"));
  if (flag !== "-m" || !mod) return unknownProgram(words[0]);
  if (mod === "pytest") return checker("pytest", words.slice(2));
  // no list of unittest's options was read: with any, it asks
  if (mod === "unittest") return words.slice(3).some((w) => w.startsWith("-")) ? unknownProgram(words[0]) : v("check", say("kit.say.test"));
  if (["mypy", "black", "isort", "ruff", "flake8", "pylint"].includes(mod)) return checker(mod, words.slice(2));
  if (mod === "pip") return pip(words.slice(2));
  if (mod === "venv") return v("change", say("kit.say.change"), 3);
  return unknownProgram(words[0]);
}

export function pip(words: string[]): Verdict {
  const sub = words[1];
  if (words.length === 2 && ["--version", "-V"].includes(sub)) return v("read", say("kit.say.read"));
  // read only with its own options known to change nothing: `--log` appends to a file, `--python` names a program
  if (["list", "show", "freeze", "check"].includes(sub)) return knownOptions(`pip ${sub}`, words.slice(2)) ? unknownProgram(words[0]) : v("read", say("kit.say.read"));
  if (["install", "uninstall"].includes(sub)) return thisMac();
  return unknownProgram(words[0]);
}
