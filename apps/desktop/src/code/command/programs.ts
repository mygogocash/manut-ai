// The sets of program names the reader knows: those that only read, change files, delete, change this Mac, send, or cannot be read, and the runtimes, with sed's safe scripts.
// Its own file so the lists are read in one place, apart from the code that uses them.

export const READS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "file", "stat", "du", "df", "ls", "tree", "pwd", "realpath", "readlink",
  "basename", "dirname", "diff", "cmp", "comm", "uniq", "cut", "tr", "nl", "od", "hexdump", "xxd", "strings", "column",
  "fold", "rev", "tac", "which", "type", "whereis", "true", "false", "test", "[", "date", "sleep", "whoami", "uname", "id",
  "hostname", "sw_vers", "fd", "fdfind", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "ps", "lsof", "uptime",
  "unset", "exit", "wait",
]);

export const ONLY_TEXT = new Set(["echo", "printf", "unset"]);

/** Options of programs that otherwise read or change files, which make them run another program, and each program's short
 *  options that take a value (`isOpt`). */
export const RUNS_PROGRAM: Record<string, { opts: string[]; values: string }> = {
  fd: { opts: ["-x", "--exec", "-X", "--exec-batch"], values: "etEdjSoc" },
  fdfind: { opts: ["-x", "--exec", "-X", "--exec-batch"], values: "etEdjSoc" },
  tar: { opts: ["--to-command", "--checkpoint-action", "-I", "--use-compress-program", "--info-script", "--new-volume-script", "-F"], values: "fCbTXKNLHV" },
  rsync: { opts: ["-e", "--rsh", "--rsync-path"], values: "fTMB" },
  sort: { opts: ["--compress-program"], values: "" },
  zip: { opts: ["-TT", "--unzip-command"], values: "" },
  curl: { opts: ["-K", "--config"], values: "" },
  date: { opts: ["-s", "--set"], values: "dfrIv" },
  // a key file binds keys to commands, and a `+` word is a command less runs as it starts
  less: { opts: ["-k", "--lesskey-file", "--lesskey-src", "--lesskey-content"], values: "bhjopPtTxyzO#" },
  more: { opts: ["-k", "--lesskey-file", "--lesskey-src", "--lesskey-content"], values: "bhjopPtTxyzO#" },
};

export const CHANGES = new Set(["mkdir", "touch", "cp", "mv", "chmod", "install", "tar", "unzip", "zip", "gzip", "gunzip", "dos2unix", "truncate"]);

/** The options of uniq and xxd that take a value: what is left are the files it reads and writes (a second one is the file
 *  it writes). Each program has its own: taking `-c` for one that takes a value, as both once shared, swallowed uniq's
 *  input and hid the file it writes. An option left out here only counts one more file, which asks more, never less. */
export const UNIQ_VALUES: ReadonlySet<string> = new Set(["-f", "-s", "-w"]);

export const XXD_VALUES: ReadonlySet<string> = new Set(["-c", "-g", "-l", "-n", "-o", "-s"]);

/** Programs that write files the command does not name: a link (`ln`, `link`, `cp -s`) makes a later change to its path
 *  land where the link leads, and a patch names its own files inside. */
export const WRITES_UNNAMED = new Set(["ln", "link", "patch"]);

export const DELETES = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);

export const THIS_MAC = new Set(["brew", "port", "apt", "apt-get", "yum", "dnf", "pacman", "snap", "choco", "winget", "scoop", "softwareupdate", "defaults", "launchctl", "systemctl", "crontab", "mas", "sudo", "doas", "su", "chown", "nvm", "fnm", "volta", "asdf", "mise", "pyenv", "rbenv"]);

export const SENDS = new Set(["ssh", "scp", "sftp", "nc", "ncat", "telnet", "ftp", "mosh"]);

export const OPAQUE_PROGRAMS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "source", ".", "eval", "open", "xdg-open", "osascript", "kill", "pkill", "killall", "printenv", "env", "set", "alias", "unalias", "trap", "function"]);

/** Variables a command may be run with and still be read in advance. Any other (`PATH`, `NODE_OPTIONS`, `DYLD_*`,
 *  `GIT_*`, a pager) can make the same words run another program. */
export const SAFE_VAR = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG|LANGUAGE|LC_[A-Z]+|DEBUG|PORT|TERM|COLUMNS|LINES|NODE_NO_WARNINGS|RUST_BACKTRACE|RUST_LOG)=/;

/** sed's own commands that only print or change lines on their way through: an address or two, then print, delete,
 *  quit and the like, a substitution whose flags write nothing and run nothing, or a transliteration. `e`, `w`, `r`
 *  and a substitution's `w` and `e` flags run a program or touch a file, so a script with one is not read in advance. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/I?)`;

const SED_SAFE = new RegExp(
  String.raw`^(?:${SED_ADDR}(?:,${SED_ADDR})?!?)?\s*(?:[pdqQnNPDgGhHxl=]|s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[gpiImM0-9]*|y(.)(?:(?!\2)[^\\]|\\.)*\2(?:(?!\2)[^\\]|\\.)*\2)$`,
);

export const sedSafe = (script: string) => script.split(/[;\n]/).every((c) => SED_SAFE.test(c.trim()) || c.trim() === "");

/** sed's options that print, read and match differently and nothing more. */
export const SED_FLAGS = new Set(["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate", "-u", "--unbuffered", "-z", "--null-data", "--posix", "--sandbox", "--debug"]);

/** A path in git's own folder, which holds its settings and hooks; a disk that ignores letter case finds `.GIT` there too. */
export const IN_GIT_DIR = /(^|[\\/])\.git([\\/]|$)/i;

export const RUNTIMES = new Set(["node", "deno", "ts-node", "tsx", "ruby", "perl", "php", "java", "lua", "Rscript", "swift"]);
