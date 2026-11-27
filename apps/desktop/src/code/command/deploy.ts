// The programs that deploy or reach out: the deployers, docker and the web tools.
// Its own file because they are one family whose every word that does something goes live or sends.
import { hasExactly, hasIn, hasNamed, live, optName, say, sends, thisMac, unknownProgram, v, type Verdict } from "./verdict";

/** A program that deploys, and the words of its own that do not. */
export function deployer(name: string, words: string[]): Verdict | null {
  const sub = words[1] ?? "";
  const run = () => v("change", say("kit.say.run"), 2);
  const look = () => v("read", say("kit.say.read"));
  switch (name) {
    case "wrangler":
      if (["deploy", "publish"].includes(sub) || (["pages", "versions"].includes(sub) && words[2] === "deploy") || (sub === "secret" && words[2] === "put")) return live();
      if (sub === "dev") return run();
      return ["whoami", "--version", "-v"].includes(sub) ? look() : unknownProgram(name);
    case "vercel":
      if (sub === "dev") return run();
      return ["whoami", "ls", "list", "--version", "inspect", "logs"].includes(sub) ? look() : live();
    case "netlify":
      if (sub === "dev") return run();
      if (sub === "deploy") return live();
      return sub === "status" ? look() : unknownProgram(name);
    case "firebase":
      if (sub === "deploy") return live();
      return ["emulators:start", "serve"].includes(sub) ? run() : unknownProgram(name);
    case "fly":
    case "flyctl":
    case "railway":
      if (["deploy", "up", "redeploy"].includes(sub)) return live();
      return ["status", "logs"].includes(sub) ? look() : unknownProgram(name);
    case "kubectl":
      // `-s` is its short `--server`, whose value need not be a link; a kubeconfig or kuberc it is pointed at can name a
      // program it runs for a key (`exec`) and the server it sends to
      if (hasNamed(words, "server", "s")) return sends();
      if (hasNamed(words, "kubeconfig", "kuberc")) return unknownProgram(name);
      // its cache and a profile are files it writes (a profile lands in the folder it runs in)
      if (hasNamed(words, "cache-dir", "profile-output") || words.some((w, i) => optName(w) === "profile" && (w.split("=")[1] ?? words[i + 1]) !== "none")) return v("change", say("kit.say.change"), "exact");
      // a secret's data is printed by `get` and its keys by `describe`: a key of a computer elsewhere, read as printenv is
      if (["get", "describe"].includes(sub) && words.slice(2).some((w) => !w.startsWith("-") && /(^|,)secrets?($|[,/.])/i.test(w))) return thisMac();
      // and so is any object a file or a kustomization names (a Secret among them, from stdin too), or a path of the API
      // asked for raw (item 120); the short ones are read in a bundle too (`-Rf`)
      if (["get", "describe"].includes(sub) && (hasNamed(words, "filename", "kustomize", "raw") || words.slice(2).some((w) => /^-[A-Za-z]*[fk]/.test(w)))) return thisMac();
      if (["get", "describe", "logs", "explain", "version", "diff"].includes(sub)) return look();
      return ["apply", "create", "delete", "replace", "patch", "rollout", "scale", "set", "edit", "run"].includes(sub) ? live() : unknownProgram(name);
    case "terraform":
    case "tofu":
      // a plan saved to a file, and configuration it writes for what it imports, are files it writes
      if (sub === "plan" && hasNamed(words, "out", "generate-config-out", "state-out")) return v("change", say("kit.say.change"), "exact");
      // its outputs, sensitive ones among them, are printed in plain text with `-json` or `-raw`, and `show -json` prints
      // every sensitive value of the state or the plan (item 120)
      if (sub === "output" || (sub === "show" && hasNamed(words, "json"))) return thisMac();
      if (["plan", "validate", "show"].includes(sub)) return look();
      if (["apply", "destroy", "import"].includes(sub)) return live();
      return sub === "init" ? v("install", say("kit.say.update"), 2) : sub === "fmt" ? v("change", say("kit.say.format"), 2) : unknownProgram(name);
    case "pulumi":
      if (sub === "preview" && hasNamed(words, "save-plan")) return v("change", say("kit.say.change"), "exact");
      // `--show-secrets` prints the stack's secrets in plain text (item 120)
      if (hasNamed(words, "show-secrets")) return thisMac();
      return sub === "preview" ? look() : ["up", "destroy", "refresh"].includes(sub) ? live() : unknownProgram(name);
    case "helm":
      if (hasNamed(words, "kube-apiserver")) return sends();
      if (hasNamed(words, "kubeconfig")) return unknownProgram(name);
      // a post-renderer is a program it runs on what it renders; `--output-dir` writes what it renders into files
      if (hasNamed(words, "post-renderer")) return unknownProgram(name);
      if (hasNamed(words, "output-dir")) return v("change", say("kit.say.change"), "exact");
      // `status` with an output but the table prints the whole release, its values and the manifests it made (Secrets
      // among them), as `helm get all` does (item 120)
      if (sub === "status") {
        const at = words.findIndex((w) => ["o", "output"].includes(optName(w)) || /^-o./.test(w));
        const value = at < 0 ? "table" : words[at].includes("=") ? words[at].slice(words[at].indexOf("=") + 1) : /^-o./.test(words[at]) ? words[at].slice(2) : (words[at + 1] ?? "");
        if (value !== "table") return thisMac();
      }
      return ["list", "status", "template", "lint"].includes(sub) ? look() : ["install", "upgrade", "uninstall", "rollback"].includes(sub) ? live() : unknownProgram(name);
    case "serverless":
    case "sls":
    case "cdk":
      // a synth (and a diff, which synths first) runs the project's app and writes what it makes into a folder
      return ["deploy", "remove", "destroy"].includes(sub) ? live() : ["synth", "diff"].includes(sub) ? v("change", say("kit.say.build"), 2) : unknownProgram(name);
    case "eas":
    case "expo":
      return ["submit", "update", "publish"].includes(sub) ? live() : unknownProgram(name);
    case "heroku":
      return unknownProgram(name);
    default:
      return null;
  }
}

export function docker(words: string[]): Verdict {
  const sub = words[1] ?? "";
  if (sub === "push") return live();
  if (sub === "build") return v("change", say("kit.say.build"), 2);
  if (sub === "compose") {
    // Its own options come before the command, and several take a value (`-p ps up` runs `up` in a project named ps), so
    // the command is read only when it comes first.
    const act = words[2] ?? "";
    if (act.startsWith("-")) return unknownProgram("docker");
    // `config -o` saves what it prints into a file
    if (act === "config" && hasIn("", words.slice(3), "-o", "--output")) return v("change", say("kit.say.change"), "exact");
    // config prints the settings with every variable filled in from the person's environment, unless it only lists names
    if (act === "config" && !hasExactly(words.slice(3), "--services", "--volumes", "--profiles", "--images", "--networks")) return thisMac();
    if (["ps", "logs", "config", "ls"].includes(act)) return v("read", say("kit.say.read"));
    if (["up", "down", "build", "start", "stop", "restart"].includes(act)) return v("change", say("kit.say.run"), 3);
    return unknownProgram("docker");
  }
  // inspect prints a container's environment, keys among them, as printenv does
  if (sub === "inspect" || (["container", "image"].includes(sub) && words[2] === "inspect")) return thisMac();
  if (["ps", "images", "logs", "version", "info"].includes(sub)) return v("read", say("kit.say.read"));
  if (["rm", "rmi", "prune"].includes(sub) || (["system", "volume", "image", "container"].includes(sub) && ["prune", "rm"].includes(words[2] ?? ""))) return v("delete", say("kit.say.delete"), "exact");
  return unknownProgram("docker");
}

/** curl and wget. Reading the network is not reading the project: a GET carries out whatever its address holds, and what it
 *  fetches can be written anywhere, so every request asks as anything that sends does. Only asking curl what it is reaches
 *  nothing. */
export function web(name: string, words: string[]): Verdict {
  if (name === "curl" && words.length === 2 && ["--version", "-V", "--help", "-h", "--manual", "-M"].includes(words[1])) return v("read", say("kit.say.read"));
  return sends();
}
