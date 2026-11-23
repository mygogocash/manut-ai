// Settings › Developer: which runtime this computer runs, and signing in to the API when it is Connected.
//
// - Runtime: Practice (the in-process demo team, the default) or Connected (the read-only runtime over apps/api at one
//   origin). The choice is saved on this computer (runtime/setting.ts) and applies at the next start, which the page
//   offers when the saved choice is not the one running.
// - Sign-in: the lifted backend signs in with Apple only. Until the app can ask Apple itself (docs/runtime-adapter.md),
//   an identity token and its nonce are pasted here; the session then lives in the keychain, never on the page.
//
// `DeveloperView` draws a given state, so the tests draw every one; `DeveloperPage` keeps the form's state and acts.
// The markup is Settings' own row (Settings.slot.tsx `Row`), so the page looks like the rest of Settings.
import { useState } from "react";
import { Seg } from "../chat/model/Seg";
import { t, type Key } from "../i18n";
import { sessionFor } from "../runtime/http";
import type { SignInState } from "../runtime/http/session";
import { pendingRestart, restartApp, saveRuntimeChoice, useSignIn } from "../runtime/link";
import { parseOrigin, readRuntimeSetting, type OriginRefusal, type RuntimeSetting } from "../runtime/setting";

type Mode = RuntimeSetting["mode"];

export interface DeveloperViewProps {
  /** the choice saved on this computer, which the next start runs */
  saved: RuntimeSetting;
  /** the saved choice is not the one this page started with */
  restart: boolean;
  /** the segment shown: Connected can be picked before its origin is saved */
  mode: Mode;
  originText: string;
  originError: OriginRefusal | null;
  /** the saved origin's session; null in Practice */
  signIn: SignInState | null;
  /** the last sign-out could not reach the API */
  notTold: boolean;
  token: string;
  nonce: string;
  onMode: (mode: Mode) => void;
  onOriginText: (text: string) => void;
  onSave: () => void;
  onRestart: () => void;
  onToken: (text: string) => void;
  onNonce: (text: string) => void;
  onSignIn: () => void;
  onSignOut: () => void;
}

/** One row as Settings draws it: what it is on the left, what to do on the right. */
function Row({ title, hint, children }: { title?: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-k">
        {title && <b>{title}</b>}
        {hint && <span>{hint}</span>}
      </div>
      {children !== undefined && <div className="st-v">{children}</div>}
    </div>
  );
}

/** What the sign-in row says under "Not signed in": why the last try failed, that the API ended the session, that a
 *  sign-out could not reach the API, or how to sign in. */
function signedOutHint(state: SignInState, notTold: boolean): string {
  if (state.kind === "signed_out" && state.failure) return t(`dev.fail.${state.failure}` as Key);
  if (state.kind === "signed_out" && state.ended) return t("dev.ended");
  if (notTold) return t("dev.notTold");
  return t("dev.signInHint");
}

function SignIn(p: DeveloperViewProps & { signIn: SignInState }) {
  const { signIn } = p;
  if (signIn.kind === "loading") return null;
  if (signIn.kind === "no_keychain") return <Row title={t("dev.signedOut")} hint={t("dev.noKeychain")} />;
  if (signIn.kind === "signed_in") {
    return (
      <Row title={t("dev.signedIn", { tenant: signIn.tenant })}>
        <button type="button" className="st-btn" onClick={p.onSignOut} data-testid="dev-sign-out">
          {t("dev.signOut")}
        </button>
      </Row>
    );
  }
  const busy = signIn.kind === "signing_in";
  return (
    <>
      <Row title={t("dev.signedOut")} hint={signedOutHint(signIn, p.notTold)} />
      <Row title={t("dev.token")}>
        {/* A password field, so the token is not on the screen for anyone looking over a shoulder. */}
        <input
          type="password"
          className="dev-in"
          value={p.token}
          onChange={(e) => p.onToken(e.target.value)}
          aria-label={t("dev.token")}
          autoComplete="off"
          spellCheck={false}
          data-testid="dev-token"
        />
      </Row>
      <Row title={t("dev.nonce")}>
        <input
          type="text"
          className="dev-in"
          value={p.nonce}
          onChange={(e) => p.onNonce(e.target.value)}
          aria-label={t("dev.nonce")}
          autoComplete="off"
          spellCheck={false}
          data-testid="dev-nonce"
        />
      </Row>
      <Row>
        <button type="button" className="st-btn" disabled={busy} onClick={p.onSignIn} data-testid="dev-sign-in">
          {busy ? t("dev.signingIn") : t("dev.signIn")}
        </button>
      </Row>
    </>
  );
}

export function DeveloperView(p: DeveloperViewProps) {
  return (
    <div className="st-page">
      <div className="st-gh st-gh0">{t("dev.runtime")}</div>
      <div className="st-grp">
        <Row title={t("dev.runtime")} hint={t("dev.runtimeHint")}>
          <Seg
            small
            label={t("dev.runtime")}
            value={p.mode}
            options={[
              { value: "practice", label: t("dev.practice") },
              { value: "connected", label: t("dev.connected") },
            ]}
            onChange={(v) => p.onMode(v as Mode)}
            testId="dev-runtime"
          />
        </Row>
        {p.mode === "connected" && (
          <Row title={t("dev.origin")} hint={p.originError ? t(`dev.originBad.${p.originError}` as Key) : t("dev.originHint")}>
            <span className="st-pair">
              <input
                type="url"
                className="dev-in"
                value={p.originText}
                onChange={(e) => p.onOriginText(e.target.value)}
                aria-label={t("dev.origin")}
                autoComplete="off"
                spellCheck={false}
                data-testid="dev-origin"
              />
              <button type="button" className="st-btn" onClick={p.onSave} data-testid="dev-save">
                {t("dev.save")}
              </button>
            </span>
          </Row>
        )}
        {p.restart && (
          <Row hint={t("dev.restartHint")}>
            <button type="button" className="st-btn" onClick={p.onRestart} data-testid="dev-restart">
              {t("dev.restart")}
            </button>
          </Row>
        )}
      </div>
      {p.saved.mode === "connected" && p.signIn && (
        <>
          <div className="st-gh">{t("dev.signInTitle")}</div>
          <div className="st-grp" data-testid="dev-sign">
            <SignIn {...p} signIn={p.signIn} />
          </div>
        </>
      )}
    </div>
  );
}

export function DeveloperPage() {
  const [saved, setSaved] = useState<RuntimeSetting>(() => readRuntimeSetting());
  const [mode, setMode] = useState<Mode>(saved.mode);
  const [originText, setOriginText] = useState(saved.mode === "connected" ? saved.origin : "");
  const [originError, setOriginError] = useState<OriginRefusal | null>(null);
  const [token, setToken] = useState("");
  const [nonce, setNonce] = useState("");
  const [notTold, setNotTold] = useState(false);
  const origin = saved.mode === "connected" ? saved.origin : null;
  const signIn = useSignIn(origin);

  // Moving the choice off the shop (to Practice, or to another origin) also forgets the saved read of it.
  const save = (next: RuntimeSetting) => {
    saveRuntimeChoice(saved, next);
    setSaved(next);
  };

  return (
    <DeveloperView
      saved={saved}
      restart={pendingRestart(saved)}
      mode={mode}
      originText={originText}
      originError={originError}
      signIn={signIn}
      notTold={notTold}
      token={token}
      nonce={nonce}
      onMode={(next) => {
        setMode(next);
        setOriginError(null);
        // Practice needs nothing more, so it is saved at once; Connected waits for its origin.
        if (next === "practice") save({ mode: "practice" });
      }}
      onOriginText={setOriginText}
      onSave={() => {
        const parsed = parseOrigin(originText);
        if (!parsed.ok) return setOriginError(parsed.reason);
        setOriginError(null);
        setOriginText(parsed.origin);
        save({ mode: "connected", origin: parsed.origin });
      }}
      onRestart={restartApp}
      onToken={setToken}
      onNonce={setNonce}
      onSignIn={() => {
        if (!origin) return;
        setNotTold(false);
        void sessionFor(origin)
          .signIn(token, nonce)
          .then((state) => {
            // The token is spent once the API took it, so it leaves the page; a refused one stays to be corrected.
            if (state.kind === "signed_in") {
              setToken("");
              setNonce("");
            }
          });
      }}
      onSignOut={() => {
        if (!origin) return;
        void sessionFor(origin)
          .signOut()
          .then(({ revoked }) => setNotTold(!revoked));
      }}
    />
  );
}
