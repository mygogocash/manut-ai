// Delete account (item 124; App Review Guideline 5.1.1(v); docs/pilot-api.md, "Deleting your own account").
//
// The account's row is in Settings › General, the page the "You" row at the foot of the side menu opens, in a group of its
// own under the shop's: in Practice it says there is no account to delete, signed out that there is none here, and signed
// in it opens this page. The page is the design canvas's danger pattern (Settings.dc.html, "Delete this shop"; KitActions:
// "Something that cannot be undone: btn danger, and btn danger solid for the last step only"), as a page because what goes
// is a list: step 1 says exactly what goes and what stays and that it cannot be undone, with Continue and Keep my account;
// step 2 asks for each owned shop's name to be typed (an owner) or for the red Delete (a helper). The API checks the names
// again and refuses anything the person was not shown (`owned_changed`), so the second step is not the app's alone.
//
// After it the person is signed out (session.ts forgets the session the API ended), the saved runtime is Practice for the
// next start, and the page says it is done, what went, and what became of the Sign in with Apple link. It does not restart
// the app by itself, since a restart stops the terminals and coding sessions the page just said it does not touch; it
// offers the restart.
//
// `DeleteAccountView` and `DeleteAccountRow` draw a given state, so the tests draw every one; `DeleteAccountPage` and
// `AccountRows` keep the state and act.
import { useEffect, useRef, useState } from "react";
import { t, type Key } from "../i18n";
import { runtimeKind, startedRuntime } from "../runtime";
import { sessionFor } from "../runtime/http";
import type { AccountDeletion, AppleEnd, ShopName } from "../runtime/http/session";
import { restartApp, saveRuntimeChoice, useSignIn } from "../runtime/link";
import { readRuntimeSetting } from "../runtime/setting";
import { useStore } from "../state/store";

/** What the row and the page are about: no account (Practice, or Connected and signed out), or the signed-in account. */
export type AccountStatus = "practice" | "signed_out" | "loading" | "signed_in" | "deleted";

/** What went wrong with the last press, in the words the page has for each. */
export type DeleteError = "changed" | "name" | "running" | "incomplete" | "offline" | "failed" | "signedOut";

export type DeleteStep =
  | { kind: "what"; error?: DeleteError }
  | { kind: "confirm"; busy: boolean; error?: DeleteError }
  | { kind: "done"; shops: ShopName[]; left: ShopName[]; apple?: AppleEnd };

export interface DeleteAccountViewProps {
  status: AccountStatus;
  /** the shops the account owns, and the ones it helps at, each by name */
  owned: ShopName[];
  helping: ShopName[];
  step: DeleteStep;
  /** what has been typed for each owned shop, by its id */
  typed: Record<string, string>;
  onType: (shop: string, text: string) => void;
  onContinue: () => void;
  onKeep: () => void;
  onDelete: () => void;
  onRestart: () => void;
}

/** A typed name and the shop's are the same when they differ only in outer spaces or in how an accent was typed, as the
 *  API reads them (apps/api/src/account-deletion.ts). */
export function sameName(typed: string, name: string): boolean {
  return typed.normalize("NFC").trim() === name.normalize("NFC").trim();
}

/** Whether the last step's red button may be pressed: every owned shop's name typed. A helper, who owns none, may press. */
export function namesTyped(owned: readonly ShopName[], typed: Readonly<Record<string, string>>): boolean {
  return owned.every((shop) => sameName(typed[shop.id] ?? "", shop.name));
}

const ERRORS: Record<DeleteError, Key> = {
  changed: "acct.err.changed",
  name: "acct.err.name",
  running: "acct.err.running",
  incomplete: "acct.err.incomplete",
  offline: "acct.err.offline",
  failed: "acct.err.failed",
  signedOut: "acct.err.signedOut",
};

/** The error a press came to, or null for a deletion. */
export function errorOf(result: AccountDeletion): DeleteError | null {
  switch (result.kind) {
    case "deleted":
      return null;
    case "owned_changed":
      return "changed";
    case "name_mismatch":
      return "name";
    case "running":
      return "running";
    case "incomplete":
      return "incomplete";
    case "signed_out":
      return "signedOut";
    case "offline":
      return "offline";
    case "failed":
      return "failed";
  }
}

const list = (shops: readonly ShopName[]) => shops.map((s) => s.name).join(", ");

function Said({ error }: { error?: DeleteError }) {
  if (!error) return null;
  return (
    <p className="st-del-msg" role="alert" data-testid="delete-error">
      {t(ERRORS[error])}
    </p>
  );
}

/** What goes, what stays, and that it cannot be undone: the same for both steps, so the person reads it before each. */
function WhatGoes({ owned, helping }: { owned: ShopName[]; helping: ShopName[] }) {
  return (
    <>
      <div className="st-gh st-gh0">{t("acct.goes")}</div>
      <ul className="st-del-list" data-testid="delete-goes">
        <li>{t("acct.goesAccount")}</li>
        {owned.map((shop) => (
          <li key={shop.id}>{t("acct.goesShop", { shop: shop.name })}</li>
        ))}
        {helping.map((shop) => (
          <li key={shop.id}>{t("acct.goesHelper", { shop: shop.name })}</li>
        ))}
      </ul>
      <div className="st-gh">{t("acct.stays")}</div>
      <ul className="st-del-list" data-testid="delete-stays">
        <li>{t("acct.staysMac")}</li>
        <li>{t("acct.staysPractice")}</li>
      </ul>
    </>
  );
}

/** The last step, as a form: Enter in a name field presses Delete account, which is never greyed out for an unfinished
 *  name (web interface guidelines: let the press say what is wrong, beside the field, and put the focus there), only while
 *  it runs. An owner's first field takes the focus as the step opens; a helper's step gives it to Keep my account, the
 *  safe answer, as the People page's removal does. */
function Confirm(p: DeleteAccountViewProps & { step: Extract<DeleteStep, { kind: "confirm" }> }) {
  const { owned, step } = p;
  const first = useRef<HTMLInputElement>(null);
  const misnamed = step.error === "name";
  useEffect(() => {
    if (misnamed) first.current?.focus();
  }, [misnamed]);
  const title = owned.length === 0 ? t("acct.confirmHelper") : owned.length === 1 ? t("acct.confirmOwner", { shop: owned[0]!.name }) : t("acct.confirmOwnerMany");
  return (
    <form
      className="st-del-dialog"
      aria-labelledby="delete-title-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        p.onDelete();
      }}
      data-testid="delete-confirm-step"
    >
      <div className="st-del-spec">{t("acct.step2")}</div>
      <h3 id="delete-title-2">{title}</h3>
      <p>{t("acct.lastStep")}</p>
      {owned.length > 0 && <p className="st-del-help">{t("acct.typeHint")}</p>}
      {owned.map((shop, i) => (
        <label key={shop.id} className="st-del-field">
          <span>{t("acct.typeLabel", { shop: shop.name })}</span>
          <input
            ref={i === 0 ? first : undefined}
            type="text"
            className="dev-in"
            value={p.typed[shop.id] ?? ""}
            onChange={(e) => p.onType(shop.id, e.target.value)}
            autoComplete="off"
            autoFocus={i === 0}
            spellCheck={false}
            disabled={step.busy}
            aria-invalid={misnamed && !sameName(p.typed[shop.id] ?? "", shop.name) ? true : undefined}
            data-testid={`delete-name-${i}`}
          />
        </label>
      ))}
      <Said error={step.error} />
      <div className="st-del-acts">
        <button type="submit" className="st-btn danger solid" disabled={step.busy} aria-busy={step.busy || undefined} data-testid="delete-confirm">
          {step.busy ? t("acct.deleting") : t("acct.confirm")}
        </button>
        <button type="button" className="st-btn dark" autoFocus={owned.length === 0} disabled={step.busy} onClick={p.onKeep} data-testid="delete-keep">
          {t("acct.keep")}
        </button>
      </div>
    </form>
  );
}

const APPLE_LINE: Record<AppleEnd, Key> = {
  revoked: "acct.apple.revoked",
  retrying: "acct.apple.retrying",
  no_token: "acct.apple.manual",
  gave_up: "acct.apple.manual",
};

function Done({ step, onRestart }: { step: Extract<DeleteStep, { kind: "done" }>; onRestart: () => void }) {
  return (
    <div className="st-del-done" role="status" data-testid="delete-done">
      <h3>{t("acct.done")}</h3>
      {step.shops.length > 0 && <p>{t("acct.doneShops", { shops: list(step.shops) })}</p>}
      {step.left.length > 0 && <p>{t("acct.doneLeft", { shops: list(step.left) })}</p>}
      {step.apple && <p data-testid="delete-apple">{t(APPLE_LINE[step.apple])}</p>}
      <p>{t("acct.donePractice")}</p>
      <div className="st-del-acts">
        <button type="button" className="st-btn" onClick={onRestart} data-testid="delete-restart">
          {t("acct.restart")}
        </button>
        <span className="st-del-help">{t("acct.restartHint")}</span>
      </div>
    </div>
  );
}

export function DeleteAccountView(p: DeleteAccountViewProps) {
  const { status, step } = p;
  const head = (
    <div className="st-del-head">
      <h2>{t("acct.title")}</h2>
    </div>
  );
  if (step.kind === "done") {
    return (
      <div className="st-page st-del" data-testid="delete-account" data-step="done">
        {head}
        <Done step={step} onRestart={p.onRestart} />
      </div>
    );
  }
  if (status !== "signed_in") {
    return (
      <div className="st-page st-del" data-testid="delete-account" data-step="none">
        {head}
        <p className="st-del-none">{status === "practice" ? t("acct.practiceHint") : status === "loading" ? "" : t("acct.signedOutHint")}</p>
      </div>
    );
  }
  return (
    <div className="st-page st-del" data-testid="delete-account" data-step={step.kind}>
      {head}
      <WhatGoes owned={p.owned} helping={p.helping} />
      {step.kind === "what" ? (
        <div className="st-del-dialog" role="group" aria-labelledby="delete-title-1" data-testid="delete-what-step">
          <div className="st-del-spec">{t("acct.step1")}</div>
          <h3 id="delete-title-1">{t("acct.ask")}</h3>
          <p>{t("acct.undo")}</p>
          <Said error={step.error} />
          <div className="st-del-acts">
            <button type="button" className="st-btn" onClick={p.onContinue} data-testid="delete-continue">
              {t("acct.continue")}
            </button>
            <button type="button" className="st-btn dark" onClick={p.onKeep} data-testid="delete-keep">
              {t("acct.keep")}
            </button>
          </div>
        </div>
      ) : (
        <Confirm {...p} step={step} />
      )}
    </div>
  );
}

/** The account's group in Settings › General: what the row says, and the button that opens the page when there is an
 *  account to delete. */
export function DeleteAccountRow({ status, onOpen }: { status: AccountStatus; onOpen: () => void }) {
  const hint =
    status === "practice" ? t("acct.practiceHint") : status === "signed_out" ? t("acct.signedOutHint") : status === "deleted" ? t("acct.done") : t("acct.deleteHint");
  return (
    <>
      <div className="st-gh">{t("acct.group")}</div>
      <div className="st-grp" data-testid="account-group">
        <div className="st-row" data-testid="account-delete-row" data-status={status}>
          <div className="st-k">
            <b>{t("acct.delete")}</b>
            <span>{hint}</span>
          </div>
          {status === "signed_in" && (
            <div className="st-v">
              <button type="button" className="st-btn danger" onClick={onOpen} data-testid="account-delete-open">
                {t("acct.delete")}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ---- state --------------------------------------------------------------------------------------------------------------

/** What this run deleted, so General's row and the page still say so after the page is left and opened again. */
let deletedThisRun: Extract<DeleteStep, { kind: "done" }> | null = null;

/** Tests: forget what this run deleted. */
export function forgetDeletedThisRun(): void {
  deletedThisRun = null;
}

/** Whose account the running app holds: none in Practice, the started origin's session when Connected. */
function useAccountStatus(): { status: AccountStatus; origin: string | null } {
  const setting = startedRuntime();
  const origin = setting.mode === "connected" && runtimeKind(setting) === "http" ? setting.origin : null;
  const signIn = useSignIn(origin);
  if (deletedThisRun) return { status: "deleted", origin };
  if (!origin) return { status: "practice", origin };
  if (!signIn || signIn.kind === "loading") return { status: "loading", origin };
  return { status: signIn.kind === "signed_in" ? "signed_in" : "signed_out", origin };
}

/** Settings › General's group for the account. */
export function AccountRows() {
  const s = useStore();
  const { status } = useAccountStatus();
  return <DeleteAccountRow status={status} onOpen={() => s.openSettings(DELETE_PAGE)} />;
}

/** The page's id in Settings: reached from General's row, never listed in Settings' own list. */
export const DELETE_PAGE = "account-delete";

export function DeleteAccountPage() {
  const s = useStore();
  const { status, origin } = useAccountStatus();
  const shops = s.shops.list;
  const [owned, setOwned] = useState<ShopName[] | null>(null);
  const shownOwned = owned ?? shops.filter((shop) => shop.role === "owner").map(({ id, name }) => ({ id, name }));
  const helping = shops.filter((shop) => shop.role === "helper").map(({ id, name }) => ({ id, name }));
  const [step, setStep] = useState<DeleteStep>(deletedThisRun ?? { kind: "what" });
  const [typed, setTyped] = useState<Record<string, string>>({});

  const remove = async () => {
    if (!origin || step.kind !== "confirm" || step.busy) return;
    // A name not typed as shown is said beside its field, and nothing is sent.
    if (!namesTyped(shownOwned, typed)) return setStep({ kind: "confirm", busy: false, error: "name" });
    setStep({ kind: "confirm", busy: true });
    const result = await sessionFor(origin).deleteAccount(shownOwned.map((shop) => ({ shop: shop.id, name: typed[shop.id] ?? "" })));
    const error = errorOf(result);
    if (result.kind === "deleted") {
      // Practice from the next start, and the read kept of the shop forgotten with it (runtime/link.ts).
      saveRuntimeChoice(readRuntimeSetting(), { mode: "practice" });
      const done: Extract<DeleteStep, { kind: "done" }> = { kind: "done", shops: result.shops, left: result.left, ...(result.apple ? { apple: result.apple } : {}) };
      deletedThisRun = done;
      setStep(done);
      return;
    }
    if (result.kind === "owned_changed") {
      // The list as the API has it now: read again from step 1, with nothing typed kept.
      setOwned(result.owned);
      setTyped({});
      setStep({ kind: "what", error: "changed" });
      return;
    }
    setStep({ kind: "confirm", busy: false, ...(error ? { error } : {}) });
  };

  return (
    <DeleteAccountView
      status={status}
      owned={shownOwned}
      helping={helping}
      step={step}
      typed={typed}
      onType={(shop, text) => {
        setTyped((was) => ({ ...was, [shop]: text }));
        if (step.kind === "confirm" && step.error === "name") setStep({ kind: "confirm", busy: false });
      }}
      onContinue={() => setStep({ kind: "confirm", busy: false })}
      onKeep={() => {
        setTyped({});
        setStep({ kind: "what" });
        s.openSettings("general");
      }}
      onDelete={() => void remove()}
      onRestart={restartApp}
    />
  );
}
