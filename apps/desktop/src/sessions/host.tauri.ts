// The desktop app's session host: every call goes through the Tauri shell. Split out of host.ts (item 125c); host.ts re-exports it.
import { type AgentId, type AgentInfo } from "./agents";
import { tauriTurnFiles, type TurnFilesHost } from "./turnFiles";
import { type CustomEntry, type CustomList, type CustomPreview } from "./custom";
import { t } from "../i18n";
import type { DiskState } from "../lib/disk";
import type { ImportApp, ImportProfile } from "./term/import";
import { readLaneFolder } from "../code/laneFolder";
import { savedKeys } from "../code/secrets";
import { readView } from "../code/moved";
import { readCleaned, readKept, readMade, readReleased, readRemoved, type LaneRemoveAsk } from "../code/laneBranch";
import { readAgentConfig } from "../settings/mcp/agentConfig";
import { readInstallAsk, readInstallDone, readLinkRead, readSkillReads } from "../runtime/skillBundle";
import { readAsk, readDone, readDraft, readMadeProject, readPulled, readRepoAsk, readTools, type MergeMethod } from "../code/source";
import { type ProviderPatch, type ProviderView } from "../settings/providers/model";
import type { ChatInput, ChatEvent, PastChat, ConvState, PastMsg, BuddyChatInput, BuddyHost, TitleRequest, TitleWords, SessionHost, LaneStart } from "./host";

// ---- Tauri ----------------------------------------------------------------------------------

export class TauriHost implements SessionHost, BuddyHost {
  readonly kind = "tauri" as const;
  readonly turnFiles: TurnFilesHost = tauriTurnFiles(async () => (await this.core()).invoke);
  /** The shell's command bridge (a test stands in for it by overriding this). */
  protected async core(): Promise<Pick<typeof import("@tauri-apps/api/core"), "invoke" | "Channel">> {
    return import("@tauri-apps/api/core");
  }
  async reset() {
    const { invoke } = await this.core();
    // the lanes' previews too (src-tauri/src/preview.rs): a preview whose page is gone would run on unseen. A shell older than
    // the preview has no such command, and that stops nothing else.
    await Promise.all([invoke("session_close_all"), invoke("chat_close_all"), invoke("preview_close_all").catch(() => undefined)]);
  }
  async agents() {
    const { invoke } = await this.core();
    return invoke<AgentInfo[]>("sessions_agents");
  }
  async home() {
    const { homeDir } = await import("@tauri-apps/api/path");
    return homeDir();
  }
  async pickFolder(defaultPath: string) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    // canCreateDirectories: the dialog's own "New Folder" button (macOS); manut itself makes no folder
    const r = await open({ directory: true, multiple: false, canCreateDirectories: true, defaultPath, title: t("ss.pickFolder") });
    return typeof r === "string" ? r : null;
  }
  async start(agent: AgentId, cwd: string, cols: number, rows: number, onData: (d: Uint8Array) => void, onExit: (c: number | null) => void, resume?: string, account?: string, sessionId?: string, link?: string) {
    const { invoke, Channel } = await this.core();
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (b) => onData(new Uint8Array(b));
    const exit = new Channel<number | null>();
    exit.onmessage = (c) => onExit(c);
    return invoke<number>("session_start", { agent, cwd, sessionId: sessionId ?? null, resume: resume ?? null, link: link ?? null, account: account ?? null, cols, rows, onData: data, onExit: exit });
  }
  async chatStart(agent: AgentId, cwd: string, onEvent: (ev: ChatEvent) => void, resume?: string, account?: string, session?: string, suggest?: boolean, mode?: string) {
    const { invoke, Channel } = await this.core();
    const ch = new Channel<ChatEvent>();
    ch.onmessage = (ev) => onEvent(ev);
    // `suggest`: the person turned on suggested next messages (lib/suggest.ts); the shell passes Claude Code its own flag for it.
    // `mode`: checked again in the shell against the agent's own list, and none means its careful one
    return invoke<number>("chat_start", { agent, cwd, resume: resume ?? null, account: account ?? null, session: session ?? null, suggest: suggest === true, mode: mode ?? null, onEvent: ch });
  }
  async chatInput(id: number, input: ChatInput) {
    const { invoke } = await this.core();
    await invoke("chat_input", { id, input });
  }
  async chatClose(id: number) {
    const { invoke } = await this.core();
    await invoke("chat_close", { id });
  }
  async buddyStart(agent: AgentId, prompt: string, onEvent: (ev: ChatEvent) => void) {
    const { invoke, Channel } = await this.core();
    const ch = new Channel<ChatEvent>();
    ch.onmessage = (ev) => onEvent(ev);
    return invoke<number>("buddy_start", { agent, prompt, onEvent: ch });
  }
  async buddyInput(id: number, input: BuddyChatInput) {
    const { invoke } = await this.core();
    await invoke("buddy_input", { id, input });
  }
  async buddyClose(id: number) {
    const { invoke } = await this.core();
    await invoke("buddy_close", { id });
  }
  async buddyCloseAll() {
    const { invoke } = await this.core();
    await invoke("buddy_close_all");
  }
  async buddySaveFile(name: string, data: Uint8Array) {
    const { invoke } = await this.core();
    // as a session's file: the bytes raw, the name in a header
    return invoke<string>("buddy_file_save", data, { headers: { "x-name": encodeURIComponent(name) } });
  }
  async saveFile(session: string, name: string, data: Uint8Array) {
    const { invoke } = await this.core();
    // the bytes go raw (no JSON array of numbers); the name rides in a header
    return invoke<string>("session_file_save", data, { headers: { "x-session": session, "x-name": encodeURIComponent(name) } });
  }
  async readFile(path: string) {
    const { invoke } = await this.core();
    return new Uint8Array(await invoke<ArrayBuffer>("session_file_read", { path }));
  }
  async removeFiles(session: string) {
    const { invoke } = await this.core();
    await invoke("session_files_remove", { session });
  }
  async historySave(key: string, text: string, since: number) {
    const { invoke } = await this.core();
    await invoke("term_history_save", { key, text, since });
  }
  async historyRead(key: string) {
    const { invoke } = await this.core();
    const got = await invoke<[string, number] | null>("term_history_read", { key });
    return got ? { text: got[0], at: got[1] } : null;
  }
  async historyRemove(key: string) {
    const { invoke } = await this.core();
    await invoke("term_history_remove", { key });
  }
  async historyPrune(keep: string[]) {
    const { invoke } = await this.core();
    await invoke("term_history_prune", { keep });
  }
  async historyClear() {
    const { invoke } = await this.core();
    await invoke("term_history_clear");
  }
  async termImportList() {
    const { invoke } = await this.core();
    return invoke<ImportApp[]>("term_import_list");
  }
  async termImportRead(app: ImportApp) {
    const { invoke } = await this.core();
    return invoke<ImportProfile[]>("term_import_read", { app });
  }
  async pruneFiles(keep: string[]) {
    const { invoke } = await this.core();
    await invoke("session_files_prune", { keep });
  }
  async branch(cwd: string) {
    const { invoke } = await this.core();
    return invoke<string>("session_branch", { cwd });
  }
  async laneRootCheck(root: string) {
    const { invoke } = await this.core();
    return invoke<string>("lane_root_check", { root });
  }
  async agentConfig(cwd?: string) {
    const { invoke } = await this.core();
    return readAgentConfig(await invoke<unknown>("agent_config_list", { cwd: cwd || null }));
  }
  async skillBundleRead(agent: "claude" | "codex", folders: string[]) {
    const { invoke } = await this.core();
    const read = readSkillReads(await invoke<unknown>("skill_bundle_read", { agent, folders }));
    if (!read) throw new Error("unreadable");
    return read;
  }
  async skillLinkRead(link: string, origin: string) {
    const { invoke } = await this.core();
    const read = readLinkRead(await invoke<unknown>("skill_link_read", { link, origin }));
    if (!read) throw new Error("unreadable");
    return read;
  }
  async skillInstallAsk(read: string, names: string[], agent: "claude" | "codex") {
    const { invoke } = await this.core();
    const ask = readInstallAsk(await invoke<unknown>("skill_install_ask", { read, names, agent }));
    if (!ask) throw new Error("unreadable");
    return ask;
  }
  async skillInstallSettle(id: string, yes: boolean) {
    const { invoke } = await this.core();
    const done = readInstallDone(await invoke<unknown>("skill_install_settle", { id, yes }));
    if (!done) throw new Error("unreadable");
    return done;
  }
  async skillInstallWithdraw(id: string) {
    const { invoke } = await this.core();
    await invoke("skill_install_withdraw", { id });
  }
  async sourceTools(fresh = false) {
    const { invoke } = await this.core();
    return readTools(await invoke<unknown>("source_tools", { fresh }));
  }
  async sourcePull(cwd: string) {
    const { invoke } = await this.core();
    return readPulled(await invoke<unknown>("source_pull", { cwd }));
  }
  async titleRun(req: TitleRequest): Promise<TitleWords> {
    const { invoke } = await this.core();
    const v = await invoke<unknown>("title_run", { request: req });
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return { title: typeof o.title === "string" ? o.title : "", body: typeof o.body === "string" ? o.body : "" };
  }
  async titleCancel(key: string) {
    const { invoke } = await this.core();
    await invoke<unknown>("title_cancel", { key });
  }
  async reviewDraft(worktree: string) {
    const { invoke } = await this.core();
    return readDraft(await invoke<unknown>("review_draft", { worktree }));
  }
  async reviewAsk(worktree: string, title: string, body: string) {
    const { invoke } = await this.core();
    const ask = readAsk(await invoke<unknown>("review_ask_open", { worktree, title, body }));
    if (!ask) throw new Error("unread");
    return ask;
  }
  async reviewMerge(worktree: string, number: number, method: MergeMethod, credits = false) {
    const { invoke } = await this.core();
    const ask = readAsk(await invoke<unknown>("review_ask_merge", { worktree, number, method, credits }));
    if (!ask || ask.kind !== "merge") throw new Error("unread");
    return ask;
  }
  async reviewMergePull(folder: string, source: "github" | "gitlab", repo: string, number: number, method: MergeMethod, credits = false) {
    const { invoke } = await this.core();
    const ask = readAsk(await invoke<unknown>("review_ask_merge_pull", { folder, source, repo, number, method, credits }));
    if (!ask || ask.kind !== "merge") throw new Error("unread");
    return ask;
  }
  async projectNew(path: string) {
    const { invoke } = await this.core();
    const made = readMadeProject(await invoke<unknown>("project_new", { path }));
    if (!made) throw new Error("unread");
    return made;
  }
  async repoAsk(folder: string, name: string, isPublic: boolean) {
    const { invoke } = await this.core();
    const ask = readRepoAsk(await invoke<unknown>("review_ask_repo", { folder, name, public: isPublic }));
    if (!ask) throw new Error("unread");
    return ask;
  }
  async reviewSettle(id: string, yes: boolean) {
    const { invoke } = await this.core();
    const done = readDone(await invoke<unknown>("review_settle", { id, yes }));
    if (!done) throw new Error("unread");
    return done;
  }
  async reviewWithdraw(id: string) {
    const { invoke } = await this.core();
    await invoke("review_withdraw", { id });
  }
  async laneRelease(worktree: string) {
    const { invoke } = await this.core();
    return readReleased(await invoke<unknown>("lane_release", { worktree }));
  }
  async laneCleanMerged(cwd: string, held: string[]) {
    const { invoke } = await this.core();
    return readCleaned(await invoke<unknown>("lane_clean_merged", { cwd, held }));
  }
  async laneWorktree(cwd: string, names: string[], start?: LaneStart) {
    const { invoke } = await this.core();
    const made = readMade(await invoke<unknown>("lane_worktree", { cwd, names, start: start ?? null }));
    if (!made) throw new Error("no_folder");
    return made;
  }
  async laneList(cwd: string) {
    const { invoke } = await this.core();
    return readKept(await invoke<unknown>("lane_list", { cwd }));
  }
  async laneProjects() {
    const { invoke } = await this.core();
    const got = await invoke<unknown>("lane_projects");
    return Array.isArray(got) ? got.filter((p): p is string => typeof p === "string" && p !== "") : [];
  }
  async laneRemove(worktree: string, ask: LaneRemoveAsk) {
    const { invoke } = await this.core();
    return readRemoved(await invoke<unknown>("lane_remove", { worktree, ask }));
  }
  async laneDiff(worktree: string) {
    const { invoke } = await this.core();
    return readLaneFolder(await invoke<unknown>("lane_diff", { worktree }));
  }
  async laneKeys(worktree: string) {
    const { invoke } = await this.core();
    // with the commits a push would send (item 120)
    return savedKeys(await invoke<unknown>("lane_diff", { worktree, history: true }));
  }
  async mainMoved(cwd: string, o: { base?: string | null; show?: string[] } = {}) {
    const { invoke } = await this.core();
    return readView(await invoke<unknown>("session_main_moved", { cwd, base: o.base ?? null, show: o.show ?? [] }));
  }
  async projectIcon(cwd: string) {
    const { invoke } = await this.core();
    const got = await invoke<unknown>("project_icon", { cwd });
    return typeof got === "string" ? got : null;
  }
  async reveal(cwd: string) {
    const { invoke } = await this.core();
    await invoke("session_reveal", { cwd });
  }
  async openTerminal(cwd: string) {
    const { invoke } = await this.core();
    await invoke("session_open_terminal", { cwd });
  }
  async editors() {
    const { invoke } = await this.core();
    const list = await invoke<unknown>("editors_installed");
    // (id, label) pairs, as the shell sends them
    return Array.isArray(list) ? list.flatMap((p) => (Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" ? [{ id: p[0], label: p[1] }] : [])) : [];
  }
  async openInEditor(cwd: string, editor: string) {
    const { invoke } = await this.core();
    await invoke("session_open_in_editor", { cwd, editor });
  }
  async pastChats(agent: "claude" | "codex", cwds: string[]) {
    const { invoke } = await this.core();
    return invoke<PastChat[]>("past_chats_list", { agent, cwds });
  }
  async pastMessages(agent: "claude" | "codex", id: string, cwd: string) {
    const { invoke } = await this.core();
    return invoke<PastMsg[]>("past_chat_messages", { agent, id, cwd });
  }
  async conversationState(agent: "claude" | "codex", id: string, account?: string) {
    const { invoke } = await this.core();
    return invoke<ConvState>("conversation_state", { agent, id, account: account ?? null });
  }
  async codexConversation(id: number) {
    const { invoke } = await this.core();
    return invoke<string | null>("codex_conversation", { id });
  }
  async badge(count: number) {
    const { invoke } = await this.core();
    await invoke("asks_badge", { count });
  }
  async power(busy: boolean, now: boolean) {
    const { invoke } = await this.core();
    await invoke("power_busy", { busy, now });
  }
  async providers() {
    const { invoke } = await this.core();
    return invoke<ProviderView[]>("providers_list");
  }
  async providerSave(id: string, patch: ProviderPatch) {
    const { invoke } = await this.core();
    return invoke<ProviderView>("provider_save", { id, patch });
  }
  async providerVersion(id: string) {
    const { invoke } = await this.core();
    return invoke<string | null>("provider_version", { id });
  }
  async customList() {
    const { invoke } = await this.core();
    return invoke<CustomList>("custom_agents_list");
  }
  async customPreview(label: string, program: string, args: string, install: string) {
    const { invoke } = await this.core();
    return invoke<CustomPreview>("custom_agent_preview", { label, program, args, install });
  }
  async customBotPreview(label: string, program: string, args: string[], install: string) {
    const { invoke } = await this.core();
    return invoke<CustomPreview>("custom_agent_bot_preview", { label, program, args, install });
  }
  async customConfirm(entry: CustomEntry) {
    const { invoke } = await this.core();
    await invoke("custom_agent_confirm", { entry });
  }
  async customRemove(id: string) {
    const { invoke } = await this.core();
    await invoke("custom_agent_remove", { id });
  }
  async diskWatch(warnGb: number) {
    const { invoke } = await this.core();
    return invoke<DiskState>("disk_watch", { warnGb });
  }
  onDiskLevel(fn: (s: DiskState) => void) {
    let stop: (() => void) | null = null;
    let gone = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<DiskState>("disk-level", (e) => fn(e.payload)))
      .then((un) => (gone ? un() : (stop = un)))
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }
  async write(id: number, data: string) {
    const { invoke } = await this.core();
    await invoke("session_write", { id, data });
  }
  /** Drawn bytes not yet sent to the shell, by session. */
  private drawn = new Map<number, number>();
  /** A send of `drawn` is waiting for the end of this task. */
  private sending = false;
  /** One `session_ack` per session for everything drawn in the same task: xterm runs the callbacks of a whole
   *  slice of its write queue (up to 12 ms of messages) in one task, so a flood costs one call per slice instead
   *  of one per message. A call that fails is not lost credit: its bytes go back into `drawn` and ride on the next
   *  acknowledgement (any session's), so the shell's count of what the page has drawn stays whole. */
  ack(id: number, bytes: number) {
    this.drawn.set(id, (this.drawn.get(id) ?? 0) + bytes);
    if (this.sending) return;
    this.sending = true;
    queueMicrotask(() => {
      this.sending = false;
      const all = [...this.drawn];
      this.drawn.clear();
      const keep = (sid: number, n: number) => void this.drawn.set(sid, (this.drawn.get(sid) ?? 0) + n);
      void this.core().then(
        ({ invoke }) => {
          for (const [sid, n] of all) void invoke("session_ack", { id: sid, bytes: n }).catch(() => keep(sid, n));
        },
        () => all.forEach(([sid, n]) => keep(sid, n)),
      );
    });
  }
  async resize(id: number, cols: number, rows: number) {
    const { invoke } = await this.core();
    await invoke("session_resize", { id, cols, rows });
  }
  async close(id: number) {
    const { invoke } = await this.core();
    await invoke("session_close", { id });
  }
}

