// Reads what the report names from this computer (item 105): the shell's three facts, each coding agent as Settings ›
// Providers reads it, git as Settings › Source control reads it, the kept problems and the switches. Only reads. Nothing
// is sent anywhere from here; the page shows the result first.
import { isAppStore } from "../appStore";
import { sourceSettings } from "../lib/sourceControl";
import { artifactSettings } from "../lib/artifactLinks";
import { outsideUseOn } from "../usage/outside";
import { readRuntimeSetting } from "../runtime/setting";
import { notifyEnabled, notifyErrorsEnabled } from "../state/store";
import { getHost } from "../sessions/host";
import { getSessions } from "../sessions/sessions";
import { accountsNow, reloadAccounts } from "../settings/accounts/useAccounts";
import { shownName, signinAgent } from "../settings/providers/model";
import { recentErrors } from "./errors";
import type { ReportAgent, ReportInput } from "./report";

/** What the shell says about this computer. */
export interface SystemFacts {
  app: string;
  macos: string;
  chip: string;
}

type Win = { __manutReportSystem?: SystemFacts } & Partial<{ __TAURI_INTERNALS__: unknown }>;

/** The shell's `report_system`, or the e2e stand-in; empty facts in a plain browser. */
export async function systemFacts(w: Win = window as unknown as Win): Promise<SystemFacts> {
  if (w.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<SystemFacts>("report_system");
  }
  return w.__manutReportSystem ?? { app: "", macos: "", chip: "" };
}

/** The Settings switches that change what the app does, each with its own name (the report is plain English whatever the
 *  app's language, because a coding agent or a maintainer reads it). */
export function switches(): { label: string; on: boolean }[] {
  const source = sourceSettings();
  const artifacts = artifactSettings();
  return [
    { label: "Connected runtime (otherwise Practice)", on: readRuntimeSetting().mode === "connected" },
    { label: "Notify me", on: notifyEnabled() },
    { label: "Also notify on errors", on: notifyErrorsEnabled() },
    { label: "Read use outside Manut AI", on: outsideUseOn() },
    { label: "Automatically pull", on: source.autoPull },
    { label: "Remove agent credits when merging", on: source.dropCredits },
    { label: "Publish files as public links", on: artifacts.publish },
  ];
}

/** Everything the report is built from, read now. Agent versions are read one at a time (each starts a program). */
export async function gather(): Promise<ReportInput> {
  const host = getHost();
  const [facts, tools] = await Promise.all([systemFacts().catch(() => ({ app: "", macos: "", chip: "" })), host.sourceTools?.().catch(() => null) ?? Promise.resolve(null)]);
  await reloadAccounts().catch(() => undefined);
  const acc = accountsNow();
  const views = (await host.providers?.().catch(() => [])) ?? [];
  const agents: ReportAgent[] = [];
  for (const v of views) {
    const installed = v.found !== null;
    const version = installed && v.version && host.providerVersion ? ((await host.providerVersion(v.id).catch(() => null)) ?? "") : "";
    let signedIn: boolean | null = null;
    if (installed && v.signin && signinAgent(v.id)) {
      // Cursor and Antigravity: their own status command, read now like the version (item 101a)
      const st = host.providerSignin ? await host.providerSignin(v.id).catch(() => null) : null;
      signedIn = st ? st.logged_in : null;
    } else if (installed && v.signin) {
      const g = acc.groups?.find((x) => x.cli === v.id);
      const st = acc.status[`${v.id}:${g?.active ?? "default"}`];
      signedIn = st ? st.logged_in : null;
    }
    // the agent's own name, never the one the person gave it (`shownName` would say it)
    agents.push({ label: v.label || shownName(v), installed, version, signedIn });
  }
  return {
    app: facts.app,
    edition: isAppStore() ? "app-store" : "github",
    macos: facts.macos,
    chip: facts.chip,
    agents,
    git: { installed: !!tools?.git.installed, version: tools?.git.version ?? "" },
    errors: recentErrors(),
    switches: switches(),
    home: getSessions().getState().home ?? "",
  };
}
