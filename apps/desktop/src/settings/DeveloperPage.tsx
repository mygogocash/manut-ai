// Settings › Developer: which runtime this computer runs, and signing in to the API when it is Connected.
//
// - Runtime: Practice (the in-process demo team, the default) or Connected (the runtime over apps/api at one
//   origin). The choice is saved on this computer (runtime/setting.ts) and applies at the next start, which the page
//   offers when the saved choice is not the one running.
// - Sign-in: with a code sent by email (EmailSignIn.tsx), or with Apple. Until the app can ask Apple itself
//   (docs/runtime-adapter.md), an identity token and its nonce are pasted here; either way the session then lives in the
//   keychain, never on the page. The API answers "not on yet" to the email way until the owner turns it on. In Practice
//   there is no API, so the email way runs on a pretend code that it says aloud and sends nothing.
//
// `DeveloperView` draws a given state, so the tests draw every one; `DeveloperPage` keeps the form's state and acts.
// The markup is Settings' own row (DevRow.tsx, as Settings.slot.tsx `Row` draws it), so the page looks like the rest of
// Settings.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePlace } from "../palette/places";
import { Modes } from "../ui/Modes";
import { t, type Key } from "../i18n";
import { runtimeKind } from "../runtime";
import { sessionFor } from "../runtime/http";
import { useStore } from "../state/store";
import type { SignInState } from "../runtime/http/session";
import { pendingRestart, restartApp, saveRuntimeChoice, useSignIn } from "../runtime/link";
import { parseOrigin, readRuntimeSetting, type OriginRefusal, type RuntimeSetting } from "../runtime/setting";
import { Row } from "./DevRow";
import { EmailSignIn } from "./EmailSignIn";
import { MakeShop, makeShopOffer } from "./MakeShop";

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
  /** the sign-in by email, drawn above Apple's rows when signed out and alone in Practice (EmailSignIn.tsx); none when absent */
  email?: ReactNode;
  /** Make your shop (MakeShop.tsx), drawn in a group of its own below the sign-in where `makeShopOffer` offers it */
  make?: ReactNode;
}

/** What the top row says under "Not signed in", for either way in: that the API ended the session, that a sign-out could
 *  not reach the API, that the keychain did not keep a session just made, or how to sign in. */
function signedOutHint(state: SignInState, notTold: boolean): string {
  if (state.kind === "signed_out" && state.ended) return t("dev.ended");
  if (notTold) return t("dev.notTold");
  if (state.kind === "signed_out" && state.failure === "keychain") return t("dev.fail.keychain");
  return t("dev.signInLead");
}

/** What Apple's row says: why the last try with an identity token failed, or how to use it. A failure of the keychain is
 *  the top row's, since either way in can meet it. */
function appleHint(state: SignInState): string {
  if (state.kind === "signed_out" && state.failure && state.failure !== "keychain") return t(`dev.fail.${state.failure}` as Key);
  return t("dev.signInHint");
}

/** Who is signed in. An email sign-in's tenant is `email:` and a hash of the address, which says nothing to a person,
 *  so it is not shown; Apple's is shown as it always was. */
function signedInTitle(tenant: string): string {
  return tenant.startsWith("email:") ? t("dev.signedInEmail") : t("dev.signedIn", { tenant });
}

function SignIn(p: DeveloperViewProps & { signIn: SignInState }) {
  const { signIn } = p;
  if (signIn.kind === "loading") return null;
  if (signIn.kind === "no_keychain") return <Row title={t("dev.signedOut")} hint={t("dev.noKeychain")} />;
  if (signIn.kind === "signed_in") {
    return (
      <Row title={signedInTitle(signIn.tenant)}>
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
      {p.email}
      <Row title={t("dev.apple")} hint={appleHint(signIn)} />
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
          <Modes
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
      {/* Practice has no API and no session, so the only sign-in to show is the pretend one by email, to try the screens. */}
      {p.saved.mode === "practice" && p.email && (
        <>
          <div className="st-gh">{t("dev.signInTitle")}</div>
          <div className="st-grp" data-testid="dev-sign">
            {p.email}
          </div>
        </>
      )}
      {p.make && (
        <>
          <div className="st-gh">{t("make.title")}</div>
          <div className="st-grp" data-testid="dev-make">
            {p.make}
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
  const signingIn = signIn?.kind === "signing_in";
  const shops = useStore().shops;
  // Once this page has made a shop it keeps saying so for as long as it shows, though the person is no longer in no shop.
  const [made, setMade] = useState(false);
  const offer = makeShopOffer({ kind: runtimeKind(), saved, restart: pendingRestart(saved), signIn, shops, made });

  // A sign-out that the API was not told of is said until the next sign-in starts, whichever way the person signs in.
  useEffect(() => {
    if (signingIn) setNotTold(false);
  }, [signingIn]);

  // Moving the choice off the shop (to Practice, or to another origin) also forgets the saved read of it.
  const save = (next: RuntimeSetting) => {
    saveRuntimeChoice(saved, next);
    setSaved(next);
  };

  const pick = (next: Mode) => {
    setMode(next);
    setOriginError(null);
    // Practice needs nothing more, so it is saved at once; Connected waits for its origin.
    if (next === "practice") save({ mode: "practice" });
  };
  // The command palette offers the other of Practice and Connected, and presses this segment's own function.
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const place = useMemo(() => ({ mode, set: (m: Mode) => pickRef.current(m) }), [mode]);
  usePlace("runtime", place);

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
      email={<EmailSignIn key={origin ?? "practice"} origin={origin} held={signingIn} />}
      make={offer ? <MakeShop key={origin ?? "practice"} practice={offer === "practice"} onMade={() => setMade(true)} /> : undefined}
      onMode={pick}
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
