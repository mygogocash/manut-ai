// What Accounts asks the desktop app (Tauri commands in src-tauri/src/accounts.rs): which coding CLIs are on
// this computer, a CLI's own login status, and the CLI's own sign-in with an account's home; and since item 74 the
// accounts list itself and its changes, which the Hermes bridge used to keep, so Practice and Connected have them too.
// In a plain browser (dev, e2e) there is no app: e2e injects a stand-in as `window.__manutAccountHost`, and the list
// comes from the runtime's `accounts.*` ops as before; otherwise the page says signing in needs the desktop app.
import type { AccountCli, AccountGroup } from "../../lib/protocol";
import { t } from "../../i18n";
import { getStore } from "../../state/store";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** What manut keeps from a CLI's status (never its text, a token or a key). */
export interface LoginStatus {
  logged_in: boolean;
  email: string | null;
  plan: string | null;
  method: string | null;
  last_refresh?: string | null;
}

export type SignInEvent = { kind: "line"; text: string } | { kind: "exit"; code: number | null };

export interface AccountHost {
  /** Can run the CLIs' sign-in here. */
  canSignIn: boolean;
  /** cli -> on this computer, or null when unknown (the bridge's PATH check stands). */
  clis(): Promise<Partial<Record<AccountCli, boolean>> | null>;
  /** null: this CLI has no status command (or there is no app). */
  status(cli: AccountCli, account: string): Promise<LoginStatus | null>;
  /** The CLI's version token (\"2.1.322\"), or null: no `--version` for this CLI, nothing parseable, or no app. */
  version(cli: AccountCli): Promise<string | null>;
  signIn(cli: AccountCli, account: string, onEvent: (ev: SignInEvent) => void): Promise<number>;
  cancel(login: number): Promise<void>;
  /** The accounts list kept by the shell (absent: the runtime's `accounts.*` ops keep it). */
  list?(): Promise<AccountGroup[]>;
  add?(cli: AccountCli, label: string): Promise<{ id: string; dir: string }>;
  setActive?(cli: AccountCli, account: string): Promise<void>;
  label?(cli: AccountCli, account: string, label: string): Promise<void>;
  remove?(cli: AccountCli, account: string): Promise<void>;
  discard?(cli: AccountCli, account: string): Promise<void>;
}

declare global {
  interface Window {
    __manutAccountHost?: AccountHost;
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function core() {
  return (await import("@tauri-apps/api/core")) as unknown as { invoke: Invoke; Channel: new <T>() => { onmessage: (m: T) => void } };
}

const tauriHost: AccountHost = {
  canSignIn: true,
  async clis() {
    const { invoke } = await core();
    const pairs = await invoke<[AccountCli, boolean][]>("account_clis");
    return Object.fromEntries(pairs);
  },
  async status(cli, account) {
    const { invoke } = await core();
    return invoke<LoginStatus | null>("account_status", { cli, id: account });
  },
  async version(cli) {
    const { invoke } = await core();
    return invoke<string | null>("account_version", { cli });
  },
  async signIn(cli, account, onEvent) {
    const { invoke, Channel } = await core();
    const ch = new Channel<SignInEvent>();
    ch.onmessage = onEvent;
    return invoke<number>("account_login_start", { cli, id: account, onEvent: ch });
  },
  async cancel(login) {
    const { invoke } = await core();
    await invoke("account_login_cancel", { login });
  },
  async list() {
    const { invoke } = await core();
    return invoke<AccountGroup[]>("accounts_list");
  },
  async add(cli, label) {
    const { invoke } = await core();
    return invoke<{ id: string; dir: string }>("accounts_add", { cli, label });
  },
  async setActive(cli, account) {
    const { invoke } = await core();
    await invoke("accounts_set_active", { cli, account });
  },
  async label(cli, account, label) {
    const { invoke } = await core();
    await invoke("accounts_label", { cli, account, label });
  },
  async remove(cli, account) {
    const { invoke } = await core();
    await invoke("accounts_remove", { cli, account });
  },
  async discard(cli, account) {
    const { invoke } = await core();
    await invoke("accounts_discard", { cli, account });
  },
};

/** The accounts' changes: through the shell when it keeps the list, else through the runtime's ops (the bridge's). */
export function accountOps() {
  const h = accountHost();
  const s = () => getStore().actions;
  return {
    add: (cli: AccountCli, label: string) => (h.add ? h.add(cli, label) : s().addAccount(cli, label)),
    setActive: async (cli: AccountCli, account: string) => void (h.setActive ? await h.setActive(cli, account) : await s().setActiveAccount(cli, account)),
    label: async (cli: AccountCli, account: string, label: string) => void (h.label ? await h.label(cli, account, label) : await s().labelAccount(cli, account, label)),
    remove: async (cli: AccountCli, account: string) => void (h.remove ? await h.remove(cli, account) : await s().removeAccount(cli, account)),
    discard: async (cli: AccountCli, account: string) => void (h.discard ? await h.discard(cli, account) : await s().discardAccount(cli, account)),
  };
}

const noHost: AccountHost = {
  canSignIn: false,
  clis: async () => null,
  status: async () => null,
  version: async () => null,
  signIn: async () => {
    throw new Error(t("acc.needsApp"));
  },
  cancel: async () => {},
};

export function accountHost(): AccountHost {
  if (isDesktop()) return tauriHost;
  return (typeof window !== "undefined" && window.__manutAccountHost) || noHost;
}
