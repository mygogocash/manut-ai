//! A lane's own working folder (`src/code/laneBranch.ts`). When Kit starts a piece of work in a project, the page asks for a
//! git worktree of the developer's repository on a branch of its own, made from the branch the developer's folder is on. The
//! lane's agent works in that folder, so several lanes can work at once without touching each other's files, and nothing a
//! lane does moves the developer's folder: its branch, index, stash and HEAD stay as they are.
//!
//! Where the folders live: `~/.manut/lanes/<project>/<words>`, under the app's own data folder and never inside the
//! developer's folder or its `.git`. `<project>` is the repository folder's name as one plain word, `<words>` the branch's
//! words after `kit/` (`kit/promptpay-qr` works in `~/.manut/lanes/web-app/promptpay-qr`), with `-2`, `-3` … when that name
//! is taken on disk. git keeps its own note of each worktree in the repository (`.git/worktrees/<name>`), as it does for any.
//!
//! How the app knows its own: beside each folder it makes, a record of it, `<words>.json`, written before git is asked
//! and naming the folder beside it, the repository, the branch and the branch it was made from. Only a folder with such a
//! record, exactly two names below `~/.manut/lanes`, that git still lists as a worktree of the recorded repository, is ever
//! removed. Nothing here runs `git worktree prune`, and `--force` only ever reaches a folder the app made, after the person
//! said yes to what it holds.
//!
//! What comes along: the committed tree only. The developer's uncommitted changes stay in their folder, and nothing git
//! ignores (installed dependencies, build output) is copied or linked, with one named exception: the project's own agent
//! settings git does not hold (`.mcp.json`, `.claude/settings.local.json`, untracked skills), copied by `lane_config.rs` and
//! always ignored by git in the lane. No hook runs while a folder is made or removed, so
//! nothing a project sets up on checkout happens by itself: Kit may install what the lane needs, and the dial asks first.
//!
//! Settings › Worktrees (item 73): the folder lanes are made under can be the person's own (`Start::root`, checked by
//! `check_lanes_root`: never inside a checkout, never unwritable), while the record stays under `~/.manut/lanes`; a lane can start
//! from the remote's latest commit of its base branch (`Start::remote`, `remote_start`); the branch prefix is the page's
//! (`valid_prefix`); and `release` removes a folder for a clean-up only when nothing in it is changed, new or unpushed, and
//! nothing git ignores in it is the developer's own (item 86: only what a project rebuilds and the agent settings the app copied
//! in may go with it).
//!
//! When a folder goes: when its session is closed, if nothing in it would be lost (git says no file in it is changed or new,
//! and it ignores nothing there but what is rebuilt or the app's own copies).
//! Otherwise it is kept, and the Code page lists it with Remove, which says how many changed files go with it; the branch
//! stays unless the person also asks for it to go, and a branch with commits that are not on its base goes only after the
//! person saw how many. Every refusal is a short code the page maps to its own words; the agent still starts without a
//! lane of its own.
//!
//! git runs with a fixed argument list (no shell, nothing on stdin, no prompt), as `tasks.rs` runs its CLIs, and every name
//! from the page is checked here first, so none can be read as an option or a path.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::git_branch;
use crate::tasks;

/// The most names one call tries (the page sends nine).
const NAMES_MAX: usize = 20;
/// The longest a branch name is. The page makes them far shorter.
const NAME_MAX: usize = 64;
/// How long making or removing a lane's folder may take: a checkout writes every file the project tracks, which on a large
/// project takes longer than a read.
const SLOW: Duration = Duration::from_secs(120);
/// The most numbered folder names tried when a lane's own is taken on disk.
const FOLDER_TRIES: usize = 50;
/// The most folders and records read when the lanes are listed: a person never has this many.
const RECORDS_MAX: usize = 500;
/// The kept lanes whose changes and commits are read in one list; the rest say they could not be read.
const STATUS_MAX: usize = 20;
/// The largest record read: one is a few hundred bytes.
const RECORD_BYTES: u64 = 16 * 1024;
/// The most ignored files and folders of a lane's folder a clean-up names when it keeps the folder for them.
pub(crate) const IGNORED_SHOWN: usize = 20;
/// The most ignored files and folders read in one lane's folder; a folder with more is kept, the first ones named.
const IGNORED_MAX: usize = 2000;
/// The most folders under a modules folder, and checked-out submodules of a work tree, whose config one read looks at; a
/// repository with more is read as one that names a program (`?`), and nothing runs in it by itself.
const SUBMODULES_MAX: usize = 100;

/// Making and removing lanes one at a time, so two calls never choose the same folder or remove one twice. Reads take no
/// turn: they only look.
static WRITING: Mutex<()> = Mutex::new(());

/// What was made: the lane's branch, the one it was made from (a short commit when the folder was detached), the folder the
/// lane works in, and the worktree's own folder, which names the lane to the shell when it goes. `dir` is the worktree, or
/// the folder inside it that matches the developer's (a lane started in `apps/web` of a repository works in `apps/web` of
/// its worktree). `left`: how many changed or new files the developer's folder has that did not come along (0 when git
/// could not say), so the lane can say its work starts from the last commit.
#[derive(Debug, Serialize, PartialEq)]
pub struct Made {
    pub branch: String,
    pub base: String,
    pub dir: String,
    pub worktree: String,
    pub left: u32,
    /// The remote branch the lane started from (`origin/main`), when Start from the remote was on and it worked; "" otherwise.
    pub from: String,
    /// Why the lane started from the local branch although Start from the remote was on: `no_remote`, `fetch_failed`,
    /// `detached`, `ahead` (the local branch has commits the remote lacks), `diverged`, `not_in_remote` (the remote's commit has
    /// no such folder); "" when the setting was off or the remote was used. The page says it in the lane's first line.
    pub local: String,
    /// How many of the project's own agent settings files that git does not hold came along (`lane_config.rs`): every one
    /// ignored by git in the lane. `stayed`: how many did not, because git would see them there, or they are links or too big.
    pub config: u32,
    pub stayed: u32,
}

/// What Settings › Worktrees asks of a new lane: where its folder is made ("" is the default under `~/.manut/lanes`) and
/// whether it starts from the latest commit of its base branch on the remote. Both come from the page on each call, never
/// kept here.
#[derive(Debug, Deserialize, Default, Clone)]
pub struct Start {
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub remote: bool,
    /// The lane is made with nobody there (a workflow by the clock, item 114): it is then the app's own doing, so it reads
    /// the repository's own config first and runs git as the automatic pull does ([`Git::automatic`], [`Git::config_risk`]).
    /// A lane the person starts themselves (the chat box, Run now) leaves it false, and is made with their settings and the
    /// repository's, as item 86 decided.
    #[serde(default)]
    pub unattended: bool,
}

/// The app's record of one worktree it made, `<lanes>/<project>/<words>.json`, beside the folder it names.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub(crate) struct Record {
    pub(crate) v: u32,
    /// The worktree's folder: always the record's own path without `.json`.
    pub(crate) worktree: String,
    /// git's own folder of the repository, the one every worktree of it shares (its common dir), as a real path.
    pub(crate) repo: String,
    /// The developer's folder the lane was made from.
    pub(crate) project: String,
    /// Where the lane works inside the worktree ("" or `apps/web`).
    pub(crate) prefix: String,
    pub(crate) branch: String,
    pub(crate) base: String,
    /// The commit the branch was made at.
    pub(crate) at: String,
    /// When, in seconds since 1970.
    pub(crate) made: u64,
}

/// A lane's working folder as the Code page lists it: the folders the app made for one repository, with whether each is still
/// there, how many of its files are changed or new (null: not read), and how many commits on its branch are not on its base
/// (null: not read, or its base is gone).
#[derive(Debug, Serialize, PartialEq)]
pub struct Kept {
    pub worktree: String,
    pub dir: String,
    pub branch: String,
    pub base: String,
    pub made: u64,
    pub exists: bool,
    pub changed: Option<u32>,
    pub ahead: Option<u32>,
    /// How many commits on its branch are on no remote branch (null: not read): what a clean-up keeps a folder for.
    pub unpushed: Option<u32>,
    /// The files and folders git ignores in it that are not plainly rebuilt and the app did not put there (see
    /// [`Git::ignored_own`]), at most [`IGNORED_SHOWN`]: what a clean-up keeps a clean folder for.
    pub ignored: Vec<String>,
    /// Whether it has submodules ([`Git::submodules`]): what changed inside them is not in `changed`, a clean-up leaves it, and
    /// Remove never forces it. False when it could not be read.
    pub submodules: bool,
}

/// What the person said yes to when a lane's folder goes. `changed`: how many changed or new files they saw counted and said
/// may go with it (0: none may, so a folder with any is kept). `branch`: delete the branch too. `ahead`: how many commits on
/// the branch not on its base they saw counted (null: the count could not be read) and said may go with it.
#[derive(Debug, Deserialize, Default)]
pub struct RemoveAsk {
    #[serde(default)]
    pub changed: u32,
    #[serde(default)]
    pub branch: bool,
    #[serde(default)]
    pub ahead: Option<u32>,
}

/// What happened. `removed`: the folder is gone. `deleted`: the branch is gone. When nothing was done because what is there
/// differs from what the person saw, `removed` is false and `changed` and `ahead` say what is there now. `error`: git's own
/// line when the branch could not be deleted after the folder went.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Removed {
    pub removed: bool,
    pub deleted: bool,
    pub changed: Option<u32>,
    pub ahead: Option<u32>,
    pub error: Option<String>,
}

/// Whether `word` is one lower case word or number run joined by single hyphens (`promptpay-qr`).
fn word_ok(word: &str) -> bool {
    !word.is_empty() && word.split('-').all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// Whether `prefix` is a branch prefix Kit makes names with: one or two words ending in `/` (`kit/`, `team/ana/`), at most 24
/// characters. Settings › Worktrees checks the same rule in the page (`src/code/laneBranch.ts`). Only lower case letters,
/// numbers and hyphens, so every prefix is a name git takes and never one a shell, an option or a path reads as anything else.
pub fn valid_prefix(prefix: &str) -> bool {
    let Some(body) = prefix.strip_suffix('/') else { return false };
    let words: Vec<&str> = body.split('/').collect();
    prefix.len() <= 24 && (1..=2).contains(&words.len()) && words[0] != "refs" && words.iter().all(|w| word_ok(w))
}

/// The prefix of a branch name Kit made: everything up to and including the last `/` ("" when there is none).
fn prefix_of(name: &str) -> &str {
    name.rfind('/').map_or("", |i| &name[..=i])
}

/// Whether `name` is a branch name Kit makes: a prefix (see [`valid_prefix`]) and then lower case words and numbers joined by
/// single hyphens. A lane made under an earlier prefix keeps its name, so any prefix is read here, not only the current one.
pub fn valid_name(name: &str) -> bool {
    name.len() <= NAME_MAX && valid_prefix(prefix_of(name)) && word_ok(&name[prefix_of(name).len()..])
}

/// `<home>/.manut/lanes`: the app's own folder for every lane's working folder.
pub fn lanes_dir(home: &Path) -> PathBuf {
    home.join(".manut").join("lanes")
}

/// Whether `path` is a lane's working folder or a folder inside one: two names or more below [`lanes_dir`]. turn_files.rs
/// keeps a lane's turns there, while the app's own data folder around it stays far too broad to keep.
pub fn in_a_lane(home: &Path, path: &Path) -> bool {
    path.strip_prefix(lanes_dir(home)).map(|rest| rest.components().count() >= 2 && rest.components().all(|c| matches!(c, Component::Normal(_)))).unwrap_or(false) || in_a_record(home, path)
}

/// Whether `path` is the folder of a lane made under a folder the person chose, or inside it: the folder a record names. `path`
/// must be a real path, as the callers' are, and has no `..` in it.
pub fn in_a_record(home: &Path, path: &Path) -> bool {
    path.is_absolute() && path.components().all(|c| matches!(c, Component::RootDir | Component::Prefix(_) | Component::Normal(_))) && records(home).iter().any(|(_, r)| path.starts_with(Path::new(&r.worktree)) || path.starts_with(real(Path::new(&r.worktree))))
}

/// The files and folders git keeps while it is partway through something that moves `HEAD` or the index. A lane made then
/// would start from the middle of the developer's own operation.
const IN_PROGRESS: [&str; 7] = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"];

fn in_progress(git_dir: &Path) -> bool {
    IN_PROGRESS.iter().any(|f| git_dir.join(f).exists())
}

/// The environment variables that would point `git` at another repository than the folder it is run in, or at another one's
/// objects (`GIT_ALTERNATE_OBJECT_DIRECTORIES`, which git_moved.rs and turn_files.rs take out too).
const REDIRECTS: [&str; 8] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

/// The person's own `git`, run with no hook and no file-system monitor (each can run a program the repository names: a
/// post-checkout hook that installs dependencies, a reference-transaction hook on a deleted branch), English messages, no
/// prompt, and no optional lock (a status never takes the index's lock to refresh it).
///
/// Work the app starts by itself (the automatic pull, the merged clean-up, a deleted chat's folder, the kept list, the lane's
/// Diff) first reads the repository's own config ([`Git::config_risk`]) and does nothing while it names a program git would
/// run or another address to fetch from, and it never goes into a submodule (item 90): a git started inside one reads that
/// submodule's own config and attributes, which neither that read nor any `-c` here reaches. Work the person asked for by pressing something (a lane started, a push after a Yes,
/// Remove) runs with the person's and the repository's settings, as the same git in a terminal would, hooks and the file
/// monitor aside.
pub(crate) struct Git {
    pub(crate) exe: PathBuf,
    /// `core.hooksPath`: a folder that is never made, so git finds no hook in it.
    hooks: String,
    /// Work the app starts by itself: `protocol.ext.allow=never` too, so a remote of the `ext::` kind (a shell command) never runs.
    automatic: bool,
}

/// The settings of a repository's own config that make git run a program, or send a fetch somewhere else, without anyone
/// asking, by `git help config`: `filter.<driver>.clean`, `.smudge` and `.process` (run by `status`, `diff` and a checkout),
/// `core.sshCommand`, `core.gitProxy` and `core.askPass` (run by a fetch), `core.alternateRefsCommand` (run by a fetch in a
/// repository with alternates), `credential.helper` and `credential.<url>.helper` (run by a fetch over https),
/// `remote.<name>.uploadpack`, `.receivepack` and `.vcs` (a program for a remote), a `remote.<name>.url` or `.pushurl` of the
/// `<transport>::<address>` form (a remote helper, `ext::` runs a shell command), and `url.<base>.insteadOf` and
/// `.pushInsteadOf` (a fetch sent elsewhere).
///
/// Item 114 (third security review, 26 Nov 2026), read family by family from `git help config` (git 2.54): what sends a
/// fetch to another place, changes what it trusts or what it sends. Every `http.*` and `http.<url>.*` key (a proxy that
/// answers 401 is handed the person's login; certificates, pinned keys, a name resolved elsewhere, redirects, headers,
/// cookies), `remote.<name>.proxy` and `.proxyAuthMethod`, every `credential.*` key, `ssh.variant`, every `protocol.*` key
/// (which transports git takes), `fetch.bundleURI` and `transfer.bundleURI` (a download from another address), and
/// `core.protectHFS` and `.protectNTFS` (a checkout's guard against names that write into `.git`), and a
/// `submodule.<name>.update` that names a command (`!`). `docs/code-editor.md` has each family's decision.
///
/// What the app's own runs switch off instead is not listed: hooks (`core.hooksPath`), `core.fsmonitor`, an external diff and
/// a text conversion (`--no-ext-diff --no-textconv` on every diff), a signature check's `gpg.program`
/// (`--no-verify-signatures` on the pull's one write), a configured fetch refspec (`--refmap=` on the fetch), and a pager or
/// an editor, which git starts only for a terminal. `key` is as `git config --list` prints it (section and name in lower
/// case).
fn runs_or_redirects(key: &str, value: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    let (section, rest) = lower.split_once('.').unwrap_or((lower.as_str(), ""));
    let name = rest.rsplit('.').next().unwrap_or("");
    let sub = rest.contains('.');
    let helper = |v: &str| v.split_once("::").is_some_and(|(t, _)| !t.is_empty() && t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')));
    match section {
        "filter" => sub && matches!(name, "clean" | "smudge" | "process"),
        "core" => !sub && matches!(name, "sshcommand" | "gitproxy" | "askpass" | "alternaterefscommand" | "protecthfs" | "protectntfs"),
        // every key of these: each says where a fetch goes, what it trusts or what it sends, or is a program
        "http" | "credential" | "url" | "ssh" | "protocol" => true,
        "remote" => sub && (matches!(name, "uploadpack" | "receivepack" | "vcs" | "proxy" | "proxyauthmethod") || (matches!(name, "url" | "pushurl") && helper(value))),
        "fetch" | "transfer" => !sub && name == "bundleuri",
        "submodule" => sub && name == "update" && value.trim_start().starts_with('!'),
        _ => false,
    }
}

/// The first setting [`runs_or_redirects`] names in `listing`, the output of `git config --list --show-scope --includes -z`
/// (`scoped`: each entry is its scope, then `key\nvalue`) or of `git config --list --local --includes -z` (every entry the
/// repository's own). Only the repository's own scopes count (`local`, `worktree`, and the files they include): the person's
/// global and system settings are theirs, and run in their terminal too. A subsection that is an address (`url.<base>`,
/// `credential.<url>`) is shown as `*`, since it can hold a token, and the rest passes the one masker.
pub(crate) fn risky_setting(listing: &str, scoped: bool) -> Option<String> {
    risky_by(listing, scoped, runs_or_redirects)
}

/// The settings of a submodule's own config that make git run a program while it works inside that submodule: every one
/// [`runs_or_redirects`] names, and a diff driver's program (`diff.external`, `diff.<driver>.command` and `.textconv`), since the
/// `--no-ext-diff --no-textconv` on the app's own diffs do not reach a diff git runs inside a submodule (`diff.submodule=diff`).
/// Hooks and the file monitor are not listed: the app's `-c core.hooksPath` and `-c core.fsmonitor=false` reach every git that
/// git itself starts, a submodule's included (`git help config`, `GIT_CONFIG_PARAMETERS`).
fn runs_in_a_submodule(key: &str, value: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    let driver = lower.strip_prefix("diff.").is_some_and(|rest| rest.contains('.') && (rest.ends_with(".command") || rest.ends_with(".textconv")));
    runs_or_redirects(key, value) || lower == "diff.external" || driver
}

/// [`risky_setting`], with `risky` saying which settings count.
fn risky_by(listing: &str, scoped: bool, risky: fn(&str, &str) -> bool) -> Option<String> {
    let mut parts = listing.split('\0').filter(|p| !p.is_empty());
    loop {
        let scope = if scoped { parts.next()? } else { "local" };
        let kv = parts.next()?;
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let (key, value) = kv.split_once('\n').unwrap_or((kv, ""));
        if risky(key, value) {
            let lower = key.to_ascii_lowercase();
            let shown = match lower.split_once('.') {
                Some((section @ ("url" | "credential" | "http"), rest)) if rest.contains('.') => format!("{section}.*.{}", rest.rsplit('.').next().unwrap_or("")),
                _ => key.to_string(),
            };
            return Some(tasks::mask_secrets(&shown));
        }
    }
}

/// How [`config_risk_by`] runs git: `git <args>` in the folder being read, through the caller's own runner, Some when git ran.
pub(crate) type Runner<'a> = dyn Fn(&[&str]) -> Option<tasks::Ran> + 'a;

/// How deep a modules folder is walked: a submodule's name can hold `/`, and a submodule can have submodules of its own.
const MODULES_DEPTH: usize = 8;

/// The setting that makes work the app starts by itself run a program or fetch elsewhere, in the repository `cwd` is in or in
/// any of its submodules, or None (item 86, item 90). Read with `--includes`, so a file a config includes counts as its own; a
/// git too old to say each setting's scope (before 2.26) is asked for the local file alone. What cannot be read is not taken
/// as having nothing in it: it is `?`.
///
/// The repository's own scopes first ([`risky_setting`]). Then every submodule's own config, since a git that reached into one
/// would read it there, where no `-c` of the app reaches (the app's runs never go into one: this is the second guard): each git
/// folder under the work tree's modules folder (`git rev-parse --git-path modules`, the worktree's own for a lane), nested ones
/// too, walked without following a link, and the git folder of each submodule checked out in the work tree that is not under
/// it (`<path>/.git`, a folder or a file that names one anywhere: `gitdir:`). A submodule's setting is named `<where>:<setting>`
/// (`modules/sub:filter.spy.clean`). Attributes are not read: `.gitattributes`, `info/attributes` and `core.attributesFile` only
/// name a filter or diff driver, which runs nothing unless a config defines its program, and every config git reads for the
/// repository and its submodules is read here (the person's own global and system settings aside, theirs as in a terminal).
pub(crate) fn config_risk_by(run: &Runner, cwd: &Path) -> Option<String> {
    if let Some(s) = listing_risk(run, None, runs_or_redirects) {
        return Some(s);
    }
    submodule_risk(run, cwd).map(|s| tasks::one_line(tasks::mask_secrets(&s), 200))
}

/// What one config listing says (see [`config_risk_by`]): the repository's own, or with `git_dir` another git folder's (a
/// submodule's, as git itself reads it there: `includeIf` is matched against that folder).
fn listing_risk(run: &Runner, git_dir: Option<&Path>, risky: fn(&str, &str) -> bool) -> Option<String> {
    let dir = git_dir.map(|d| format!("--git-dir={}", d.display()));
    let ok = |rest: &[&str]| -> Option<tasks::Ran> {
        let mut args: Vec<&str> = dir.iter().map(String::as_str).collect();
        args.extend_from_slice(rest);
        run(&args).filter(|r| r.code == Some(0))
    };
    if let Some(r) = ok(&["config", "--list", "--show-scope", "--includes", "-z"]) {
        return risky_by(&r.out, true, risky);
    }
    match ok(&["config", "--list", "--local", "--includes", "-z"]) {
        Some(r) => risky_by(&r.out, false, risky),
        None => Some("?".into()),
    }
}

/// The paths of the gitlinks (submodules) in a `git ls-files -s -z` listing, or None when it may have been cut short.
fn gitlinks(listing: &tasks::Ran) -> Option<Vec<&str>> {
    if listing.code != Some(0) || listing.out.len() as u64 >= tasks::MAX_OUT {
        return None;
    }
    Some(listing.out.split('\0').filter_map(|e| e.strip_prefix("160000 ")).filter_map(|e| e.split_once('\t').map(|(_, p)| p)).collect())
}

/// `p` as git printed it, from the folder `cwd`.
fn from_cwd(cwd: &Path, p: &str) -> PathBuf {
    let p = PathBuf::from(p);
    if p.is_absolute() {
        p
    } else {
        cwd.join(p)
    }
}

/// The submodules' half of [`config_risk_by`].
fn submodule_risk(run: &Runner, cwd: &Path) -> Option<String> {
    let lines = |args: &[&str]| run(args).filter(|r| r.code == Some(0)).map(|r| r.out.lines().map(|l| l.trim().to_string()).collect::<Vec<_>>());
    let Some(at) = lines(&["rev-parse", "--show-toplevel", "--git-path", "modules"]) else { return Some("modules:?".into()) };
    let (Some(top), Some(modules)) = (at.first().filter(|l| !l.is_empty()), at.get(1).filter(|l| !l.is_empty())) else { return Some("modules:?".into()) };
    let (top, modules) = (from_cwd(cwd, top), from_cwd(cwd, modules));
    let mut seen = 0usize;
    if let Some(s) = walk_modules(run, &modules, "modules", 0, &mut seen) {
        return Some(s);
    }
    // a submodule checked out with its git folder somewhere else than the modules folder
    let Some(listing) = run(&["ls-files", "-s", "-z"]) else { return Some("submodules:?".into()) };
    let Some(links) = gitlinks(&listing) else { return Some("submodules:?".into()) };
    let modules_real = real(&modules);
    for path in links {
        let shown = format!("{path}/.git");
        if !Path::new(path).components().all(|c| matches!(c, Component::Normal(_))) {
            return Some(format!("{shown}:?"));
        }
        let dot = top.join(path).join(".git");
        let Ok(md) = fs::symlink_metadata(&dot) else { continue };
        seen += 1;
        if seen > SUBMODULES_MAX || md.file_type().is_symlink() {
            return Some(format!("{shown}:?"));
        }
        let git_dir = if md.is_dir() {
            dot.clone()
        } else {
            // `gitdir: <folder>`, relative to the folder the file is in
            let mut text = String::new();
            if fs::File::open(&dot).and_then(|f| f.take(4096).read_to_string(&mut text)).is_err() {
                return Some(format!("{shown}:?"));
            }
            let Some(target) = text.lines().next().and_then(|l| l.strip_prefix("gitdir:")).map(str::trim).filter(|t| !t.is_empty()) else {
                return Some(format!("{shown}:?"));
            };
            let target = from_cwd(&top.join(path), target);
            // one under the modules folder was read with it
            if real(&target).starts_with(&modules_real) {
                continue;
            }
            target
        };
        if let Some(s) = listing_risk(run, Some(&git_dir), runs_in_a_submodule) {
            return Some(format!("{shown}:{s}"));
        }
        if let Some(s) = walk_modules(run, &git_dir.join("modules"), &format!("{shown}/modules"), 1, &mut seen) {
            return Some(s);
        }
    }
    None
}

/// Reads every submodule git folder under `dir` (shown as `shown`), as [`config_risk_by`] says: a folder with a `config` file is
/// one, and its own `modules` folder is read in turn; any other folder is part of a name with `/` in it. A link, a folder git
/// cannot read, more than [`SUBMODULES_MAX`] folders or deeper than [`MODULES_DEPTH`] is `?`. None: nothing there names a
/// program (or there is no such folder).
fn walk_modules(run: &Runner, dir: &Path, shown: &str, depth: usize, seen: &mut usize) -> Option<String> {
    let md = fs::symlink_metadata(dir).ok()?;
    if !md.is_dir() {
        return Some(format!("{shown}:?"));
    }
    let Ok(read) = fs::read_dir(dir) else { return Some(format!("{shown}:?")) };
    let mut entries: Vec<fs::DirEntry> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let here = format!("{shown}/{name}");
        let Ok(ft) = e.file_type() else { return Some(format!("{here}:?")) };
        if ft.is_symlink() {
            return Some(format!("{here}:?"));
        }
        if !ft.is_dir() {
            // a stray file (`.DS_Store`): no git folder
            continue;
        }
        *seen += 1;
        if *seen > SUBMODULES_MAX {
            return Some("modules:?".into());
        }
        if depth + 1 > MODULES_DEPTH {
            return Some(format!("{here}:?"));
        }
        let p = e.path();
        match fs::symlink_metadata(p.join("config")) {
            Ok(c) if c.file_type().is_symlink() || !c.is_file() => return Some(format!("{here}:?")),
            Ok(_) => {
                if let Some(s) = listing_risk(run, Some(&p), runs_in_a_submodule) {
                    return Some(format!("{here}:{s}"));
                }
                if let Some(s) = walk_modules(run, &p.join("modules"), &format!("{here}/modules"), depth + 1, seen) {
                    return Some(s);
                }
            }
            Err(_) => {
                if let Some(s) = walk_modules(run, &p, &here, depth + 1, seen) {
                    return Some(s);
                }
            }
        }
    }
    None
}

impl Git {
    pub(crate) fn new(home: &Path) -> Result<Git, String> {
        let exe = tasks::find("git").ok_or("git_missing")?;
        Ok(Git { exe, hooks: format!("core.hooksPath={}", lanes_dir(home).join(".no-hooks").display()), automatic: false })
    }

    /// The runner for work the app starts by itself (see [`Git`]): as [`Git::new`], and `ext::` remotes refused outright.
    pub(crate) fn automatic(home: &Path) -> Result<Git, String> {
        Ok(Git { automatic: true, ..Git::new(home)? })
    }

    /// The setting of the repository `cwd` is in, or of one of its submodules, that makes automatic work run a program or fetch
    /// elsewhere, or None: [`config_risk_by`], through this runner.
    pub(crate) fn config_risk(&self, cwd: &Path) -> Option<String> {
        config_risk_by(&|args: &[&str]| self.run(cwd, args).ok(), cwd)
    }

    /// `git -C <cwd> <args>`, at most `limit`.
    pub(crate) fn run_for(&self, cwd: &Path, args: &[&str], limit: Duration) -> Result<tasks::Ran, String> {
        self.run_with(cwd, args, limit, &[])
    }

    /// `run_for` with `extra` added to git's environment (a fetch's: nothing may ask for a password).
    pub(crate) fn run_with(&self, cwd: &Path, args: &[&str], limit: Duration, extra: &[(&str, &str)]) -> Result<tasks::Ran, String> {
        let mut argv: Vec<String> = vec!["-C".into(), cwd.to_string_lossy().into_owned(), "-c".into(), self.hooks.clone(), "-c".into(), "core.fsmonitor=false".into()];
        if self.automatic {
            argv.extend(["-c".into(), "protocol.ext.allow=never".into()]);
            // Never into a submodule (item 90): a git started inside one reads that submodule's own config and attributes,
            // which no `-c` here reaches, so its clean filter would run. Each command that can descend says so itself
            // (`--ignore-submodules=all` on status and diff, `--no-recurse-submodules` on the fetch); these two are the
            // defaults for anything that does not, by `git help config`.
            argv.extend(["-c".into(), "submodule.recurse=false".into(), "-c".into(), "diff.ignoreSubmodules=all".into()]);
        }
        argv.extend(args.iter().map(|a| (*a).to_string()));
        let mut env: Vec<(&str, &str)> = vec![("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C"), ("GIT_OPTIONAL_LOCKS", "0")];
        env.extend_from_slice(extra);
        tasks::run_env_for(&self.exe, &argv, true, &env, &REDIRECTS, limit)
    }

    pub(crate) fn run(&self, cwd: &Path, args: &[&str]) -> Result<tasks::Ran, String> {
        self.run_for(cwd, args, tasks::TIMEOUT)
    }

    /// The first line git printed, when it ran and said yes.
    pub(crate) fn line(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        let ran = self.run(cwd, args).ok()?;
        (ran.code == Some(0)).then(|| ran.out.lines().next().unwrap_or("").trim().to_string())
    }

    /// git's own folder for the repository `cwd` is in, the one every worktree of it shares, as a real path.
    pub(crate) fn common_dir(&self, cwd: &Path) -> Option<PathBuf> {
        let line = self.line(cwd, &["rev-parse", "--git-common-dir"]).filter(|l| !l.is_empty())?;
        let p = PathBuf::from(line);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        p.canonicalize().ok()
    }

    /// The branches under `prefix` (`kit/`) that exist, lower-cased (a file system that ignores letter case treats two as one).
    fn taken(&self, cwd: &Path, prefix: &str) -> Result<HashSet<String>, String> {
        let pattern = format!("refs/heads/{prefix}");
        let ran = self.run(cwd, &["for-each-ref", "--format=%(refname:short)", &pattern])?;
        if ran.code != Some(0) {
            return Err(tasks::error_line(&ran.err));
        }
        Ok(ran.out.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect())
    }

    /// The worktrees git lists for the repository whose git folder is `repo`, as real paths where they exist.
    pub(crate) fn worktrees(&self, repo: &Path) -> Option<Vec<PathBuf>> {
        let ran = self.run(repo, &["worktree", "list", "--porcelain"]).ok()?;
        if ran.code != Some(0) {
            return None;
        }
        Some(ran.out.lines().filter_map(|l| l.strip_prefix("worktree ")).map(|p| real(Path::new(p))).collect())
    }

    /// How many files in worktree `wt` are changed or new (not ignored), or None when git could not say. A submodule is not
    /// counted, changed or not (item 90): to say whether one changed git runs `status` inside it, which reads the submodule's
    /// own config and attributes and so runs any clean filter they name.
    pub(crate) fn changed(&self, wt: &Path) -> Option<u32> {
        let ran = self.run(wt, &["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]).ok()?;
        (ran.code == Some(0)).then(|| ran.out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
    }

    /// How many commits on `branch` are not on `base` (the branch it was made from, as it is now; else the commit it was
    /// made at, when that branch is gone), or None when git could not say.
    pub(crate) fn ahead(&self, at: &Path, rec: &Record) -> Option<u32> {
        if !valid_name(&rec.branch) {
            return None;
        }
        for from in [rec.base.as_str(), rec.at.as_str()] {
            if !safe_rev(from) {
                continue;
            }
            let range = format!("{from}..{}", rec.branch);
            if let Some(n) = self.line(at, &["rev-list", "--count", &range]).and_then(|l| l.parse().ok()) {
                return Some(n);
            }
        }
        None
    }
}

/// Whether `rel` (a path git listed as ignored, a folder ending in `/`) is something a project rebuilds or the system writes:
/// inside a folder named in `turn_files::REBUILT` (the list Rewind already leaves out of a folder with no ignore rules to read,
/// `node_modules`, `target`, `dist`, `.next`, `.venv` and the rest), or a file named in `turn_files::SYSTEM_FILES` (`.DS_Store`).
fn rebuilt(rel: &str) -> bool {
    let folder = rel.ends_with('/');
    let parts: Vec<&str> = rel.trim_end_matches('/').split('/').filter(|p| !p.is_empty()).collect();
    let Some((last, dirs)) = parts.split_last() else { return false };
    dirs.iter().any(|d| crate::turn_files::REBUILT.contains(d)) || (folder && crate::turn_files::REBUILT.contains(last)) || (!folder && crate::turn_files::SYSTEM_FILES.contains(last))
}

impl Git {
    /// What git ignores in the lane's folder `wt` that a clean-up may not take without a yes: every ignored file or folder but
    /// what a project rebuilds and the system writes ([`rebuilt`]) and the agent settings the app copied in for the lane made in
    /// `prefix` (`lane_config::brought_here`). git lists a folder it ignores as a whole once (`--directory`, ending in `/`); one
    /// that may hold copied settings (`.claude/`) is read inside, file by file. Sorted as git lists them, at most
    /// [`IGNORED_MAX`]; None when git could not say.
    pub(crate) fn ignored_own(&self, wt: &Path, prefix: &str) -> Option<Vec<String>> {
        let list = |extra: &[&str]| -> Option<Vec<String>> {
            let mut args = vec!["ls-files", "-z", "--others", "--ignored", "--exclude-standard"];
            args.extend_from_slice(extra);
            let ran = self.run_with(wt, &args, tasks::TIMEOUT, &[("GIT_LITERAL_PATHSPECS", "1")]).ok()?;
            (ran.code == Some(0)).then(|| ran.out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
        };
        let mut own: Vec<String> = Vec::new();
        for e in list(&["--directory", "--no-empty-directory"])? {
            if own.len() >= IGNORED_MAX {
                break;
            }
            if rebuilt(&e) {
                continue;
            }
            match e.strip_suffix('/') {
                Some(dir) if crate::lane_config::may_hold_brought(dir, prefix) => {
                    for f in list(&["--", dir])? {
                        if !rebuilt(&f) && !crate::lane_config::brought_here(&f, prefix) {
                            own.push(f);
                        }
                    }
                }
                Some(_) => own.push(e),
                None if crate::lane_config::brought_here(&e, prefix) => {}
                None => own.push(e),
            }
        }
        own.truncate(IGNORED_MAX);
        Some(own)
    }

    /// How many commits on `branch` are on no remote branch (the ones a clean-up keeps a folder for), or None when git could
    /// not say. With no remote at all that is every commit of the branch.
    pub(crate) fn unpushed(&self, at: &Path, branch: &str) -> Option<u32> {
        if !valid_name(branch) {
            return None;
        }
        let r = format!("refs/heads/{branch}");
        self.line(at, &["rev-list", "--count", &r, "--not", "--remotes"]).and_then(|l| l.parse().ok())
    }

    /// Whether the work tree `wt` has submodules (item 90): a gitlink in its index, checked out or not (an empty submodule
    /// folder can hold files git lists nowhere, and `git worktree remove` takes them), or a modules folder of its own (a submodule
    /// checked out there once, whose commits may be nowhere else). None when git could not say. Nothing inside a submodule is
    /// read by itself (see [`Git::changed`]), so what one holds is not known: whatever could take it or move past it (a clean-up,
    /// a force, the automatic pull) does not happen without the person.
    pub(crate) fn submodules(&self, wt: &Path) -> Option<bool> {
        let modules = self.line(wt, &["rev-parse", "--git-path", "modules"]).filter(|l| !l.is_empty())?;
        if fs::symlink_metadata(from_cwd(wt, &modules)).is_ok() {
            return Some(true);
        }
        let listing = self.run(wt, &["ls-files", "-s", "-z"]).ok()?;
        gitlinks(&listing).map(|l| !l.is_empty())
    }

    /// Whether the worktree at `wt` is partway through a rebase, merge, cherry-pick, revert or bisect, or holds an index lock.
    pub(crate) fn busy(&self, wt: &Path) -> bool {
        match self.line(wt, &["rev-parse", "--absolute-git-dir"]) {
            Some(d) if !d.is_empty() => in_progress(Path::new(&d)),
            // git could not say: a folder that cannot be read is not one to remove
            _ => true,
        }
    }
}

/// `p` as its real path when it exists, else as it is.
pub(crate) fn real(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// Whether `rev` is a branch name or commit id that can stand on either side of `..` and never be read as an option.
pub(crate) fn safe_rev(rev: &str) -> bool {
    !rev.is_empty()
        && rev.len() <= 200
        && !rev.starts_with(['-', '.', '/'])
        && !rev.ends_with(['/', '.'])
        && !rev.contains("..")
        && !rev.contains("//")
        && !rev.ends_with(".lock")
        && rev.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

/// The repository folder's name as one plain word for the folder that holds its lanes: letters, digits, `.`, `_` and `-`,
/// anything else as one `-`, at most 40 characters, never starting or ending with a dot or a hyphen; `project` when nothing
/// is left. So it is never `.`, `..` or a word git or a shell reads as anything but a name.
fn project_word(top: &Path) -> String {
    let raw = top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = String::new();
    for c in raw.chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let trim = |s: &str| s.trim_matches(|c| c == '-' || c == '.').to_string();
    let out: String = trim(&out).chars().take(40).collect();
    let out = trim(&out);
    if out.is_empty() {
        "project".into()
    } else {
        out
    }
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Makes `dir` for this account only when it is missing, and refuses one that is a link or a file: the folders lanes live in
/// are the app's own, and nothing is written through a link.
fn own_dir(dir: &Path) -> Result<(), String> {
    let check = || match fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_symlink() => Err(format!("{} is a link", dir.display())),
        Ok(m) if !m.is_dir() => Err(format!("{} is not a folder", dir.display())),
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    };
    if check()? {
        return Ok(());
    }
    #[cfg(unix)]
    let made = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(dir)
    };
    #[cfg(not(unix))]
    let made = fs::create_dir(dir);
    match made {
        Ok(()) => Ok(()),
        // another call made it first: it is used if it is a folder
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => check().map(|_| ()),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes `bytes` to the new file `path`, readable by this account only. A file or link already at `path` is never written
/// through: the call fails instead.
fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(path)?;
    f.write_all(bytes).inspect_err(|_| {
        let _ = fs::remove_file(path);
    })
}

/// Whether a record's folder `wt` is one the record may name: the folder beside it (`own`, the record's own path without
/// `.json`), or, for a lane made under a folder the person chose in Settings › Worktrees, an absolute folder with no `.` or
/// `..` in it that has the same last name. The record itself always stays under `~/.manut/lanes`, which only the app writes,
/// so a record can still never name the developer's folder or anything else it did not make: a folder is removed only when
/// git lists it as a worktree of the recorded repository too (see [`remove`]).
fn worktree_ok(wt: &Path, own: &Path) -> bool {
    wt == own || (wt.is_absolute() && wt.file_name().is_some() && wt.file_name() == own.file_name() && wt.components().all(|c| matches!(c, Component::RootDir | Component::Prefix(_) | Component::Normal(_))))
}

/// The record at `path`, when it is a plain file the app wrote: a link, a file too big or one that does not read as a
/// record is no record. Its folder must be the one beside it or a chosen folder's with the same name ([`worktree_ok`]).
fn read_record(path: &Path) -> Option<Record> {
    let md = fs::symlink_metadata(path).ok()?;
    if !md.is_file() || md.len() > RECORD_BYTES {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path).ok()?.take(RECORD_BYTES).read_to_string(&mut text).ok()?;
    let r: Record = serde_json::from_str(&text).ok()?;
    let own = path.with_extension("");
    (r.v == 1 && valid_name(&r.branch) && worktree_ok(Path::new(&r.worktree), &own) && Path::new(&r.repo).is_absolute()).then_some(r)
}

/// Every record of a folder the app made, with its path: `<lanes>/<project>/<words>.json`, two names below the lanes'
/// folder, none of them a link.
pub(crate) fn records(home: &Path) -> Vec<(PathBuf, Record)> {
    let lanes = lanes_dir(home);
    if is_link(&home.join(".manut")) || is_link(&lanes) {
        return Vec::new();
    }
    let Ok(projects) = fs::read_dir(&lanes) else { return Vec::new() };
    let mut out = Vec::new();
    for p in projects.flatten().take(RECORDS_MAX) {
        // the entry's own type: a link to a folder is not a folder here
        if !p.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(files) = fs::read_dir(p.path()) else { continue };
        for f in files.flatten().take(RECORDS_MAX) {
            let path = f.path();
            if f.file_type().map(|t| t.is_file()).unwrap_or(false) && path.extension() == Some(OsStr::new("json")) {
                if let Some(r) = read_record(&path) {
                    out.push((path, r));
                }
            }
        }
    }
    out
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The folder the person chose for lanes (Settings › Worktrees) as the real path lanes are made under, made when it is missing,
/// or a short code for why not. Checked when it is chosen and again each time a lane is made, since a folder can become a
/// checkout or lose its write permission afterwards:
///
/// - `bad_root`: not an absolute path, or one with `.` or `..` in it.
/// - `root_too_broad`: the disk's root, the home folder, or the app's own data folder (`~/.manut`).
/// - `root_in_checkout`: inside a repository's own work tree (a `.git` in it or in a folder above it, the home folder aside), so
///   a lane's folder would sit among the developer's own files and show up in their `git status`.
/// - `root_unwritable`: not a folder, or one a file cannot be made in.
pub fn check_lanes_root(home: &Path, root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    if root.is_empty() || root.chars().any(char::is_control) || !path.is_absolute() || path.components().any(|c| !matches!(c, Component::RootDir | Component::Prefix(_) | Component::Normal(_))) {
        return Err("bad_root".into());
    }
    // the folder as a real path even when it is not made yet: the nearest folder that exists, then the names after it
    let mut tail: Vec<&OsStr> = Vec::new();
    let mut at = path;
    let base = loop {
        match at.canonicalize() {
            Ok(b) => break b,
            Err(_) => {
                let (Some(name), Some(parent)) = (at.file_name(), at.parent()) else { return Err("bad_root".into()) };
                tail.push(name);
                at = parent;
            }
        }
    };
    let real = tail.iter().rev().fold(base, |acc, n| acc.join(n));
    let home_real = real_of(home);
    if real.parent().is_none() || real == home_real || real.starts_with(home_real.join(".manut")) {
        return Err("root_too_broad".into());
    }
    // a repository's work tree: every folder from it up to the home folder (or to the top, outside it)
    for a in real.ancestors() {
        if a == home_real || a.parent().is_none() {
            break;
        }
        if fs::symlink_metadata(a.join(".git")).is_ok() {
            return Err("root_in_checkout".into());
        }
    }
    fs::create_dir_all(&real).map_err(|_| "root_unwritable")?;
    if !real.is_dir() {
        return Err("root_unwritable".into());
    }
    // writable for real: a file made and taken away again
    let probe = real.join(format!(".manut-write-test-{}", std::process::id()));
    write_new(&probe, b"").map_err(|_| "root_unwritable")?;
    let _ = fs::remove_file(&probe);
    Ok(real)
}

/// `p` as a real path when it exists, else as it is (a name, as [`real`], but for a home folder passed by tests too).
fn real_of(p: &Path) -> PathBuf {
    real(p)
}

/// The most time a fetch of the base branch may take before the lane starts from the local branch instead. A lane is made while
/// the person waits for their first message to be answered, so the wait is short, and the chat itself is open the whole time.
const FETCH_LIMIT: Duration = Duration::from_secs(10);

/// The environment of a command that reaches the network, so none can wait for a person who is not there: git asks no password
/// on a terminal or through a helper program, the credential manager shows no window, and ssh asks no passphrase (unless the
/// person set their own ssh command, which is left as theirs).
pub(crate) fn net_env(git: &Git, cwd: &Path) -> Vec<(&'static str, String)> {
    let mut env = vec![("GIT_ASKPASS", "true".to_string()), ("SSH_ASKPASS", "true".to_string()), ("GCM_INTERACTIVE", "never".to_string())];
    let own_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() || git.line(cwd, &["config", "--get", "core.sshCommand"]).is_some_and(|l| !l.is_empty());
    if !own_ssh {
        env.push(("GIT_SSH_COMMAND", "ssh -o BatchMode=yes".to_string()));
    }
    env
}

/// Fetches branch `branch` of `remote` into its remote-tracking branch, nothing else: no tags, no submodules, no other
/// branch, no maintenance run. Err is git's own last line, or the time limit. The only write is the remote-tracking branch,
/// as any `git fetch` makes: `--refmap=` (an empty one) keeps a configured `remote.<name>.fetch` from also writing the
/// fetched commit onto another ref, which git otherwise does for a branch named on the command line (item 114).
pub(crate) fn fetch_branch(git: &Git, cwd: &Path, remote: &str, branch: &str) -> Result<(), String> {
    if !safe_rev(remote) || !safe_rev(branch) {
        return Err("bad_name".into());
    }
    let spec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
    let env = net_env(git, cwd);
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let ran = git.run_with(cwd, &["fetch", "--refmap=", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", remote, &spec], FETCH_LIMIT, &env)?;
    if ran.code == Some(0) {
        Ok(())
    } else {
        Err(tasks::error_line(&ran.err))
    }
}

/// The remote and the branch on it that local branch `base` stands for: the one it tracks, else the same name on `origin`.
/// Err(`no_remote`) when the repository has no such remote.
fn remote_of(git: &Git, cwd: &Path, base: &str) -> Result<(String, String), String> {
    let remotes: Vec<String> = git.run(cwd, &["remote"]).ok().filter(|r| r.code == Some(0)).map(|r| r.out.lines().map(|l| l.trim().to_string()).collect()).unwrap_or_default();
    let tracked = git.line(cwd, &["config", "--get", &format!("branch.{base}.remote")]).filter(|r| !r.is_empty() && r != ".");
    let merge = git.line(cwd, &["config", "--get", &format!("branch.{base}.merge")]).and_then(|m| m.strip_prefix("refs/heads/").map(str::to_string));
    match tracked {
        Some(r) if remotes.contains(&r) && safe_rev(&r) => Ok((r, merge.filter(|m| safe_rev(m)).unwrap_or_else(|| base.to_string()))),
        _ if remotes.iter().any(|r| r == "origin") => Ok(("origin".into(), base.to_string())),
        _ => Err("no_remote".into()),
    }
}

/// Where a lane starts when Start from the remote is on: the commit of `base`'s branch on its remote as it is now, with its name
/// (`origin/main`), or why the local commit is used (see [`Made::local`]). The fetch reads one branch, ends within
/// [`FETCH_LIMIT`] and asks no password. The remote's commit is used only when the local branch is that commit or behind it:
/// a local branch with commits of its own (ahead, or both moved) would lose them in the lane, so it starts from the local one.
fn remote_start(git: &Git, cwd: &Path, base: &str, prefix: &str, local_at: &str) -> Result<(String, String), String> {
    let branch_ref = format!("refs/heads/{base}");
    if !safe_rev(base) || git.line(cwd, &["rev-parse", "--verify", "--quiet", &branch_ref]).as_deref() != Some(local_at) {
        return Err("detached".into());
    }
    let (remote, theirs) = remote_of(git, cwd, base)?;
    fetch_branch(git, cwd, &remote, &theirs).map_err(|_| "fetch_failed".to_string())?;
    let tracking = format!("refs/remotes/{remote}/{theirs}^{{commit}}");
    let Some(at) = git.line(cwd, &["rev-parse", "--verify", "--quiet", &tracking]).filter(|l| l.len() >= 40 && l.bytes().all(|b| b.is_ascii_hexdigit())) else {
        return Err("fetch_failed".into());
    };
    if at != local_at {
        let behind = git.run(cwd, &["merge-base", "--is-ancestor", local_at, &at]).map_err(|_| "fetch_failed")?;
        if behind.code != Some(0) {
            let ahead = git.run(cwd, &["merge-base", "--is-ancestor", &at, local_at]).map(|r| r.code == Some(0)).unwrap_or(false);
            return Err(if ahead { "ahead" } else { "diverged" }.into());
        }
    }
    // a folder the remote's commit does not hold would not be in the lane's folder
    if !prefix.is_empty() && git.line(cwd, &["cat-file", "-t", &format!("{at}:{prefix}")]).as_deref() != Some("tree") {
        return Err("not_in_remote".into());
    }
    Ok((at, format!("{remote}/{theirs}")))
}

/// Makes a lane's working folder: the first of `names` that no branch has, as a new branch made from the commit the folder
/// `cwd` is on, checked out in a worktree of its own under [`lanes_dir`]. The developer's folder is not touched.
pub fn make(home: &Path, cwd: &Path, names: &[String]) -> Result<Made, String> {
    make_with(home, cwd, names, &Start::default())
}

/// [`make`], where `start` says where the folder is made and whether the lane starts from the remote (Settings › Worktrees).
/// The folder is under `start.root` when the person chose one (checked again here: a code from [`check_lanes_root`] when it is
/// no longer usable, and the lane is then not made anywhere else), else under [`lanes_dir`]; the record is under [`lanes_dir`]
/// either way.
///
/// With `start.unattended` (item 114) the lane is the app's own doing: git runs as for the automatic pull, and nothing is
/// made, checked out, counted or fetched while the repository's own config, or a submodule's, names a program git would run
/// or another address to fetch from. `git worktree add` runs a smudge filter as it checks the files out, the count of what
/// did not come along a clean filter, and a start from the remote an `ext::` address or a proxy. The answer is then
/// `config:<setting>`, the setting named as the automatic pull names it.
pub fn make_with(home: &Path, cwd: &Path, names: &[String], start: &Start) -> Result<Made, String> {
    if names.is_empty() || names.len() > NAMES_MAX || !names.iter().all(|n| valid_name(n)) {
        return Err("bad_name".into());
    }
    // one prefix for every name: the page makes them from the one setting
    let prefix_name = prefix_of(&names[0]);
    if names.iter().any(|n| prefix_of(n) != prefix_name) {
        return Err("bad_name".into());
    }
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("not_a_repository".into());
    }
    let git_dir = git_branch::git_dir(cwd).ok_or("not_a_repository")?;
    if in_progress(&git_dir) {
        return Err("busy".into());
    }
    let git = if start.unattended { Git::automatic(home)? } else { Git::new(home)? };
    // with nobody there, the repository's own config is read before git does anything that could run a program it names
    if start.unattended {
        if let Some(setting) = git.config_risk(cwd) {
            return Err(format!("config:{setting}"));
        }
    }
    // no commit yet: there is nothing to make a branch from
    let Some(at) = git.line(cwd, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).filter(|l| l.len() >= 40 && l.bytes().all(|b| b.is_ascii_hexdigit())) else {
        return Err("no_commit".into());
    };
    // the work tree's top folder, and where the developer's folder is inside it
    let ran = git.run(cwd, &["rev-parse", "--show-toplevel", "--show-prefix"])?;
    if ran.code != Some(0) {
        return Err("not_a_repository".into());
    }
    let mut lines = ran.out.lines();
    let top = PathBuf::from(lines.next().unwrap_or("").trim());
    let prefix = lines.next().unwrap_or("").trim().trim_end_matches('/').to_string();
    if !top.is_absolute() || prefix.chars().any(char::is_control) || Path::new(&prefix).components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("not_a_repository".into());
    }
    // a folder the branch does not hold (one git ignores, or only new files) would not be in the lane's folder
    if !prefix.is_empty() && git.line(cwd, &["cat-file", "-t", &format!("{at}:{prefix}")]).as_deref() != Some("tree") {
        return Err("not_committed".into());
    }
    let repo = git.common_dir(cwd).ok_or("not_a_repository")?;
    let base = git_branch::branch(cwd);
    if base.is_empty() {
        return Err("not_a_repository".into());
    }
    // where the folder goes, before anything is fetched or written: the person's own folder, still usable, or the default
    let lanes = lanes_dir(home);
    let place = if start.root.is_empty() { lanes.clone() } else { check_lanes_root(home, &start.root)? };
    // the commit the lane starts from: the remote's latest of the base branch when that was asked for and it works (the fetch
    // takes no lock, so it is done before the turn below and never holds up another lane being made or removed)
    let (at, from, local) = if start.remote {
        match remote_start(&git, cwd, &base, &prefix, &at) {
            Ok((remote_at, name)) => (remote_at, name, String::new()),
            Err(why) => (at, String::new(), why),
        }
    } else {
        (at, String::new(), String::new())
    };

    let _turn = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let exists = git.taken(cwd, prefix_name)?;
    let record_parent = lanes.join(project_word(&top));
    let parent = place.join(project_word(&top));
    for d in [home.join(".manut"), lanes.clone(), record_parent.clone(), place.clone(), parent.clone()] {
        own_dir(&d)?;
    }
    for name in names.iter().filter(|n| !exists.contains(&n.to_lowercase())) {
        let words = &name[prefix_name.len()..];
        // the first folder name nothing has on disk, its record written first: the record is what says the folder is the
        // app's, and writing it as a new file claims the name before git makes the folder
        let Some((wt, rec_path)) = (1..=FOLDER_TRIES).find_map(|n| {
            let folder = if n == 1 { words.to_string() } else { format!("{words}-{n}") };
            let wt = parent.join(&folder);
            let rec_path = record_parent.join(format!("{folder}.json"));
            if fs::symlink_metadata(&wt).is_ok() || fs::symlink_metadata(&rec_path).is_ok() {
                return None;
            }
            let wt_s = wt.to_str()?.to_string();
            let rec = Record {
                v: 1,
                worktree: wt_s,
                repo: repo.to_string_lossy().into_owned(),
                project: cwd.to_string_lossy().into_owned(),
                prefix: prefix.clone(),
                branch: name.clone(),
                base: base.clone(),
                at: at.clone(),
                made: now_secs(),
            };
            write_new(&rec_path, serde_json::to_string(&rec).ok()?.as_bytes()).ok()?;
            Some((wt, rec_path))
        }) else {
            return Err("no_folder".into());
        };
        let wt_s = wt.to_string_lossy().into_owned();
        let ran = git.run_for(cwd, &["worktree", "add", "--no-track", "-b", name, &wt_s, &at], SLOW);
        // a step after the checkout may fail the command (or a slow one be stopped): what matters is whether the folder is
        // there, on the lane's branch
        if git_branch::branch(&wt) == *name {
            let inner = wt.join(&prefix);
            let dir = if prefix.is_empty() || !inner.is_dir() { wt.clone() } else { inner };
            // the one exception to "the committed tree only": the project's own agent settings, each kept out of git
            let brought = crate::lane_config::bring(&git, &top, &wt, &prefix);
            // read without the index's lock, so the developer's index is never written; a file that came along is not "left"
            let left = git.changed(cwd).unwrap_or(0).saturating_sub(brought.counted);
            return Ok(Made { branch: name.clone(), base, dir: dir.to_string_lossy().into_owned(), worktree: wt_s, left, from, local, config: brought.files, stayed: brought.stayed });
        }
        let err = match &ran {
            Ok(r) => tasks::error_line(&r.err),
            Err(e) => e.clone(),
        };
        // another process made the branch (or the folder) first: git made nothing, so the record goes and the next name is
        // tried. Whatever has that name is someone else's, and is never taken back
        if err.contains("already exists") {
            let _ = fs::remove_file(&rec_path);
            continue;
        }
        if undo_make(&git, cwd, &wt, name, &at) {
            let _ = fs::remove_file(&rec_path);
        }
        return Err(err);
    }
    Err("taken".into())
}

/// Takes back a lane's folder that git could not finish making: the folder, when git made one, and the branch, while it is
/// still where it was made and on no folder. Both are the app's own, made a moment ago with nothing of anyone's in them.
/// True when nothing of it is left, so its record can go too.
fn undo_make(git: &Git, cwd: &Path, wt: &Path, name: &str, at: &str) -> bool {
    let wt_s = wt.to_string_lossy().into_owned();
    if fs::symlink_metadata(wt).is_ok() {
        let listed = git.common_dir(cwd).and_then(|r| git.worktrees(&r)).is_some_and(|l| l.contains(&real(wt)));
        if !listed {
            // a folder git does not list as its worktree is not one this call made: it stays, and so does its record
            return false;
        }
        let gone = git.run_for(cwd, &["worktree", "remove", "--force", &wt_s], SLOW).map(|r| r.code == Some(0)).unwrap_or(false);
        if !gone {
            return false;
        }
    }
    let ref_name = format!("refs/heads/{name}");
    if git.line(cwd, &["rev-parse", "--verify", "--quiet", &ref_name]).as_deref() == Some(at) {
        let _ = git.run(cwd, &["branch", "-D", name]);
    }
    true
}

/// The lanes the app made for the repository `cwd` is in, newest first.
pub fn list(home: &Path, cwd: &Path) -> Result<Vec<Kept>, String> {
    if !cwd.is_absolute() || !cwd.is_dir() || git_branch::git_dir(cwd).is_none() {
        return Ok(Vec::new());
    }
    let Ok(git) = Git::automatic(home) else { return Ok(Vec::new()) };
    let Some(repo) = git.common_dir(cwd) else { return Ok(Vec::new()) };
    // the list is read by itself while the page is open: a repository whose config names a program is not read further
    let risky = git.config_risk(cwd).is_some();
    let mut mine: Vec<Record> = records(home).into_iter().map(|(_, r)| r).filter(|r| real(Path::new(&r.repo)) == repo).collect();
    mine.sort_by(|a, b| b.made.cmp(&a.made).then_with(|| a.worktree.cmp(&b.worktree)));
    Ok(mine
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let wt = PathBuf::from(&r.worktree);
            let exists = fs::symlink_metadata(&wt).map(|m| m.is_dir()).unwrap_or(false);
            // and each lane's folder is read only when its own config does not either: a lane has a worktree config and a
            // modules folder of its own (a submodule checked out in it), which the repository's read does not see
            let read = exists && i < STATUS_MAX && !risky && git.config_risk(&wt).is_none();
            let dir = if r.prefix.is_empty() { wt.clone() } else { wt.join(&r.prefix) };
            Kept {
                dir: dir.to_string_lossy().into_owned(),
                changed: if read { git.changed(&wt) } else { None },
                ahead: if read { git.ahead(&wt, &r) } else { None },
                unpushed: if read { git.unpushed(&wt, &r.branch) } else { None },
                ignored: if read { git.ignored_own(&wt, &r.prefix).map(|mut v| { v.truncate(IGNORED_SHOWN); v }).unwrap_or_default() } else { Vec::new() },
                // read even where the config names a program: only the index and the modules folder are looked at
                submodules: exists && i < STATUS_MAX && git.submodules(&wt) == Some(true),
                exists,
                worktree: r.worktree,
                branch: r.branch,
                base: r.base,
                made: r.made,
            }
        })
        .collect())
}

/// The developer's folders the app's lanes were made from, one each, while they are there: the Code page lists a project whose
/// last session closed while its lane's folder was kept, so the folder is never out of sight.
pub fn projects(home: &Path) -> Vec<String> {
    let mut out: Vec<String> = records(home).into_iter().map(|(_, r)| r.project).filter(|p| Path::new(p).is_dir()).collect();
    out.sort();
    out.dedup();
    out
}

/// Removes the lane's folder `worktree` (one [`make`] made and recorded), and its branch when `ask.branch` says so, once what
/// is there is what the person saw: see [`RemoveAsk`]. A folder with changed or new files goes only with `ask.changed` equal
/// to their number, a branch with commits not on its base only with `ask.ahead` equal to theirs; otherwise nothing is done
/// and the answer says what is there now. Refuses anything the app did not make (`not_a_lane`).
pub fn remove(home: &Path, worktree: &str, ask: &RemoveAsk) -> Result<Removed, String> {
    let (wt, rec_path, rec) = own_lane(home, worktree)?;
    let parent = wt.parent().ok_or("not_a_lane")?.to_path_buf();
    let git = Git::new(home)?;
    let _turn = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let repo = real(Path::new(&rec.repo));
    let exists = fs::symlink_metadata(&wt).map(|m| m.is_dir()).unwrap_or(false);
    if exists {
        // the folder must still be a worktree of the recorded repository, as git lists it: anything else put there since is
        // not the app's to remove
        let ours = git.common_dir(&wt).as_ref() == Some(&repo) && git.worktrees(&repo).is_some_and(|l| l.contains(&real(&wt)) && l.first() != Some(&real(&wt)));
        if !ours {
            return Err("not_a_lane".into());
        }
    }
    let changed = if exists { git.changed(&wt).ok_or("git could not say what changed in the folder")? } else { 0 };
    let ahead = if ask.branch { git.ahead(&repo, &rec) } else { None };
    if (changed > 0 && changed != ask.changed) || (ask.branch && ahead != ask.ahead && ahead != Some(0)) {
        return Ok(Removed { changed: Some(changed), ahead, ..Removed::default() });
    }

    // git's own note of the worktree goes with it; for a folder already gone, only the note. A folder with submodules is never
    // forced (item 90): their work is not in `changed`, and a force takes it, the commits in its own modules folder too, so
    // git's own refusal of such a folder stands and says why
    let mut args = vec!["worktree", "remove"];
    if changed > 0 && exists && git.submodules(&wt) == Some(false) {
        args.push("--force");
    }
    args.push(worktree);
    let ran = git.run_for(&repo, &args, SLOW)?;
    if ran.code != Some(0) && (exists || git.worktrees(&repo).is_some_and(|l| l.contains(&real(&wt)))) {
        return Err(tasks::error_line(&ran.err));
    }
    if fs::symlink_metadata(&wt).is_ok() {
        return Err("the folder is still there".into());
    }
    let mut out = Removed { removed: true, ..Removed::default() };
    if ask.branch {
        match git.run(&repo, &["branch", "-D", &rec.branch]) {
            Ok(r) if r.code == Some(0) => out.deleted = true,
            Ok(r) => out.error = Some(tasks::error_line(&r.err)),
            Err(e) => out.error = Some(e),
        }
    }
    let _ = fs::remove_file(&rec_path);
    // the project's folder goes when it holds no other lane (a folder with anything in it stays)
    let _ = fs::remove_dir(&parent);
    if let Some(record_parent) = rec_path.parent() {
        let _ = fs::remove_dir(record_parent);
    }
    Ok(out)
}

/// The folder `worktree` and its record, when it is one the app made: a record under [`lanes_dir`] (two names below it, none a
/// link) that names exactly this folder, which is not a link and has no link for a parent. `not_a_lane` for anything else.
/// review.rs reads a lane the same way before it asks to put it up for review.
pub(crate) fn own_lane(home: &Path, worktree: &str) -> Result<(PathBuf, PathBuf, Record), String> {
    let wt = PathBuf::from(worktree);
    if !wt.is_absolute() || wt.components().any(|c| !matches!(c, Component::RootDir | Component::Prefix(_) | Component::Normal(_))) {
        return Err("not_a_lane".into());
    }
    let lanes = lanes_dir(home);
    let parent = wt.parent().ok_or("not_a_lane")?.to_path_buf();
    if [home.join(".manut"), lanes, parent, wt.clone()].iter().any(|p| is_link(p)) {
        return Err("not_a_lane".into());
    }
    // the record names exactly this folder (a name with a dot in it would read another's record)
    let (rec_path, rec) = records(home).into_iter().find(|(_, r)| Path::new(&r.worktree) == wt).ok_or("not_a_lane")?;
    Ok((wt, rec_path, rec))
}

/// What a clean-up did with one lane's folder: `removed`, or why it was kept. `kept` is a short code the page words:
/// `changes` (a changed or new file), `unpushed` (commits on its branch that are on no remote), `ignored` (files git ignores
/// that are not rebuilt and the app did not put there, named in `ignored`), `config` (the repository's own config names a
/// program git would run, [`Git::config_risk`]), `submodules` (it has submodules, whose work is not read: [`Git::submodules`]),
/// `busy` (git is partway through
/// something there), `unread` (git could not say what is there), `changed` (it changed while this ran), `held` (a session still
/// works in it). `changed` and `unpushed` give the numbers.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Released {
    pub removed: bool,
    pub kept: Option<String>,
    pub changed: Option<u32>,
    pub unpushed: Option<u32>,
    /// `ignored`: the files and folders git ignores that it keeps the folder for, at most [`IGNORED_SHOWN`].
    pub ignored: Vec<String>,
}

/// Removes the lane's folder `worktree` for a clean-up (a deleted chat's, or one whose pull request merged), never one with
/// work of its own in it: nothing changed or new, git not partway through something, every commit on its branch on a
/// remote (`pushed`, which a merged lane overrides in `lane_clean.rs` with the proof of its own), and nothing git ignores in it
/// but what a project rebuilds and the agent settings the app copied in (`ignored`, named: [`Git::ignored_own`]). `git
/// worktree remove` takes ignored files without a word, so a developer's `.env.local` or local database made in the lane would
/// otherwise go with a deleted chat. The branch always stays. No force flag reaches git here: the removal is [`remove`] with
/// nothing to lose, which git itself refuses when it finds anything it would not take. `Err` as [`remove`]'s for a folder the
/// app did not make.
pub fn release(home: &Path, worktree: &str, pushed: bool) -> Result<Released, String> {
    let (wt, _, rec) = own_lane(home, worktree)?;
    let git = Git::automatic(home)?;
    let repo = real(Path::new(&rec.repo));
    let exists = fs::symlink_metadata(&wt).map(|m| m.is_dir()).unwrap_or(false);
    if exists {
        let ours = git.common_dir(&wt).as_ref() == Some(&repo) && git.worktrees(&repo).is_some_and(|l| l.contains(&real(&wt)) && l.first() != Some(&real(&wt)));
        if !ours {
            return Err("not_a_lane".into());
        }
        let keep = |code: &str, changed: Option<u32>, unpushed: Option<u32>| Ok(Released { removed: false, kept: Some(code.into()), changed, unpushed, ignored: Vec::new() });
        // a clean-up is the app's own doing: nothing runs in a repository whose config names a program (a clean filter
        // `status` and `git worktree remove` would run)
        if git.config_risk(&wt).is_some() {
            return keep("config", None, None);
        }
        // what a submodule holds is not read by itself, so a folder with any is not the clean-up's to remove (item 90)
        match git.submodules(&wt) {
            Some(false) => {}
            Some(true) => return keep("submodules", None, None),
            None => return keep("unread", None, None),
        }
        let changed = git.changed(&wt);
        match changed {
            None => return keep("unread", None, None),
            Some(n) if n > 0 => return keep("changes", Some(n), None),
            _ => {}
        }
        if git.busy(&wt) {
            return keep("busy", Some(0), None);
        }
        if pushed {
            let unpushed = git.unpushed(&repo, &rec.branch);
            match unpushed {
                None => return keep("unread", Some(0), None),
                Some(n) if n > 0 => return keep("unpushed", Some(0), Some(n)),
                _ => {}
            }
        }
        match git.ignored_own(&wt, &rec.prefix) {
            None => return keep("unread", Some(0), None),
            Some(mut own) if !own.is_empty() => {
                own.truncate(IGNORED_SHOWN);
                return Ok(Released { removed: false, kept: Some("ignored".into()), changed: Some(0), unpushed: None, ignored: own });
            }
            _ => {}
        }
    }
    // a folder removed by hand has only git's note and the record left, which `remove` takes
    match remove(home, worktree, &RemoveAsk::default()) {
        Ok(r) if r.removed => Ok(Released { removed: true, ..Released::default() }),
        Ok(r) => Ok(Released { removed: false, kept: Some("changed".into()), changed: r.changed, ..Released::default() }),
        Err(e) if e == "not_a_lane" => Err(e),
        // git's own refusal (an untracked file it will not take, a locked worktree): the folder stays
        Err(_) => Ok(Released { removed: false, kept: Some("changes".into()), ..Released::default() }),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::process::Command;

    pub(crate) fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manut-lane-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    /// Runs git in `dir` for a test's setup, with an identity so a commit works on a machine that has none.
    pub(crate) fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A home folder and, in it, a repository `web-app` on `main` with one commit, a tracked `a.txt` and `apps/web/b.txt`,
    /// and `node_modules` ignored; or None when this machine has no git (the tests then say so and pass, as the rest of the
    /// shell's tests do for a program that is not there).
    pub(crate) fn repo(name: &str) -> Option<(PathBuf, PathBuf)> {
        tasks::find("git")?;
        let home = tmp(name);
        let d = home.join("code").join("web-app");
        fs::create_dir_all(d.join("apps/web")).unwrap();
        sh(&d, &["init", "-q"]);
        sh(&d, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        fs::write(d.join("a.txt"), "one\n").unwrap();
        fs::write(d.join("apps/web/b.txt"), "two\n").unwrap();
        fs::write(d.join(".gitignore"), "node_modules/\n").unwrap();
        sh(&d, &["add", "."]);
        sh(&d, &["commit", "-q", "-m", "first"]);
        Some((home, d))
    }

    pub(crate) fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    pub(crate) fn commit_in(dir: &Path, file: &str, text: &str) {
        fs::write(dir.join(file), text).unwrap();
        sh(dir, &["add", file]);
        sh(dir, &["commit", "-q", "-m", file]);
    }

    #[test]
    fn a_name_is_only_ever_the_narrow_form_kit_makes() {
        for ok in ["kit/promptpay-qr", "kit/x", "kit/fix-stock-sync-2", "kit/a1-b2", "team/ana/fix-login", "manut/x"] {
            assert!(valid_name(ok), "{ok}");
        }
        let long = format!("kit/{}", "a".repeat(80));
        for bad in ["", "main", "kit/", "kit", "Kit/x", "kit/X", "kit/a b", "kit/a--b", "kit/-a", "kit/a-", "kit/a/b/c", "kit/a//b", "refs/heads/x", "kit/..", "kit/a.lock", "kit/a.b", "-kit/x", "--help", "kit/--x", "kit/é", "kit/a\n", &long] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_project_word_is_one_plain_name() {
        for (folder, word) in [("web-app", "web-app"), ("Baan Mali (pre-order)", "Baan-Mali-pre-order"), ("..", "project"), (".hidden", "hidden"), ("-x-", "x"), ("ร้าน", "project"), ("a..b", "a..b")] {
            assert_eq!(project_word(&Path::new("/code").join(folder)), word, "{folder}");
        }
        assert_eq!(project_word(Path::new(&format!("/code/{}", "x".repeat(60)))).len(), 40);
    }

    #[test]
    fn a_lane_folder_is_two_names_or_more_below_the_lanes_folder() {
        let home = Path::new("/Users/you");
        assert!(in_a_lane(home, Path::new("/Users/you/.manut/lanes/web-app/promptpay-qr")));
        assert!(in_a_lane(home, Path::new("/Users/you/.manut/lanes/web-app/promptpay-qr/apps/web")));
        for no in ["/Users/you/.manut/lanes", "/Users/you/.manut/lanes/web-app", "/Users/you/.manut", "/Users/you/.manut/turn-snapshots/s1/x", "/Users/you/code/web-app", "/Users/you/.manut/lanes/../lanes/a/b"] {
            assert!(!in_a_lane(home, Path::new(no)), "{no}");
        }
    }

    #[test]
    fn makes_a_working_folder_of_its_own_and_leaves_the_developers_folder_as_it_was() {
        let Some((home, d)) = repo("make") else { return };
        let main = sh(&d, &["rev-parse", "main"]);
        // the developer's own work: a change, a staged change, a new file, a stash, and installed dependencies
        commit_in(&d, "c.txt", "three\n");
        let main2 = sh(&d, &["rev-parse", "main"]);
        fs::write(d.join("c.txt"), "three\nstashed\n").unwrap();
        sh(&d, &["stash", "-q"]);
        fs::write(d.join("a.txt"), "one\nmine\n").unwrap();
        fs::write(d.join("apps/web/b.txt"), "two\nstaged\n").unwrap();
        sh(&d, &["add", "apps/web/b.txt"]);
        fs::write(d.join("new.txt"), "new\n").unwrap();
        fs::create_dir_all(d.join("node_modules/qrcode")).unwrap();
        fs::write(d.join("node_modules/qrcode/index.js"), "x\n").unwrap();
        let before = (sh(&d, &["status", "--porcelain"]), sh(&d, &["stash", "list"]), sh(&d, &["symbolic-ref", "HEAD"]));

        let made = make(&home, &d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2"])).unwrap();
        let wt = home.join(".manut/lanes/web-app/promptpay-qr");
        // three of the developer's files did not come along: a change, a staged change and a new file (never what git ignores)
        assert_eq!(made, Made { branch: "kit/promptpay-qr".into(), base: "main".into(), dir: wt.to_string_lossy().into(), worktree: wt.to_string_lossy().into(), left: 3, from: String::new(), local: String::new(), config: 0, stayed: 0 });
        // the developer's folder: same branch, same index, same stash, same files
        assert_eq!((sh(&d, &["status", "--porcelain"]), sh(&d, &["stash", "list"]), sh(&d, &["symbolic-ref", "HEAD"])), before);
        assert_eq!(git_branch::branch(&d), "main");
        assert_eq!(sh(&d, &["rev-parse", "main"]), main2);
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "one\nmine\n");
        // the lane: on its own branch at main's commit, with the committed files only
        assert_eq!(git_branch::branch(&wt), "kit/promptpay-qr");
        assert_eq!(sh(&d, &["rev-parse", "kit/promptpay-qr"]), main2);
        assert_ne!(main, main2);
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "one\n");
        assert_eq!(fs::read_to_string(wt.join("apps/web/b.txt")).unwrap(), "two\n");
        assert_eq!(fs::read_to_string(wt.join("c.txt")).unwrap(), "three\n");
        assert!(!wt.join("new.txt").exists() && !wt.join("node_modules").exists());
        assert_eq!(sh(&wt, &["status", "--porcelain"]), "");
        // git lists it as a worktree, and the app's record says it made it
        assert!(sh(&d, &["worktree", "list", "--porcelain"]).contains(&format!("worktree {}", wt.display())));
        let rec = read_record(&wt.with_extension("json")).unwrap();
        assert_eq!((rec.branch.as_str(), rec.base.as_str(), rec.at.as_str(), rec.prefix.as_str()), ("kit/promptpay-qr", "main", main2.as_str(), ""));
        assert_eq!(Path::new(&rec.repo), d.join(".git").canonicalize().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(home.join(".manut/lanes")).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(wt.with_extension("json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn two_lanes_work_at_once_each_on_its_own_branch_made_from_the_developers() {
        let Some((home, d)) = repo("two") else { return };
        let main = sh(&d, &["rev-parse", "main"]);
        let a = make(&home, &d, &names(&["kit/thai-date-format"])).unwrap();
        // the first lane commits on its branch while the second is made: the second does not stack on it
        commit_in(Path::new(&a.dir), "a.txt", "one\nthai\n");
        let b = make(&home, &d, &names(&["kit/fix-stock-sync"])).unwrap();
        assert_eq!((a.base.as_str(), b.base.as_str()), ("main", "main"));
        assert_eq!(sh(&d, &["rev-parse", "kit/fix-stock-sync"]), main);
        assert_ne!(a.dir, b.dir);
        assert_eq!(fs::read_to_string(Path::new(&b.dir).join("a.txt")).unwrap(), "one\n");
        // each works on its own files
        fs::write(Path::new(&b.dir).join("a.txt"), "one\nstock\n").unwrap();
        assert_eq!(fs::read_to_string(Path::new(&a.dir).join("a.txt")).unwrap(), "one\nthai\n");
        assert_eq!(git_branch::branch(&d), "main");
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "one\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn takes_the_next_name_or_folder_when_one_is_taken_and_refuses_when_all_are() {
        let Some((home, d)) = repo("taken") else { return };
        sh(&d, &["branch", "kit/promptpay-qr"]);
        sh(&d, &["branch", "kit/promptpay-qr-2"]);
        let made = make(&home, &d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2", "kit/promptpay-qr-3"])).unwrap();
        assert_eq!(made.branch, "kit/promptpay-qr-3");
        assert_eq!(make(&home, &d, &names(&["kit/promptpay-qr", "kit/promptpay-qr-2"])), Err("taken".into()));
        assert_eq!(make(&home, &d, &names(&["kit/Promptpay-Qr"])), Err("bad_name".into()));
        // a folder of that name is on disk already (another repository of the same name, a folder kept): the next number
        fs::create_dir_all(home.join(".manut/lanes/web-app/checkout")).unwrap();
        let next = make(&home, &d, &names(&["kit/checkout"])).unwrap();
        assert_eq!((next.branch.as_str(), next.worktree.ends_with("/web-app/checkout-2")), ("kit/checkout", true));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn works_in_the_same_folder_inside_its_worktree_and_from_a_detached_commit() {
        let Some((home, d)) = repo("sub") else { return };
        let made = make(&home, &d.join("apps/web"), &names(&["kit/web"])).unwrap();
        assert!(made.dir.ends_with("/.manut/lanes/web-app/web/apps/web"), "{}", made.dir);
        assert_eq!(fs::read_to_string(Path::new(&made.dir).join("b.txt")).unwrap(), "two\n");
        // a folder the branch does not hold is not in a lane's folder
        fs::create_dir_all(d.join("scratch")).unwrap();
        fs::write(d.join("scratch/x.txt"), "x").unwrap();
        assert_eq!(make(&home, &d.join("scratch"), &names(&["kit/x"])), Err("not_committed".into()));
        let sha = sh(&d, &["rev-parse", "HEAD"]);
        sh(&d, &["checkout", "-q", "--detach"]);
        let made = make(&home, &d, &names(&["kit/x"])).unwrap();
        assert_eq!(made.base, sha[..7]);
        assert_eq!(git_branch::branch(&d), sha[..7]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn makes_it_from_a_linked_worktree_and_leaves_both_of_the_developers_alone() {
        let Some((home, d)) = repo("wt") else { return };
        let mine = home.join("code").join("web-app-dev");
        sh(&d, &["worktree", "add", "-q", "-b", "feat/dev", mine.to_str().unwrap()]);
        let mine = mine.canonicalize().unwrap();
        let made = make(&home, &mine, &names(&["kit/x"])).unwrap();
        assert_eq!((made.branch.as_str(), made.base.as_str()), ("kit/x", "feat/dev"));
        assert_eq!((git_branch::branch(&mine), git_branch::branch(&d)), ("feat/dev".to_string(), "main".to_string()));
        assert_eq!(git_branch::branch(Path::new(&made.dir)), "kit/x");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_what_it_cannot_make_a_lane_from_or_would_disturb() {
        let plain = tmp("plain");
        assert_eq!(make(&plain, &plain, &names(&["kit/x"])), Err("not_a_repository".into()));
        assert_eq!(make(&plain, Path::new("relative/dir"), &names(&["kit/x"])), Err("not_a_repository".into()));
        assert_eq!(make(&plain, &plain.join("missing"), &names(&["kit/x"])), Err("not_a_repository".into()));
        assert!(!plain.join(".manut").exists());
        let _ = fs::remove_dir_all(plain);

        // no commit yet
        if tasks::find("git").is_some() {
            let empty = tmp("empty");
            sh(&empty, &["init", "-q"]);
            assert_eq!(make(&empty, &empty, &names(&["kit/x"])), Err("no_commit".into()));
            let _ = fs::remove_dir_all(empty);
        }

        // in the middle of something of the developer's own
        let Some((home, d)) = repo("busy") else { return };
        for marker in ["MERGE_HEAD", "rebase-merge", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"] {
            let p = d.join(".git").join(marker);
            fs::write(&p, "x").unwrap();
            assert_eq!(make(&home, &d, &names(&["kit/x"])), Err("busy".into()), "{marker}");
            fs::remove_file(&p).unwrap();
        }
        assert!(!home.join(".manut").exists());
        assert!(make(&home, &d, &names(&["kit/x"])).is_ok());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn never_runs_git_with_a_name_it_does_not_make() {
        let Some((home, d)) = repo("badname") else { return };
        for bad in [names(&[]), names(&["main"]), names(&["--orphan"]), names(&["kit/x", "-b"]), names(&["kit/x y"]), (0..21).map(|i| format!("kit/n{i}")).collect()] {
            assert_eq!(make(&home, &d, &bad), Err("bad_name".into()), "{bad:?}");
        }
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)"]), "main");
        assert!(!home.join(".manut").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link() {
        let Some((home, d)) = repo("links") else { return };
        let away = home.join("away");
        fs::create_dir_all(&away).unwrap();
        fs::create_dir_all(home.join(".manut")).unwrap();
        std::os::unix::fs::symlink(&away, home.join(".manut/lanes")).unwrap();
        assert!(make(&home, &d, &names(&["kit/x"])).unwrap_err().contains("is a link"));
        fs::remove_file(home.join(".manut/lanes")).unwrap();
        fs::create_dir_all(home.join(".manut/lanes")).unwrap();
        std::os::unix::fs::symlink(&away, home.join(".manut/lanes/web-app")).unwrap();
        assert!(make(&home, &d, &names(&["kit/x"])).unwrap_err().contains("is a link"));
        fs::remove_file(home.join(".manut/lanes/web-app")).unwrap();
        // a link planted where the record would go: that name is not used, and nothing is written through it
        fs::create_dir_all(home.join(".manut/lanes/web-app")).unwrap();
        std::os::unix::fs::symlink(away.join("rec.json"), home.join(".manut/lanes/web-app/x.json")).unwrap();
        let made = make(&home, &d, &names(&["kit/x"])).unwrap();
        assert!(made.worktree.ends_with("/web-app/x-2"));
        assert_eq!(fs::read_dir(&away).unwrap().count(), 0);
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)", "kit/*"]), "kit/x");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn lists_the_lanes_it_made_for_this_repository_with_what_is_in_them() {
        let Some((home, d)) = repo("list") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        let b = make(&home, &d, &names(&["kit/b"])).unwrap();
        // another repository's lane is not this one's
        let other = home.join("code").join("other");
        fs::create_dir_all(&other).unwrap();
        sh(&other, &["init", "-q"]);
        commit_in(&other, "o.txt", "o\n");
        make(&home, &other, &names(&["kit/o"])).unwrap();
        fs::write(Path::new(&a.dir).join("a.txt"), "changed\n").unwrap();
        fs::write(Path::new(&a.dir).join("new.txt"), "new\n").unwrap();
        commit_in(Path::new(&b.dir), "b.txt", "b\n");
        commit_in(Path::new(&b.dir), "b2.txt", "b\n");
        // a record that names another folder than the one beside it is no record
        let fake = Record { v: 1, worktree: d.to_string_lossy().into(), repo: d.join(".git").to_string_lossy().into(), project: String::new(), prefix: String::new(), branch: "kit/z".into(), base: "main".into(), at: String::new(), made: 0 };
        fs::write(home.join(".manut/lanes/web-app/z.json"), serde_json::to_string(&fake).unwrap()).unwrap();

        let got = list(&home, &d).unwrap();
        let by = |w: &str| got.iter().find(|k| k.worktree == w).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!((by(&a.worktree).changed, by(&a.worktree).ahead, by(&a.worktree).exists), (Some(2), Some(0), true));
        assert_eq!((by(&b.worktree).changed, by(&b.worktree).ahead), (Some(0), Some(2)));
        // read from a lane's own folder, the list is the same repository's
        assert_eq!(list(&home, Path::new(&a.dir)).unwrap().len(), 2);
        assert_eq!(list(&home, &other).unwrap().len(), 1);
        assert_eq!(list(&home, &home).unwrap(), vec![]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn names_the_projects_its_lanes_were_made_from_once_each_while_they_are_there() {
        let Some((home, d)) = repo("projects") else { return };
        assert_eq!(projects(&home), Vec::<String>::new());
        make(&home, &d, &names(&["kit/a"])).unwrap();
        make(&home, &d, &names(&["kit/b"])).unwrap();
        make(&home, &d.join("apps/web"), &names(&["kit/web"])).unwrap();
        let web = d.join("apps/web").to_string_lossy().into_owned();
        assert_eq!(projects(&home), vec![d.to_string_lossy().into_owned(), web.clone()]);
        // a developer's folder that is gone is no project to list
        fs::remove_dir_all(d.join("apps")).unwrap();
        assert_eq!(projects(&home), vec![d.to_string_lossy().into_owned()]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn removes_a_folder_with_nothing_in_it_that_would_be_lost_and_keeps_the_branch() {
        let Some((home, d)) = repo("remove") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        commit_in(Path::new(&a.dir), "a2.txt", "kept on the branch\n");
        let tip = sh(&d, &["rev-parse", "kit/a"]);
        let got = remove(&home, &a.worktree, &RemoveAsk::default()).unwrap();
        assert_eq!(got, Removed { removed: true, ..Removed::default() });
        assert!(!Path::new(&a.worktree).exists() && !Path::new(&a.worktree).with_extension("json").exists());
        assert_eq!(sh(&d, &["rev-parse", "kit/a"]), tip);
        assert!(!sh(&d, &["worktree", "list"]).contains(".manut"));
        assert_eq!(git_branch::branch(&d), "main");
        // the project's folder went with its last lane
        assert!(!home.join(".manut/lanes/web-app").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn keeps_a_folder_with_changes_until_the_person_said_yes_to_that_many() {
        let Some((home, d)) = repo("changes") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        fs::write(Path::new(&a.dir).join("a.txt"), "changed\n").unwrap();
        fs::write(Path::new(&a.dir).join("new.txt"), "new\n").unwrap();
        // ignored files go with the folder and are never counted
        fs::create_dir_all(Path::new(&a.dir).join("node_modules/q")).unwrap();
        fs::write(Path::new(&a.dir).join("node_modules/q/i.js"), "x").unwrap();
        let kept = remove(&home, &a.worktree, &RemoveAsk::default()).unwrap();
        assert_eq!(kept, Removed { changed: Some(2), ..Removed::default() });
        assert!(Path::new(&a.dir).join("new.txt").exists());
        // the person saw one file; there are two now
        assert_eq!(remove(&home, &a.worktree, &RemoveAsk { changed: 1, ..RemoveAsk::default() }).unwrap(), Removed { changed: Some(2), ..Removed::default() });
        assert!(Path::new(&a.dir).exists());
        let gone = remove(&home, &a.worktree, &RemoveAsk { changed: 2, ..RemoveAsk::default() }).unwrap();
        assert!(gone.removed && !gone.deleted);
        assert!(!Path::new(&a.worktree).exists());
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)", "kit/*"]), "kit/a");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn deletes_the_branch_only_when_asked_and_its_commits_were_counted() {
        let Some((home, d)) = repo("branch") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        // nothing on it that is not on main: it goes when asked
        let got = remove(&home, &a.worktree, &RemoveAsk { branch: true, ahead: Some(0), ..RemoveAsk::default() }).unwrap();
        assert!(got.removed && got.deleted, "{got:?}");
        assert_eq!(sh(&d, &["branch", "--list", "kit/*"]), "");

        let b = make(&home, &d, &names(&["kit/b"])).unwrap();
        commit_in(Path::new(&b.dir), "b.txt", "b\n");
        commit_in(Path::new(&b.dir), "b2.txt", "b\n");
        // two commits that are only on it: not without the person's yes to two
        for ahead in [None, Some(0), Some(1)] {
            let no = remove(&home, &b.worktree, &RemoveAsk { branch: true, ahead, ..RemoveAsk::default() }).unwrap();
            assert_eq!(no, Removed { changed: Some(0), ahead: Some(2), ..Removed::default() }, "{ahead:?}");
            assert!(Path::new(&b.worktree).exists());
        }
        let got = remove(&home, &b.worktree, &RemoveAsk { branch: true, ahead: Some(2), ..RemoveAsk::default() }).unwrap();
        assert!(got.removed && got.deleted, "{got:?}");
        assert_eq!(sh(&d, &["branch", "--list", "kit/*"]), "");
        assert_eq!(git_branch::branch(&d), "main");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_removed_by_hand_takes_only_git_s_note_and_the_record_with_it() {
        let Some((home, d)) = repo("byhand") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        fs::remove_dir_all(&a.worktree).unwrap();
        assert!(!list(&home, &d).unwrap()[0].exists);
        let got = remove(&home, &a.worktree, &RemoveAsk::default()).unwrap();
        assert!(got.removed);
        assert!(!sh(&d, &["worktree", "list"]).contains(".manut"));
        assert_eq!(sh(&d, &["branch", "--list", "--format=%(refname:short)", "kit/*"]), "kit/a");
        assert_eq!(list(&home, &d).unwrap(), vec![]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn never_removes_anything_it_did_not_make() {
        let Some((home, d)) = repo("notmine") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        let lanes = lanes_dir(&home);
        // the developer's folder, a folder outside the lanes, one level down, a folder with no record, a path with `..`, and a
        // name whose record is another folder's (`a.x` reads `a.json`)
        fs::create_dir_all(lanes.join("web-app/stray")).unwrap();
        fs::create_dir_all(lanes.join("web-app/a.x")).unwrap();
        for bad in [d.to_string_lossy().into_owned(), home.join("code").to_string_lossy().into_owned(), lanes.join("web-app").to_string_lossy().into_owned(), lanes.join("web-app/stray").to_string_lossy().into_owned(), format!("{}/../a", lanes.join("web-app").display()), "relative/web-app/a".into(), lanes.join("web-app/a.x").to_string_lossy().into_owned()] {
            assert_eq!(remove(&home, &bad, &RemoveAsk { changed: 9, branch: true, ahead: Some(9) }), Err("not_a_lane".into()), "{bad}");
        }
        assert!(d.join("a.txt").exists() && lanes.join("web-app/stray").exists() && lanes.join("web-app/a.x").exists());
        // a record pointing at another folder than its own is no record
        let rec = Record { v: 1, worktree: d.to_string_lossy().into(), repo: d.join(".git").to_string_lossy().into(), project: String::new(), prefix: String::new(), branch: "kit/a".into(), base: "main".into(), at: String::new(), made: 0 };
        fs::write(lanes.join("web-app/stray.json"), serde_json::to_string(&rec).unwrap()).unwrap();
        assert_eq!(remove(&home, &lanes.join("web-app/stray").to_string_lossy(), &RemoveAsk::default()), Err("not_a_lane".into()));
        // the lane's folder replaced by a clone of its own (not a worktree of the recorded repository): not the app's
        fs::remove_dir_all(&a.worktree).unwrap();
        sh(&home, &["clone", "-q", d.to_str().unwrap(), &a.worktree]);
        assert_eq!(remove(&home, &a.worktree, &RemoveAsk { changed: 9, ..RemoveAsk::default() }), Err("not_a_lane".into()));
        assert!(Path::new(&a.worktree).join("a.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_main_moved_note_reads_the_lane_in_its_own_folder() {
        let Some((home, d)) = repo("moved") else { return };
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        // main moves in the developer's folder and the lane changes the same file in its own
        commit_in(&d, "a.txt", "one\nmain\n");
        fs::write(Path::new(&a.dir).join("a.txt"), "one\nlane\n").unwrap();
        let m = crate::git_moved::main_moved(Path::new(&a.dir), Some("main"), &[]).unwrap().unwrap();
        assert_eq!((m.branch.as_str(), m.base.as_str()), ("kit/a", "main"));
        assert_eq!((m.ours.clone(), m.theirs.clone()), (vec!["a.txt".to_string()], vec!["a.txt".to_string()]));
        // read from the developer's folder, it is about the developer's branch, which is main itself: nothing to say
        assert_eq!(crate::git_moved::main_moved(&d, Some("main"), &[]).unwrap(), None);
        let _ = fs::remove_dir_all(home);
    }

    /// A program a repository's own config can name, standing in for one that someone else wrote: it notes that it ran in
    /// `home/ran`, passes its input through (as a clean filter must) and, as `fail`, ends with an error (as a refused ssh).
    pub(crate) fn spy(home: &Path, name: &str, fail: bool) -> (String, PathBuf) {
        let marker = home.join("ran");
        let script = home.join(format!("{name}.sh"));
        fs::write(&script, format!("#!/bin/sh\necho {name} >> '{}'\n{}\n", marker.display(), if fail { "exit 1" } else { "cat" })).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        }
        (script.to_string_lossy().into_owned(), marker)
    }

    /// A clean filter named by `d`'s own config for every `.txt`, and `a.txt` touched so git must run it to compare.
    pub(crate) fn filter_in(home: &Path, d: &Path, wt: &Path) -> PathBuf {
        let (script, marker) = spy(home, "filter", false);
        sh(d, &["config", "filter.spy.clean", &script]);
        let attrs = sh(wt, &["rev-parse", "--git-path", "info/attributes"]);
        let attrs = if Path::new(&attrs).is_absolute() { PathBuf::from(attrs) } else { wt.join(attrs) };
        fs::create_dir_all(attrs.parent().unwrap()).unwrap();
        fs::write(&attrs, "*.txt filter=spy\n").unwrap();
        // a stat change with the same size: git has to read the file through the filter to know whether it changed
        let a = wt.join("a.txt");
        let text = fs::read(&a).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        fs::write(&a, text).unwrap();
        marker
    }

    /// A repository `subsrc` in `home` with one commit, added to `d` as its submodule `sub` (checked out in `d`, its git folder
    /// under `d`'s modules folder) and committed, so every lane made from `d` afterwards has it too, not checked out.
    pub(crate) fn with_submodule(home: &Path, d: &Path) {
        let src = home.join("subsrc");
        fs::create_dir_all(&src).unwrap();
        sh(&src, &["init", "-q"]);
        sh(&src, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        commit_in(&src, "s.txt", "inside\n");
        sh(d, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", src.to_str().unwrap(), "sub"]);
        sh(d, &["commit", "-q", "-m", "sub"]);
    }

    /// `wt`'s submodule `sub` checked out (when it is not yet), its OWN config naming a clean filter for every file, as in a
    /// folder someone sent, and its file touched so git has to read it through the filter to compare it. Nothing in the
    /// repository's own config names a program. The filter is a stand-in that notes it ran in `home/ran`.
    pub(crate) fn filter_in_submodule(home: &Path, wt: &Path) -> PathBuf {
        let sub = wt.join("sub");
        if fs::symlink_metadata(sub.join(".git")).is_err() {
            sh(wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
        }
        let (script, marker) = spy(home, "subfilter", false);
        sh(&sub, &["config", "filter.spy.clean", &script]);
        let attrs = sh(&sub, &["rev-parse", "--git-path", "info/attributes"]);
        let attrs = if Path::new(&attrs).is_absolute() { PathBuf::from(attrs) } else { sub.join(attrs) };
        fs::create_dir_all(attrs.parent().unwrap()).unwrap();
        fs::write(&attrs, "* filter=spy\n").unwrap();
        let s = sub.join("s.txt");
        let text = fs::read(&s).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        fs::write(&s, text).unwrap();
        marker
    }

    #[test]
    fn no_automatic_read_or_clean_up_runs_a_program_a_submodule_s_own_config_names() {
        let Some((home, d)) = repo("sub-auto") else { return };
        with_origin(&home, &d);
        with_submodule(&home, &d);
        sh(&d, &["push", "-q", "origin", "main"]);
        let made = pushed_lane(&home, &d, "sub");
        let wt = Path::new(&made.worktree);
        let marker = filter_in_submodule(&home, wt);
        let ran = || fs::read_to_string(&marker).unwrap_or_default();
        // git's own count of the folder, the kept list's counts and a deleted chat's clean-up, each the app's own doing
        let _ = Git::automatic(&home).unwrap().changed(wt);
        assert!(!marker.exists(), "a program ran for the count: {}", ran());
        let _ = list(&home, &d).unwrap();
        assert!(!marker.exists(), "a program ran for the kept list: {}", ran());
        let r = release(&home, &made.worktree, true).unwrap();
        assert!(!marker.exists(), "a program ran for the clean-up: {}", ran());
        assert!(!r.removed, "{r:?}");
        assert!(wt.join("sub/s.txt").exists() && wt.join("sub.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_main_moved_note_runs_no_program_a_submodule_s_own_config_names() {
        let Some((home, d)) = repo("sub-moved") else { return };
        with_submodule(&home, &d);
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        let marker = filter_in_submodule(&home, Path::new(&a.worktree));
        commit_in(&d, "a.txt", "one\nmain\n");
        fs::write(Path::new(&a.dir).join("a.txt"), "one\nlane\n").unwrap();
        let m = crate::git_moved::main_moved(Path::new(&a.dir), Some("main"), &names(&["a.txt"])).unwrap();
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        // the submodule's own config names a program, so there is no note; without it there is one, and the submodule is not in it
        assert_eq!(m, None);
        sh(&Path::new(&a.worktree).join("sub"), &["config", "--unset", "filter.spy.clean"]);
        fs::write(Path::new(&a.worktree).join("sub/s.txt"), "changed in the submodule\n").unwrap();
        let m = crate::git_moved::main_moved(Path::new(&a.dir), Some("main"), &names(&["a.txt"])).unwrap().unwrap();
        assert_eq!((m.ours.clone(), m.theirs.clone()), (vec!["a.txt".to_string()], vec!["a.txt".to_string()]));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn reads_which_of_the_repository_s_own_settings_run_a_program_or_send_a_fetch_elsewhere() {
        let entry = |scope: &str, kv: &str| format!("{scope}\0{kv}\0");
        for (kv, shown) in [
            ("filter.lfs.smudge\ngit-lfs smudge %f", "filter.lfs.smudge"),
            ("filter.x.process\nx", "filter.x.process"),
            ("core.sshcommand\nssh -i k", "core.sshcommand"),
            ("core.gitproxy\nproxy", "core.gitproxy"),
            ("core.askpass\naskpass", "core.askpass"),
            ("core.alternaterefscommand\nx", "core.alternaterefscommand"),
            ("credential.helper\nstore", "credential.helper"),
            ("credential.https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com.helper\n!x", "credential.*.helper"),
            ("remote.origin.uploadpack\nx", "remote.origin.uploadpack"),
            ("remote.origin.receivepack\nx", "remote.origin.receivepack"),
            ("remote.origin.vcs\nx", "remote.origin.vcs"),
            ("remote.origin.url\next::sh -c x", "remote.origin.url"),
            ("remote.up.pushurl\nfd::3", "remote.up.pushurl"),
            ("url.https://TOKEN@evil.example/.insteadof\nhttps://github.com/", "url.*.insteadof"),
            ("url./tmp/x.pushinsteadof\ny", "url.*.pushinsteadof"),
        ] {
            assert_eq!(risky_setting(&entry("local", kv), true).as_deref(), Some(shown), "{kv}");
            assert_eq!(risky_setting(&entry("worktree", kv), true).as_deref(), Some(shown), "{kv}");
            // the person's own settings are theirs
            assert_eq!(risky_setting(&entry("global", kv), true), None, "{kv}");
            assert_eq!(risky_setting(&entry("system", kv), true), None, "{kv}");
            // a git that cannot say the scope is asked for the local file only
            assert_eq!(risky_setting(&format!("{kv}\0"), false).as_deref(), Some(shown), "{kv}");
        }
        for kv in ["remote.origin.url\nhttps://github.com/o/r.git", "remote.origin.url\ngit@github.com:o/r.git", "core.hookspath\n.husky", "core.fsmonitor\ntrue", "diff.external\nx", "user.name\nAna", "core.bare\nfalse", "filter.lfs.required\ntrue", "core.sshcommandx\ny", "include.path\n../x"] {
            assert_eq!(risky_setting(&entry("local", kv), true), None, "{kv}");
        }
        // the first one found is named, after any number of plain ones
        let listing = format!("{}{}{}", entry("global", "credential.helper\nosxkeychain"), entry("local", "core.bare\nfalse"), entry("local", "core.sshCommand\nx"));
        assert_eq!(risky_setting(&listing, true).as_deref(), Some("core.sshCommand"));
        // read from a real repository, a setting in a file its config includes counts as its own
        let Some((home, d)) = repo("config-risk") else { return };
        let git = Git::new(&home).unwrap();
        assert_eq!(git.config_risk(&d), None);
        fs::write(d.join(".git/more.cfg"), "[credential]\n\thelper = store\n").unwrap();
        sh(&d, &["config", "include.path", "more.cfg"]);
        assert_eq!(git.config_risk(&d).as_deref(), Some("credential.helper"));
        let _ = fs::remove_dir_all(home);
    }

    /// Item 114 (third security review, 26 Nov 2026): the settings that send a fetch somewhere else, change what it trusts or
    /// what it sends, read family by family from `git help config` (git 2.54). Every one of them in the repository's own scopes
    /// stops automatic work, named (an address in a subsection shown as `*`); the ones that only tune a fetch do not.
    #[test]
    fn every_repository_setting_that_sends_a_fetch_elsewhere_or_changes_what_it_trusts_is_read() {
        let entry = |scope: &str, kv: &str| format!("{scope}\0{kv}\0");
        for (kv, shown) in [
            // http: where it goes (a proxy, a name resolved to another address, a redirect), what it trusts, what it sends
            ("http.proxy\nhttp://127.0.0.1:9", "http.proxy"),
            ("http.https://github.com/.proxy\nhttp://127.0.0.1:9", "http.*.proxy"),
            ("http.https://TOKEN@github.com/.extraheader\nAuthorization: x", "http.*.extraheader"),
            ("http.proxyauthmethod\nbasic", "http.proxyauthmethod"),
            ("http.proxysslcainfo\n/tmp/ca", "http.proxysslcainfo"),
            ("http.sslverify\nfalse", "http.sslverify"),
            ("http.sslcainfo\n/tmp/ca.pem", "http.sslcainfo"),
            ("http.sslcapath\n/tmp/ca", "http.sslcapath"),
            ("http.sslcert\n/tmp/c.pem", "http.sslcert"),
            ("http.sslkey\n/tmp/k.pem", "http.sslkey"),
            ("http.pinnedpubkey\nsha256//x", "http.pinnedpubkey"),
            ("http.extraheader\nAuthorization: Basic x", "http.extraheader"),
            ("http.cookiefile\n/tmp/cookies", "http.cookiefile"),
            ("http.savecookies\ntrue", "http.savecookies"),
            ("http.curloptresolve\ngithub.com:443:127.0.0.1", "http.curloptresolve"),
            ("http.followredirects\ntrue", "http.followredirects"),
            ("http.emptyauth\ntrue", "http.emptyauth"),
            ("http.proactiveauth\nbasic", "http.proactiveauth"),
            ("http.delegation\nalways", "http.delegation"),
            ("http.sslbackend\nopenssl", "http.sslbackend"),
            ("http.useragent\nx", "http.useragent"),
            // a remote's own proxy
            ("remote.origin.proxy\nhttp://127.0.0.1:9", "remote.origin.proxy"),
            ("remote.origin.proxyauthmethod\nbasic", "remote.origin.proxyauthmethod"),
            // every credential setting: what is sent, to which address, and how it is protected
            ("credential.username\nme", "credential.username"),
            ("credential.usehttppath\ntrue", "credential.usehttppath"),
            ("credential.protectprotocol\nfalse", "credential.protectprotocol"),
            ("credential.sanitizeprompt\nfalse", "credential.sanitizeprompt"),
            ("credential.interactive\nfalse", "credential.interactive"),
            ("credential.https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com.username\nme", "credential.*.username"),
            // how git talks to the ssh program, and which transports it allows
            ("ssh.variant\nplink", "ssh.variant"),
            ("protocol.allow\nalways", "protocol.allow"),
            ("protocol.ext.allow\nalways", "protocol.ext.allow"),
            ("protocol.file.allow\nalways", "protocol.file.allow"),
            // a fetch that downloads from another address first, or follows one the server names
            ("fetch.bundleuri\nhttps://elsewhere.example/b", "fetch.bundleuri"),
            ("transfer.bundleuri\ntrue", "transfer.bundleuri"),
            // checkout's protection against paths that write into `.git` on this kind of disk
            ("core.protecthfs\nfalse", "core.protecthfs"),
            ("core.protectntfs\nfalse", "core.protectntfs"),
            // a submodule update that runs a command
            ("submodule.sub.update\n!sh -c x", "submodule.sub.update"),
        ] {
            assert_eq!(risky_setting(&entry("local", kv), true).as_deref(), Some(shown), "{kv}");
            assert_eq!(risky_setting(&entry("worktree", kv), true).as_deref(), Some(shown), "{kv}");
            assert_eq!(risky_setting(&format!("{kv}\0"), false).as_deref(), Some(shown), "{kv}");
            // the person's own global and system settings stay theirs
            assert_eq!(risky_setting(&entry("global", kv), true), None, "{kv}");
            assert_eq!(risky_setting(&entry("system", kv), true), None, "{kv}");
        }
        // what only tunes a fetch, or names what the app's runs override or never run, stops nothing
        for kv in [
            "remote.origin.url\nhttps://github.com/o/r.git",
            "remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*",
            "remote.origin.tagopt\n--no-tags",
            "remote.origin.prune\ntrue",
            "remote.pushdefault\norigin",
            "fetch.prune\ntrue",
            "fetch.prunetags\ntrue",
            "fetch.fsckobjects\ntrue",
            "fetch.recursesubmodules\nfalse",
            "transfer.fsckobjects\ntrue",
            "pull.rebase\ntrue",
            "submodule.sub.url\n../sub.git",
            "submodule.sub.update\nrebase",
            "core.worktree\n../w",
            "core.autocrlf\ninput",
            "branch.main.remote\norigin",
        ] {
            assert_eq!(risky_setting(&entry("local", kv), true), None, "{kv}");
        }
    }

    /// A configured fetch refspec maps what the app fetches onto other refs too (git's "opportunistic" update): a
    /// repository's `remote.<name>.fetch` could move one of the person's own branches. The app's fetch writes its own
    /// remote-tracking branch and nothing else, whatever that setting says.
    #[test]
    fn the_fetch_writes_only_its_own_remote_tracking_branch_whatever_the_configured_refspec() {
        let Some((home, d)) = repo("refmap") else { return };
        let bare = with_origin(&home, &d);
        sh(&d, &["branch", "keep"]);
        let keep = sh(&d, &["rev-parse", "keep"]);
        let theirs = advance_remote(&home, &bare, "r.txt");
        sh(&d, &["config", "remote.origin.fetch", "+refs/heads/main:refs/heads/keep"]);
        fetch_branch(&Git::automatic(&home).unwrap(), &d, "origin", "main").unwrap();
        assert_eq!(sh(&d, &["rev-parse", "refs/remotes/origin/main"]), theirs);
        assert_eq!(sh(&d, &["rev-parse", "keep"]), keep, "a branch of the person's moved");
        let _ = fs::remove_dir_all(home);
    }

    /// Item 114: a lane made with nobody there (a workflow by the clock; `unattended`, as the page sends it) first reads the
    /// repository's own config, as the automatic pull does, and makes nothing while it names a program or another address:
    /// `git worktree add` runs a smudge filter while it checks the files out, `git status` a clean filter, and a start from
    /// the remote an `ext::` address. A lane the person starts themselves is made as before (item 86).
    #[test]
    fn a_lane_made_with_nobody_there_is_not_made_where_the_repository_s_config_names_a_program() {
        let Some((home, d)) = repo("unattended") else { return };
        let unattended = |remote: bool| -> Start { serde_json::from_value(serde_json::json!({"root": "", "remote": remote, "unattended": true})).unwrap() };
        let (script, marker) = spy(&home, "smudge", false);
        let attrs = d.join(".git/info/attributes");
        fs::create_dir_all(attrs.parent().unwrap()).unwrap();
        fs::write(&attrs, "*.txt filter=spy\n").unwrap();
        let ran = || fs::read_to_string(&marker).unwrap_or_default();
        type Plant<'a> = (&'a str, Vec<(&'a str, String)>, bool, &'a str);
        let cases: Vec<Plant> = vec![
            ("a smudge filter, run by the checkout", vec![("filter.spy.smudge", script.clone())], false, "filter.spy.smudge"),
            ("a clean filter, run by the count of what did not come along", vec![("filter.spy.clean", script.clone())], false, "filter.spy.clean"),
            ("a remote that is a shell command, run by a start from the remote", vec![("remote.origin.url", format!("ext::{script} %S")), ("protocol.ext.allow", "always".into())], true, "remote.origin.url"),
            ("a proxy for the start from the remote", vec![("remote.origin.url", "http://manut-test.invalid/o/r.git".into()), ("http.proxy", "http://127.0.0.1:9".into())], true, "http.proxy"),
        ];
        sh(&d, &["remote", "add", "origin", "https://example.invalid/o/r.git"]);
        for (what, plant, remote, named) in &cases {
            for (k, v) in plant {
                sh(&d, &["config", k, v]);
            }
            let got = make_with(&home, &d, &names(&["kit/nightly"]), &unattended(*remote));
            assert_eq!(got, Err(format!("config:{named}")), "{what}");
            assert!(!marker.exists(), "{what}: a program ran: {}", ran());
            assert_eq!(sh(&d, &["branch", "--list", "kit/*"]), "", "{what}: a branch was made");
            assert!(!home.join(".manut/lanes/web-app/nightly").exists(), "{what}: a folder was made");
            for (k, _) in plant {
                let _ = std::process::Command::new("git").args(["-C", d.to_str().unwrap(), "config", "--unset", k]).output();
            }
            sh(&d, &["remote", "set-url", "origin", "https://example.invalid/o/r.git"]);
        }
        // with nothing of that kind it is made, as a person's own lane is
        let made = make_with(&home, &d, &names(&["kit/nightly"]), &unattended(false)).unwrap();
        assert_eq!(made.branch, "kit/nightly");
        // the person's own start, from the chat box, keeps item 86's rule: their repository's settings apply, as in a terminal
        sh(&d, &["config", "filter.spy.smudge", &script]);
        let mine = make(&home, &d, &names(&["kit/mine"])).unwrap();
        assert_eq!(mine.branch, "kit/mine");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_clean_up_never_removes_a_folder_with_submodules_whose_work_it_does_not_count() {
        let Some((home, d)) = repo("sub-release") else { return };
        with_origin(&home, &d);
        with_submodule(&home, &d);
        sh(&d, &["push", "-q", "origin", "main"]);
        // a submodule never checked out, its empty folder holding a file of someone's: git lists nothing for it
        let a = pushed_lane(&home, &d, "a");
        let wt = Path::new(&a.worktree);
        fs::write(wt.join("sub/notes.txt"), "mine\n").unwrap();
        assert_eq!(Git::automatic(&home).unwrap().changed(wt), Some(0));
        let r = release(&home, &a.worktree, true).unwrap();
        assert_eq!((r.removed, r.kept.as_deref()), (false, Some("submodules")), "{r:?}");
        assert_eq!(fs::read_to_string(wt.join("sub/notes.txt")).unwrap(), "mine\n");
        // a submodule checked out, with work in it that is not counted
        let b = pushed_lane(&home, &d, "b");
        let wt = Path::new(&b.worktree);
        sh(wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
        fs::write(wt.join("sub/s.txt"), "uncommitted in the submodule\n").unwrap();
        commit_in(&wt.join("sub"), "only-here.txt", "a commit on no remote\n");
        let r = release(&home, &b.worktree, true).unwrap();
        assert_eq!((r.removed, r.kept.as_deref()), (false, Some("submodules")), "{r:?}");
        // the merged clean-up's path, which asks for no remote, keeps them the same way
        assert_eq!(release(&home, &b.worktree, false).unwrap().kept.as_deref(), Some("submodules"));
        assert_eq!(fs::read_to_string(wt.join("sub/s.txt")).unwrap(), "uncommitted in the submodule\n");
        assert!(wt.join("sub/only-here.txt").exists());
        // the kept list says so for both, and for a lane with none it does not
        let got = list(&home, &d).unwrap();
        assert!(got.iter().all(|k| k.submodules), "{got:?}");
        let _ = fs::remove_dir_all(home);

        let Some((home, d)) = repo("sub-release-none") else { return };
        let plain = make(&home, &d, &names(&["kit/p"])).unwrap();
        assert!(!list(&home, &d).unwrap()[0].submodules);
        assert_eq!(Git::automatic(&home).unwrap().submodules(Path::new(&plain.worktree)), Some(false));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn remove_never_forces_a_folder_with_submodules_so_git_s_own_refusal_keeps_their_work() {
        let Some((home, d)) = repo("sub-remove") else { return };
        with_submodule(&home, &d);
        let a = make(&home, &d, &names(&["kit/a"])).unwrap();
        let wt = Path::new(&a.worktree);
        sh(wt, &["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
        // clean: git's own rule refuses a worktree with a submodule checked out, without a force flag
        let err = remove(&home, &a.worktree, &RemoveAsk::default()).unwrap_err();
        assert!(err.contains("submodules"), "{err}");
        assert!(wt.join("sub/s.txt").exists());
        // one changed file of the lane's own, counted, and uncounted work in the submodule: whatever the yes was to, the folder
        // stays, since a force would take the submodule's work with it
        fs::write(wt.join("a.txt"), "changed\n").unwrap();
        fs::write(wt.join("sub/s.txt"), "uncommitted in the submodule\n").unwrap();
        for changed in [1, 2] {
            let got = remove(&home, &a.worktree, &RemoveAsk { changed, ..RemoveAsk::default() });
            assert!(!got.as_ref().is_ok_and(|r| r.removed), "{changed}: {got:?}");
            assert_eq!(fs::read_to_string(wt.join("sub/s.txt")).unwrap(), "uncommitted in the submodule\n", "{changed}");
        }
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "changed\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn reads_every_submodule_s_own_config_too_and_stops_at_what_it_cannot_read() {
        let Some((home, d)) = repo("sub-config") else { return };
        let git = Git::automatic(&home).unwrap();
        let modules = d.join(".git/modules");
        // a submodule's git folder as git makes one: `git init --bare` writes a config of the folder's own (local) scope
        let module = |at: &Path| {
            fs::create_dir_all(at).unwrap();
            sh(&home, &["init", "-q", "--bare", at.to_str().unwrap()]);
        };
        let set = |dir: &Path, k: &str, v: &str| {
            sh(&home, &["--git-dir", dir.to_str().unwrap(), "config", k, v]);
        };
        let clear = || {
            let _ = fs::remove_dir_all(&modules);
        };
        assert_eq!(git.config_risk(&d), None);

        // (what is planted, what config_risk names): every member of the class, each alone
        type Plant<'a> = Box<dyn Fn() + 'a>;
        let mut cases: Vec<(&str, Plant<'_>, &str)> = vec![
            ("a clean filter in a submodule's own config", Box::new(|| { let m = modules.join("sub"); module(&m); set(&m, "filter.spy.clean", "x"); }), "modules/sub:filter.spy.clean"),
            ("a nested submodule's ssh command", Box::new(|| { let m = modules.join("sub"); module(&m); let n = m.join("modules/inner"); module(&n); set(&n, "core.sshCommand", "x"); }), "modules/sub/modules/inner:core.sshcommand"),
            ("a submodule whose name has a slash", Box::new(|| { let m = modules.join("libs/a"); module(&m); set(&m, "remote.origin.uploadpack", "x"); }), "modules/libs/a:remote.origin.uploadpack"),
            ("a file a submodule's config includes", Box::new(|| { let m = modules.join("sub"); module(&m); fs::write(m.join("more.cfg"), "[credential]\n\thelper = x\n").unwrap(); set(&m, "include.path", "more.cfg"); }), "modules/sub:credential.helper"),
            ("a file included only where the submodule is the repository", Box::new(|| { let m = modules.join("sub"); module(&m); fs::write(m.join("more.cfg"), "[filter \"x\"]\n\tsmudge = x\n").unwrap(); set(&m, "includeIf.gitdir:**/modules/sub.path", "more.cfg"); }), "modules/sub:filter.x.smudge"),
            ("a diff driver's program in a submodule", Box::new(|| { let m = modules.join("sub"); module(&m); set(&m, "diff.x.textconv", "x"); }), "modules/sub:diff.x.textconv"),
            ("an external diff in a submodule", Box::new(|| { let m = modules.join("sub"); module(&m); set(&m, "diff.external", "x"); }), "modules/sub:diff.external"),
            ("a fetch sent elsewhere from a submodule", Box::new(|| { let m = modules.join("sub"); module(&m); set(&m, "url.https://x.example/.insteadOf", "https://github.com/"); }), "modules/sub:url.*.insteadof"),
            ("a submodule folder git cannot read", Box::new(|| { let m = modules.join("sub"); module(&m); fs::write(m.join("config"), "[core\nnot a config\n").unwrap(); }), "modules/sub:?"),
            ("more folders than are read", Box::new(|| { for i in 0..(SUBMODULES_MAX + 1) { fs::create_dir_all(modules.join(format!("n{i}"))).unwrap(); } }), "modules:?"),
            ("folders nested deeper than are read", Box::new(|| { fs::create_dir_all(modules.join("a/b/c/d/e/f/g/h/i/j")).unwrap(); }), "modules/a/b/c/d/e/f/g/h/i:?"),
        ];
        #[cfg(unix)]
        cases.push(("a link in the modules folder", Box::new(|| { fs::create_dir_all(&modules).unwrap(); let away = home.join("away.git"); module(&away); std::os::unix::fs::symlink(&away, modules.join("sub")).unwrap(); }), "modules/sub:?"));
        for (what, plant, named) in &cases {
            plant();
            assert_eq!(git.config_risk(&d).as_deref(), Some(*named), "{what}");
            clear();
        }
        // what is not a program in a submodule's config, and a submodule folder with none, is nothing to stop for
        let m = modules.join("sub");
        module(&m);
        for (k, v) in [("core.hooksPath", "x"), ("core.fsmonitor", "x"), ("user.name", "Ana"), ("remote.origin.url", "https://github.com/o/r.git")] {
            set(&m, k, v);
        }
        fs::write(modules.join(".DS_Store"), "x").unwrap();
        assert_eq!(git.config_risk(&d), None);
        clear();
        // the repository's own diff drivers are switched off on every diff the app runs, so they stop nothing
        sh(&d, &["config", "diff.x.textconv", "x"]);
        assert_eq!(git.config_risk(&d), None);
        sh(&d, &["config", "--unset", "diff.x.textconv"]);

        // a submodule checked out with its own git folder in the work tree, not under the modules folder
        let v = d.join("vendor/x");
        fs::create_dir_all(&v).unwrap();
        sh(&v, &["init", "-q"]);
        commit_in(&v, "v.txt", "v\n");
        sh(&d, &["add", "vendor/x"]);
        assert_eq!(git.config_risk(&d), None);
        sh(&v, &["config", "filter.y.smudge", "x"]);
        assert_eq!(git.config_risk(&d).as_deref(), Some("vendor/x/.git:filter.y.smudge"));
        // one whose `.git` is a file that points at a git folder anywhere else
        let elsewhere = home.join("elsewhere.git");
        fs::rename(v.join(".git"), &elsewhere).unwrap();
        sh(&home, &["--git-dir", elsewhere.to_str().unwrap(), "config", "--unset", "filter.y.smudge"]);
        sh(&home, &["--git-dir", elsewhere.to_str().unwrap(), "config", "core.worktree", v.to_str().unwrap()]);
        fs::write(v.join(".git"), format!("gitdir: {}\n", elsewhere.display())).unwrap();
        assert_eq!(git.config_risk(&d), None);
        sh(&home, &["--git-dir", elsewhere.to_str().unwrap(), "config", "core.askPass", "x"]);
        assert_eq!(git.config_risk(&d).as_deref(), Some("vendor/x/.git:core.askpass"));
        let _ = fs::remove_dir_all(&home.join("elsewhere.git"));
        let _ = fs::remove_file(v.join(".git"));

        // the developer's folder whose own `.git` is such a file: git reads the folder it points at, and so does this
        let folder = home.join("code").join("pointed");
        fs::create_dir_all(&folder).unwrap();
        let real_git = home.join("pointed.git");
        fs::rename(d.join(".git"), &real_git).unwrap();
        sh(&home, &["--git-dir", real_git.to_str().unwrap(), "config", "core.worktree", folder.to_str().unwrap()]);
        fs::write(folder.join(".git"), format!("gitdir: {}\n", real_git.display())).unwrap();
        sh(&home, &["--git-dir", real_git.to_str().unwrap(), "config", "filter.spy.process", "x"]);
        assert_eq!(git.config_risk(&folder).as_deref(), Some("filter.spy.process"));
        // and a config git cannot read at all is not one with nothing in it
        fs::write(real_git.join("config"), "[core\nnot a config\n").unwrap();
        assert_eq!(git.config_risk(&folder).as_deref(), Some("?"));
        drop(cases);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn other_ways_a_folder_points_git_elsewhere_are_read_as_git_reads_them() {
        let Some((home, d)) = repo("elsewhere") else { return };
        let git = Git::automatic(&home).unwrap();
        // a bare repository committed inside the project, its own config naming a program: from a folder inside it git uses
        // that repository (unless the person's own `safe.bareRepository` says not to), and this reads the same config, or `?`
        let bare = d.join("vendor/evil.git");
        fs::create_dir_all(&bare).unwrap();
        sh(&home, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        sh(&home, &["--git-dir", bare.to_str().unwrap(), "config", "core.sshCommand", "x"]);
        assert!(git.config_risk(&bare).is_some());
        assert!(git.config_risk(&bare.join("refs")).is_some());
        // the automatic pull from there does nothing: it has no work tree of its own
        assert_ne!(crate::git_pull::pull(&home, &bare).why, "pulled");
        // from the project's own folder it is a folder of files like any other
        assert_eq!(git.config_risk(&d), None);
        // what the app was started with cannot send git to another repository's files or objects
        for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"] {
            assert!(REDIRECTS.contains(&k), "{k}");
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_real_submodule_whose_own_config_names_a_filter_stops_every_automatic_path_by_name() {
        let Some((home, d)) = repo("sub-config-real") else { return };
        with_origin(&home, &d);
        with_submodule(&home, &d);
        sh(&d, &["push", "-q", "origin", "main"]);
        let git = Git::automatic(&home).unwrap();
        assert_eq!(git.config_risk(&d), None);
        // checked out in the developer's folder: its git folder is under the repository's modules folder
        let marker = filter_in_submodule(&home, &d);
        assert_eq!(git.config_risk(&d).as_deref(), Some("modules/sub:filter.spy.clean"));
        sh(&d.join("sub"), &["config", "--unset", "filter.spy.clean"]);
        // checked out in a lane: under the lane's own modules folder, which the lane's reads and clean-up look at
        let made = pushed_lane(&home, &d, "s");
        let wt = Path::new(&made.worktree);
        filter_in_submodule(&home, wt);
        assert_eq!(git.config_risk(wt).as_deref(), Some("modules/sub:filter.spy.clean"));
        assert_eq!(git.config_risk(&d), None);
        let r = release(&home, &made.worktree, true).unwrap();
        assert_eq!((r.removed, r.kept.as_deref()), (false, Some("config")), "{r:?}");
        let kept = list(&home, &d).unwrap().into_iter().find(|k| k.worktree == made.worktree).unwrap();
        assert_eq!((kept.exists, kept.changed, kept.unpushed), (true, None, None));
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn no_automatic_clean_up_or_list_runs_a_program_the_repository_s_own_config_names() {
        let Some((home, d)) = repo("release-config") else { return };
        with_origin(&home, &d);
        let made = pushed_lane(&home, &d, "cfg");
        let marker = filter_in(&home, &d, Path::new(&made.worktree));
        let r = release(&home, &made.worktree, true).unwrap();
        assert_eq!((r.removed, r.kept.as_deref()), (false, Some("config")), "{r:?}");
        let kept = list(&home, &d).unwrap().into_iter().find(|k| k.worktree == made.worktree).unwrap();
        assert_eq!((kept.exists, kept.changed, kept.unpushed), (true, None, None));
        assert!(!marker.exists(), "a program ran: {}", fs::read_to_string(&marker).unwrap_or_default());
        assert!(Path::new(&made.worktree).join("a.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    /// A bare repository `origin.git` in `home`, set as `origin` of `d` with `main` pushed and tracked.
    pub(crate) fn with_origin(home: &Path, d: &Path) -> PathBuf {
        let bare = home.join("origin.git");
        fs::create_dir_all(&bare).unwrap();
        sh(&bare, &["init", "-q", "--bare"]);
        sh(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        sh(d, &["remote", "add", "origin", bare.to_str().unwrap()]);
        sh(d, &["push", "-q", "-u", "origin", "main"]);
        sh(d, &["remote", "set-head", "origin", "main"]);
        bare
    }

    /// Moves `main` on the remote by one commit from a second clone, so the developer's own copy is behind.
    fn advance_remote(home: &Path, bare: &Path, file: &str) -> String {
        let other = home.join("other");
        let _ = fs::remove_dir_all(&other);
        sh(home, &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        commit_in(&other, file, "from the remote\n");
        sh(&other, &["push", "-q", "origin", "main"]);
        sh(&other, &["rev-parse", "HEAD"])
    }

    #[test]
    fn a_prefix_is_one_or_two_plain_words_that_end_in_a_slash() {
        for ok in ["kit/", "manut/", "team/ana/", "fix-it/", "a1/"] {
            assert!(valid_prefix(ok), "{ok}");
        }
        let long = format!("{}/", "a".repeat(30));
        for bad in ["", "/", "kit", "Kit/", "kit//", "/kit/", "a/b/c/", "kit/ana", "refs/", "kit /", "-kit/", "kit-/", "ki..t/", "kit/.lock/", "é/", "kit\n/", "x y/", &long] {
            assert!(!valid_prefix(bad), "{bad:?}");
        }
        assert_eq!(prefix_of("team/ana/x"), "team/ana/");
        assert_eq!(prefix_of("kit/x"), "kit/");
    }

    #[test]
    fn a_lane_is_made_under_the_prefix_the_person_chose_and_an_earlier_prefix_still_lists_and_removes() {
        let Some((home, d)) = repo("prefix") else { return };
        let old = make(&home, &d, &names(&["kit/a"])).unwrap();
        let new = make(&home, &d, &names(&["team/ana/b", "team/ana/b-2"])).unwrap();
        assert_eq!(new.branch, "team/ana/b");
        assert_eq!(git_branch::branch(Path::new(&new.worktree)), "team/ana/b");
        assert!(new.worktree.ends_with("/web-app/b"));
        // the names taken are counted under the prefix asked for, so another prefix's branch is not in the way
        sh(&d, &["branch", "team/ana/c"]);
        assert_eq!(make(&home, &d, &names(&["team/ana/c", "team/ana/c-2"])).unwrap().branch, "team/ana/c-2");
        // names of two prefixes in one ask, and a name outside the form, are refused before git runs
        assert_eq!(make(&home, &d, &names(&["kit/x", "team/x"])), Err("bad_name".into()));
        assert_eq!(make(&home, &d, &names(&["x"])), Err("bad_name".into()));
        let listed: Vec<String> = list(&home, &d).unwrap().into_iter().map(|k| k.branch).collect();
        assert!(listed.contains(&"kit/a".to_string()) && listed.contains(&"team/ana/b".to_string()));
        assert!(remove(&home, &old.worktree, &RemoveAsk::default()).unwrap().removed);
        assert!(remove(&home, &new.worktree, &RemoveAsk::default()).unwrap().removed);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_folder_for_lanes_is_refused_inside_a_checkout_or_where_nothing_can_be_written() {
        let Some((home, d)) = repo("root") else { return };
        let ok = home.join("elsewhere/lanes");
        let real_ok = check_lanes_root(&home, ok.to_str().unwrap()).unwrap();
        assert!(real_ok.is_dir() && real_ok.ends_with("elsewhere/lanes"));
        // inside a project's checkout (the folder itself, and one below it), even when it is not made yet
        for inside in [d.clone(), d.join("apps"), d.join("not/made/yet")] {
            assert_eq!(check_lanes_root(&home, inside.to_str().unwrap()), Err("root_in_checkout".into()), "{}", inside.display());
        }
        assert!(!d.join("not").exists(), "a refused folder is never made");
        // too broad, not a path, and not absolute
        for (bad, code) in [("/", "root_too_broad"), (home.to_str().unwrap(), "root_too_broad"), (home.join(".manut").to_str().unwrap(), "root_too_broad"), (home.join(".manut/lanes/x").to_str().unwrap(), "root_too_broad"), ("", "bad_root"), ("relative/x", "bad_root"), ("/tmp/../etc", "bad_root")] {
            assert_eq!(check_lanes_root(&home, bad), Err(code.into()), "{bad}");
        }
        // a file where the folder goes, and a folder that cannot be written
        fs::write(home.join("afile"), "x").unwrap();
        assert_eq!(check_lanes_root(&home, home.join("afile").to_str().unwrap()), Err("root_unwritable".into()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = home.join("locked");
            fs::create_dir_all(&locked).unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
            // root can write anywhere, so the check only means something for anyone else
            if fs::write(locked.join("probe"), "").is_err() {
                assert_eq!(check_lanes_root(&home, locked.join("in").to_str().unwrap()), Err("root_unwritable".into()));
                assert_eq!(check_lanes_root(&home, locked.to_str().unwrap()), Err("root_unwritable".into()));
            }
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_lane_made_under_the_chosen_folder_keeps_its_record_in_the_app_s_own_folder_and_is_listed_and_removed() {
        let Some((home, d)) = repo("chosen") else { return };
        let old = make(&home, &d, &names(&["kit/old"])).unwrap();
        let root = home.join("work/lanes");
        let start = Start { root: root.to_string_lossy().into(), ..Start::default() };
        let made = make_with(&home, &d, &names(&["kit/new"]), &start).unwrap();
        let wt = root.canonicalize().unwrap().join("web-app/new");
        assert_eq!(made.worktree, wt.to_string_lossy());
        assert_eq!(git_branch::branch(&wt), "kit/new");
        // the record is under the lanes' folder, not beside the folder; the earlier lane stays where it was
        assert!(lanes_dir(&home).join("web-app/new.json").is_file() && !wt.with_extension("json").exists());
        assert!(old.worktree.starts_with(lanes_dir(&home).to_str().unwrap()));
        // a second lane of the same words takes the next folder name, in both places
        let again = make_with(&home, &d, &names(&["kit/new-2"]), &start).unwrap();
        assert!(again.worktree.ends_with("/web-app/new-2"));
        assert_eq!(list(&home, &d).unwrap().len(), 3);
        // what reads a lane's folder reads this one as a lane's
        assert!(in_a_lane(&home, &wt) && in_a_lane(&home, &wt.join("apps/web")) && !in_a_lane(&home, &root));
        assert_eq!(crate::preview::lane_folder(&home, &wt.join("nope")).ok(), None, "a folder that does not exist is not a lane's");
        assert_eq!(crate::preview::lane_folder(&home, &wt.join("apps/web")).unwrap(), wt.join("apps/web"));
        assert!(crate::preview::lane_folder(&home, &d).is_err());
        let gone = remove(&home, &made.worktree, &RemoveAsk::default()).unwrap();
        assert!(gone.removed && !wt.exists() && !lanes_dir(&home).join("web-app/new.json").exists());
        // the folder chosen has become a checkout since: no lane is made there, and none is made anywhere else
        sh(&home.join("work"), &["init", "-q"]);
        assert_eq!(make_with(&home, &d, &names(&["kit/third"]), &start), Err("root_in_checkout".into()));
        assert!(git_branch::branch(&d) == "main" && sh(&d, &["branch", "--list", "kit/third"]).is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_record_cannot_name_a_folder_the_app_did_not_make() {
        let Some((home, d)) = repo("forged") else { return };
        let made = make(&home, &d, &names(&["kit/a"])).unwrap();
        let rec_dir = lanes_dir(&home).join("web-app");
        // a record whose folder has another last name than itself, or is not a plain absolute path, is no record
        for (name, wt) in [("x", d.to_string_lossy().into_owned()), ("web-app", format!("{}/../web-app", d.display())), ("web-app", "relative/web-app".to_string())] {
            let rec = Record { v: 1, worktree: wt, repo: d.join(".git").to_string_lossy().into(), project: String::new(), prefix: String::new(), branch: "kit/a".into(), base: "main".into(), at: String::new(), made: 0 };
            fs::write(rec_dir.join(format!("{name}.json")), serde_json::to_string(&rec).unwrap()).unwrap();
        }
        assert_eq!(records(&home).len(), 1);
        // a record that does name the developer's own folder under its own name is still refused: git lists it as the main
        // worktree, never a linked one
        let rec = Record { v: 1, worktree: d.to_string_lossy().into(), repo: d.join(".git").to_string_lossy().into(), project: String::new(), prefix: String::new(), branch: "kit/a".into(), base: "main".into(), at: String::new(), made: 0 };
        fs::write(rec_dir.join("web-app.json"), serde_json::to_string(&rec).unwrap()).unwrap();
        for ask in [&RemoveAsk::default(), &RemoveAsk { changed: 9, branch: true, ahead: Some(9) }] {
            assert_eq!(remove(&home, d.to_str().unwrap(), ask), Err("not_a_lane".into()));
        }
        assert_eq!(release(&home, d.to_str().unwrap(), true), Err("not_a_lane".into()));
        assert!(d.join("a.txt").exists());
        assert_eq!(release(&home, "/nowhere/x", true), Err("not_a_lane".into()));
        let _ = made;
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_fetch_asks_no_password_and_ends_within_its_limit() {
        let Some((home, d)) = repo("net") else { return };
        let git = Git::new(&home).unwrap();
        let env = net_env(&git, &d);
        let get = |k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(get("GIT_ASKPASS").as_deref(), Some("true"));
        assert_eq!(get("GCM_INTERACTIVE").as_deref(), Some("never"));
        if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
            assert_eq!(get("GIT_SSH_COMMAND").as_deref(), Some("ssh -o BatchMode=yes"));
            // the person's own ssh command is left as theirs
            sh(&d, &["config", "core.sshCommand", "ssh -i mine"]);
            assert_eq!(net_env(&git, &d).iter().find(|(n, _)| *n == "GIT_SSH_COMMAND"), None);
        }
        // a name that is not a remote or a branch never reaches git
        assert_eq!(fetch_branch(&git, &d, "--upload-pack=x", "main"), Err("bad_name".into()));
        assert_eq!(fetch_branch(&git, &d, "origin", "-x"), Err("bad_name".into()));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn starts_from_the_latest_commit_of_the_base_branch_on_the_remote_when_asked() {
        let Some((home, d)) = repo("remote") else { return };
        let bare = with_origin(&home, &d);
        let theirs = advance_remote(&home, &bare, "r.txt");
        let local = sh(&d, &["rev-parse", "main"]);
        assert_ne!(theirs, local);
        let on = Start { remote: true, ..Start::default() };
        // off: the local commit, and nothing said
        let off = make(&home, &d, &names(&["kit/off"])).unwrap();
        assert_eq!((sh(&d, &["rev-parse", "kit/off"]), off.from.as_str(), off.local.as_str()), (local.clone(), "", ""));
        // on: fetched, and the lane starts at the remote's commit, which has the remote's file
        let made = make_with(&home, &d, &names(&["kit/on"]), &on).unwrap();
        assert_eq!((made.from.as_str(), made.local.as_str(), made.base.as_str()), ("origin/main", "", "main"));
        assert_eq!(sh(&d, &["rev-parse", "kit/on"]), theirs);
        assert!(Path::new(&made.worktree).join("r.txt").exists());
        // the developer's folder: its branch has not moved, only the remote-tracking branch was fetched
        assert_eq!((sh(&d, &["rev-parse", "main"]), git_branch::branch(&d)), (local.clone(), "main".to_string()));
        let rec = records(&home).into_iter().find(|(_, r)| r.branch == "kit/on").unwrap().1;
        assert_eq!(rec.at, theirs);
        // the base is the same local branch name, so the count of its own commits reads against it
        assert_eq!(git_branch::branch(Path::new(&made.worktree)), "kit/on");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn starts_from_the_local_commit_and_says_why_when_the_remote_cannot_be_used() {
        let Some((home, d)) = repo("local-why") else { return };
        let on = Start { remote: true, ..Start::default() };
        // no remote at all
        let a = make_with(&home, &d, &names(&["kit/a"]), &on).unwrap();
        assert_eq!((a.from.as_str(), a.local.as_str()), ("", "no_remote"));
        let bare = with_origin(&home, &d);
        // the remote cannot be reached: the fetch fails, and the lane still starts
        fs::rename(&bare, home.join("moved.git")).unwrap();
        let b = make_with(&home, &d, &names(&["kit/b"]), &on).unwrap();
        assert_eq!((b.from.as_str(), b.local.as_str()), ("", "fetch_failed"));
        fs::rename(home.join("moved.git"), &bare).unwrap();
        // the local branch has commits the remote lacks: the lane starts from them, and does not lose them
        commit_in(&d, "mine.txt", "local only\n");
        let c = make_with(&home, &d, &names(&["kit/c"]), &on).unwrap();
        assert_eq!((c.from.as_str(), c.local.as_str()), ("", "ahead"));
        assert!(Path::new(&c.worktree).join("mine.txt").exists());
        // both moved: neither is the latest, so the local one, again with its own commits
        advance_remote(&home, &bare, "r.txt");
        let e = make_with(&home, &d, &names(&["kit/e"]), &on).unwrap();
        assert_eq!((e.from.as_str(), e.local.as_str()), ("", "diverged"));
        assert!(Path::new(&e.worktree).join("mine.txt").exists());
        // a detached folder has no base branch to ask the remote about
        let head = sh(&d, &["rev-parse", "HEAD"]);
        sh(&d, &["checkout", "-q", "--detach", &head]);
        let f = make_with(&home, &d, &names(&["kit/f"]), &on).unwrap();
        assert_eq!((f.from.as_str(), f.local.as_str()), ("", "detached"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn starting_from_the_remote_never_writes_over_a_file_git_ignores_in_the_developer_s_folder() {
        let Some((home, d)) = repo("remote-ignored") else { return };
        let bare = with_origin(&home, &d);
        fs::create_dir_all(d.join(".git/info")).unwrap();
        fs::write(d.join(".git/info/exclude"), ".env\n").unwrap();
        fs::write(d.join(".env"), "TOKEN=mine\n").unwrap();
        // the remote's main brings a tracked `.env`
        let other = home.join("other");
        sh(&home, &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        fs::write(other.join(".env"), "TOKEN=theirs\n").unwrap();
        sh(&other, &["add", "-f", ".env"]);
        sh(&other, &["commit", "-q", "-m", "env"]);
        sh(&other, &["push", "-q", "origin", "main"]);
        let mine = sh(&d, &["rev-parse", "HEAD"]);
        let made = make_with(&home, &d, &names(&["kit/env"]), &Start { remote: true, ..Start::default() }).unwrap();
        assert_eq!(made.from, "origin/main");
        // the fetch moved only the remote-tracking branch; the checkout is a new folder, so the developer's file is theirs alone
        assert_eq!(fs::read_to_string(d.join(".env")).unwrap(), "TOKEN=mine\n");
        assert_eq!(sh(&d, &["rev-parse", "HEAD"]), mine);
        assert_eq!(fs::read_to_string(Path::new(&made.worktree).join(".env")).unwrap(), "TOKEN=theirs\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_remote_is_the_one_the_base_tracks_else_origin_and_a_missing_folder_falls_back() {
        let Some((home, d)) = repo("tracks") else { return };
        let bare = with_origin(&home, &d);
        // main tracks a remote named upstream whose branch is called trunk; origin also has a main that is not the one
        let up = home.join("upstream.git");
        fs::create_dir_all(&up).unwrap();
        sh(&up, &["init", "-q", "--bare"]);
        sh(&d, &["remote", "add", "upstream", up.to_str().unwrap()]);
        sh(&d, &["push", "-q", "upstream", "main:trunk"]);
        sh(&d, &["config", "branch.main.remote", "upstream"]);
        sh(&d, &["config", "branch.main.merge", "refs/heads/trunk"]);
        let other = home.join("other");
        sh(&home, &["clone", "-q", up.to_str().unwrap(), other.to_str().unwrap()]);
        sh(&other, &["checkout", "-q", "trunk"]);
        commit_in(&other, "t.txt", "trunk\n");
        sh(&other, &["push", "-q", "origin", "trunk"]);
        let trunk = sh(&other, &["rev-parse", "HEAD"]);
        let on = Start { remote: true, ..Start::default() };
        let made = make_with(&home, &d, &names(&["kit/t"]), &on).unwrap();
        assert_eq!((made.from.as_str(), sh(&d, &["rev-parse", "kit/t"])), ("upstream/trunk", trunk));
        // a branch that tracks nothing is the same name on origin
        sh(&d, &["checkout", "-q", "-b", "feature"]);
        let feature = advance_remote_branch(&home, &bare, "feature");
        let made = make_with(&home, &d, &names(&["kit/f"]), &on).unwrap();
        assert_eq!((made.from.as_str(), sh(&d, &["rev-parse", "kit/f"])), ("origin/feature", feature));
        let _ = fs::remove_dir_all(home);
    }

    /// Creates `branch` on the remote one commit past `main`, from a second clone.
    fn advance_remote_branch(home: &Path, bare: &Path, branch: &str) -> String {
        let other = home.join("other2");
        let _ = fs::remove_dir_all(&other);
        sh(home, &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        sh(&other, &["checkout", "-q", "-b", branch]);
        commit_in(&other, "f.txt", "feature\n");
        sh(&other, &["push", "-q", "origin", branch]);
        sh(&other, &["rev-parse", "HEAD"])
    }

    /// A lane with `kit/<name>` made, optionally pushed, in a repository with an origin.
    fn pushed_lane(home: &Path, d: &Path, name: &str) -> Made {
        let made = make(home, d, &names(&[&format!("kit/{name}")])).unwrap();
        let wt = Path::new(&made.worktree);
        commit_in(wt, &format!("{name}.txt"), "work\n");
        sh(wt, &["push", "-q", "origin", &made.branch]);
        made
    }

    #[test]
    fn a_clean_up_removes_a_folder_with_nothing_of_its_own_and_keeps_the_branch() {
        let Some((home, d)) = repo("release-ok") else { return };
        with_origin(&home, &d);
        let made = pushed_lane(&home, &d, "done");
        assert_eq!(release(&home, &made.worktree, true), Ok(Released { removed: true, ..Released::default() }));
        assert!(!Path::new(&made.worktree).exists());
        assert!(!sh(&d, &["branch", "--list", "kit/done"]).is_empty(), "the branch stays");
        assert!(!lanes_dir(&home).join("web-app/done.json").exists());
        // a folder already removed by hand: only git's note and the record go
        let gone = make(&home, &d, &names(&["kit/gone"])).unwrap();
        fs::remove_dir_all(&gone.worktree).unwrap();
        assert_eq!(release(&home, &gone.worktree, true).map(|r| r.removed), Ok(true));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_clean_up_never_removes_a_folder_with_work_of_its_own() {
        let Some((home, d)) = repo("release-keep") else { return };
        with_origin(&home, &d);
        let keeps = |home: &Path, made: &Made, code: &str| {
            let r = release(home, &made.worktree, true).unwrap();
            assert_eq!((r.removed, r.kept.as_deref()), (false, Some(code)), "{code}: {r:?}");
            assert!(Path::new(&made.worktree).join(".git").exists(), "{code}: the folder is still there");
        };
        // a changed tracked file
        let a = pushed_lane(&home, &d, "a");
        fs::write(Path::new(&a.worktree).join("a.txt"), "changed\n").unwrap();
        keeps(&home, &a, "changes");
        // a staged file
        let b = pushed_lane(&home, &d, "b");
        fs::write(Path::new(&b.worktree).join("staged.txt"), "x\n").unwrap();
        sh(Path::new(&b.worktree), &["add", "staged.txt"]);
        keeps(&home, &b, "changes");
        // an untracked file that is not ignored, in a folder below
        let c = pushed_lane(&home, &d, "c");
        fs::create_dir_all(Path::new(&c.worktree).join("apps/web/new")).unwrap();
        fs::write(Path::new(&c.worktree).join("apps/web/new/x.txt"), "x\n").unwrap();
        keeps(&home, &c, "changes");
        // a commit on no remote
        let e = make(&home, &d, &names(&["kit/e"])).unwrap();
        commit_in(Path::new(&e.worktree), "e.txt", "unpushed\n");
        let r = release(&home, &e.worktree, true).unwrap();
        assert_eq!((r.removed, r.kept.as_deref(), r.unpushed), (false, Some("unpushed"), Some(1)));
        // with no remote at all every commit of the branch is unpushed
        // a rebase in progress, with nothing changed in the files
        let f = pushed_lane(&home, &d, "f");
        let gd = sh(Path::new(&f.worktree), &["rev-parse", "--absolute-git-dir"]);
        fs::create_dir_all(Path::new(&gd).join("rebase-merge")).unwrap();
        keeps(&home, &f, "busy");
        // what git ignores goes with the folder, so it never keeps one
        let g = pushed_lane(&home, &d, "g");
        fs::create_dir_all(Path::new(&g.worktree).join("node_modules/x")).unwrap();
        fs::write(Path::new(&g.worktree).join("node_modules/x/i.js"), "x\n").unwrap();
        assert_eq!(release(&home, &g.worktree, true).map(|r| r.removed), Ok(true));
        // and nothing that was kept lost a file
        assert_eq!(fs::read_to_string(Path::new(&a.worktree).join("a.txt")).unwrap(), "changed\n");
        assert!(Path::new(&c.worktree).join("apps/web/new/x.txt").exists() && Path::new(&e.worktree).join("e.txt").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_clean_up_keeps_a_folder_holding_files_git_ignores_that_are_the_developer_s_and_names_them() {
        let Some((home, d)) = repo("release-ignored") else { return };
        with_origin(&home, &d);
        // the repository ignores local settings and databases (its exclude file is every worktree's)
        fs::create_dir_all(d.join(".git/info")).unwrap();
        fs::write(d.join(".git/info/exclude"), ".env.local\n*.db\ndata/\n").unwrap();
        let a = pushed_lane(&home, &d, "env");
        let wt = Path::new(&a.worktree);
        fs::write(wt.join(".env.local"), "KEY=only-here\n").unwrap();
        fs::write(wt.join("dev.db"), "rows\n").unwrap();
        fs::create_dir_all(wt.join("data/uploads")).unwrap();
        fs::write(wt.join("data/uploads/photo.jpg"), "x").unwrap();
        let r = release(&home, &a.worktree, true).unwrap();
        assert_eq!((r.removed, r.kept.as_deref()), (false, Some("ignored")), "{r:?}");
        assert_eq!(r.ignored, vec![".env.local".to_string(), "data/".into(), "dev.db".into()]);
        assert_eq!(fs::read_to_string(wt.join(".env.local")).unwrap(), "KEY=only-here\n");
        assert!(wt.join("dev.db").exists() && wt.join("data/uploads/photo.jpg").exists());
        // the kept list names them too, so a folder kept after its chat was deleted says why
        let kept = list(&home, &d).unwrap().into_iter().find(|k| k.worktree == a.worktree).unwrap();
        assert_eq!(kept.ignored, vec![".env.local".to_string(), "data/".into(), "dev.db".into()]);
        // the merged clean-up's path (no remote proof asked) keeps it the same way
        assert_eq!(release(&home, &a.worktree, false).unwrap().kept.as_deref(), Some("ignored"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_clean_up_still_takes_what_a_project_rebuilds_and_the_agent_settings_the_app_copied_in() {
        let Some((home, d)) = repo("release-rebuilt") else { return };
        with_origin(&home, &d);
        // the developer's own agent settings, which the lane brings in ignored (lane_config.rs)
        fs::create_dir_all(d.join(".git/info")).unwrap();
        fs::write(d.join(".git/info/exclude"), ".mcp.json\ntarget/\n.next/\n.DS_Store\n").unwrap();
        fs::write(d.join(".mcp.json"), "{}\n").unwrap();
        fs::create_dir_all(d.join(".claude")).unwrap();
        fs::write(d.join(".claude/settings.local.json"), "{}\n").unwrap();
        let a = pushed_lane(&home, &d, "deps");
        assert_eq!(a.config, 2, "{a:?}");
        let wt = Path::new(&a.worktree);
        // an agent writes its own local setting (an "always allow"), and the lane installs and builds
        fs::write(wt.join(".claude/settings.local.json"), "{\"allow\":[\"x\"]}\n").unwrap();
        for f in ["node_modules/q/index.js", "apps/web/node_modules/r/i.js", "target/debug/app", ".next/cache/x", ".DS_Store"] {
            fs::create_dir_all(wt.join(f).parent().unwrap()).unwrap();
            fs::write(wt.join(f), "x").unwrap();
        }
        assert_eq!(list(&home, &d).unwrap()[0].ignored, Vec::<String>::new());
        assert_eq!(release(&home, &a.worktree, true).map(|r| r.removed), Ok(true));
        assert!(!wt.exists());
        // the developer's own copies stay in their folder
        assert!(d.join(".mcp.json").exists() && d.join(".claude/settings.local.json").exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_clean_up_with_no_remote_keeps_a_branch_with_commits_and_removes_one_with_none() {
        let Some((home, d)) = repo("release-noremote") else { return };
        let fresh = make(&home, &d, &names(&["kit/fresh"])).unwrap();
        // no remote: main's own commit is on no remote either, so nothing here is "pushed"
        let r = release(&home, &fresh.worktree, true).unwrap();
        assert_eq!((r.removed, r.kept.as_deref()), (false, Some("unpushed")));
        // the page's other path (a merged lane) has its own proof of the commits and asks for no remote
        let r = release(&home, &fresh.worktree, false).unwrap();
        assert!(r.removed);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn a_clean_up_never_passes_a_force_flag_so_git_s_own_refusal_keeps_the_folder() {
        let Some((home, d)) = repo("release-noforce") else { return };
        with_origin(&home, &d);
        let made = pushed_lane(&home, &d, "locked");
        // git's own refusal to remove a locked worktree is not got past
        sh(&d, &["worktree", "lock", &made.worktree]);
        let r = release(&home, &made.worktree, true).unwrap();
        assert!(!r.removed, "{r:?}");
        assert!(Path::new(&made.worktree).join("a.txt").exists());
        sh(&d, &["worktree", "unlock", &made.worktree]);
        assert!(release(&home, &made.worktree, true).unwrap().removed);
        let _ = fs::remove_dir_all(home);
    }
}
