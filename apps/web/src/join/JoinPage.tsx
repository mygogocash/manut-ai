import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, useApiSetup, type JoinAnswer } from "../api";
import { CodeStep, EmailStep } from "../signin/CodeSteps";
import { useCodeSignIn } from "../signin/useCodeSignIn";
import { BrandMark, BrokenLinkIcon, CheckIcon, ClockIcon, CloudOffIcon, PeopleIcon, useColorScheme } from "../ui/marks";
import { Loading, Notice, OWNER_CARD as CARD } from "../ui/owner";
import { visitDeviceId } from "./code";
import { joinStrings, type JoinStrings } from "./strings";

/// The page an invite link opens (`/join/{token}`, docs/people.md, "Invites"). The person signs in with a code sent to
/// their email, the page accepts the invite with that sign-in, and it says what the answer means and what comes next.
///
/// The first screen cannot name the shop: the API names it, and its owner, only to a signed-in accept, and never the
/// account an invite is for. So it says that someone invited the person to help, and asks them to sign in with the
/// address the invite went to.
///
/// What the page holds, it holds in memory for this visit only: the sign-in's access token lives in a ref, never in
/// `localStorage`, `sessionStorage`, a cookie or a URL, and a reload means signing in again. (The owner's app keeps a
/// sign-in that lasts, in cookies the page cannot read, docs/web-app.md; this page needs one for a single accept.) Once
/// the invite has its answer the page has no more use for the sign-in, or for the helper session a join gives, so it
/// ends both at once and forgets them. Signing in is the shared steps' (src/signin), as the owner's app signs in.
///
/// The invite token stays in the page's own path and goes in one place only: the accept's body. The page loads nothing
/// from another origin (App.tsx loads the brand's fonts on every other page) and sends no Referer (index.html and the
/// pages Worker both set `no-referrer`).

/// An answer as the page keeps it: a join without the helper session it carried, which the page ends at once.
type ShownAnswer = Exclude<JoinAnswer, { answer: "joined" }> | Omit<Extract<JoinAnswer, { answer: "joined" }>, "session">;

/// Where the page stands past signing in, which the shared sign-in steps keep (src/signin): signed in as `email`, with the
/// accept on its way or without an answer; signing in by email is off (`email_not_configured`); or the invite's answer.
type Step =
  | { name: "signIn" }
  | { name: "joining"; email: string }
  | { name: "joinError"; email: string }
  | { name: "off" }
  | { name: "answered"; answer: ShownAnswer; email: string };

/// The sign-in this visit made: the address it is for, and the access token the accept is sent with.
type HeldSignIn = { email: string; accessToken: string };

export function JoinPage({ token }: { token: string }) {
  const { api, mode } = useApiSetup();
  const s = joinStrings();
  const scheme = useColorScheme();
  const [step, setStep] = useState<Step>({ name: "signIn" });
  const [deviceId] = useState(visitDeviceId);
  const held = useRef<HeldSignIn | null>(null);
  // The first press wins, as on the sign-in steps: the accept's Try again closes the gap a render leaves.
  const inFlight = useRef(false);
  const flow = useCodeSignIn(s, {
    api,
    exchange: async (address, code) => {
      const session = await api.exchangeEmailCode({ email: address, code, deviceId });
      held.current = { email: address, accessToken: session.accessToken };
    },
    onSignedIn: () => void accept(),
    onOff: () => setStep({ name: "off" }),
  });

  useEffect(() => {
    document.title = s.documentTitle;
  }, [s]);

  // Leaving the page while signed in ends the sign-in: nothing else would ever use it.
  useEffect(
    () => () => {
      const session = held.current;
      held.current = null;
      if (session) void api.signOut(session.accessToken).catch(() => undefined);
    },
    [api],
  );

  async function accept(): Promise<void> {
    const session = held.current;
    if (!session || inFlight.current) return;
    inFlight.current = true;
    setStep({ name: "joining", email: session.email });
    try {
      finish(await api.acceptInvite({ accessToken: session.accessToken, inviteToken: token }), session);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The sign-in ended before the invite was answered (its hour passed, or it was ended elsewhere): forget it.
        held.current = null;
        flow.reset(s.sessionEnded);
        setStep({ name: "signIn" });
      } else {
        setStep({ name: "joinError", email: session.email });
      }
    } finally {
      inFlight.current = false;
    }
  }

  /// The invite has its answer, so the page ends the sign-in, and the helper session a join gave, and forgets both.
  /// Ending is best effort: one that fails leaves a session nobody holds, to run out by itself.
  function finish(answer: JoinAnswer, session: HeldSignIn): void {
    held.current = null;
    void api.signOut(session.accessToken).catch(() => undefined);
    if (answer.answer === "joined") {
      void api.endShopSession(answer.session.accessToken).catch(() => undefined);
      setStep({ name: "answered", answer: { answer: "joined", shop: answer.shop, helper: answer.helper }, email: session.email });
    } else {
      setStep({ name: "answered", answer, email: session.email });
    }
  }

  /// Switch account: whatever sign-in the page still holds is ended and forgotten, and the person signs in again.
  function switchAccount(): void {
    const session = held.current;
    held.current = null;
    if (session) void api.signOut(session.accessToken).catch(() => undefined);
    flow.reset();
    setStep({ name: "signIn" });
  }

  let body: ReactNode;
  switch (step.name) {
    case "signIn":
      body = flow.step.name === "email" ? (
        <EmailStep s={s} flow={flow} title={s.inviteTitle} body={s.inviteBody} titleId="invite-title" idPrefix="join" />
      ) : (
        <CodeStep s={s} flow={flow} practice={mode === "fake"} titleId="code-title" idPrefix="join" />
      );
      break;
    case "joining":
      body = (
        <>
          <SignedIn s={s} email={step.email} />
          <Loading label={s.joining} />
        </>
      );
      break;
    case "joinError":
      body = (
        <>
          <SignedIn s={s} email={step.email} />
          <Notice icon={<CloudOffIcon />} title={s.joinFailedTitle} body={s.joinFailed}>
            <button type="button" className="btn" style={{ minHeight: 44 }} onClick={() => void accept()}>
              {s.tryAgain}
            </button>
          </Notice>
        </>
      );
      break;
    case "off":
      body = <Notice icon={<CloudOffIcon />} title={s.offTitle} body={s.offBody} />;
      break;
    case "answered":
      body = <Answer s={s} answer={step.answer} email={step.email} onSwitch={switchAccount} />;
      break;
  }

  const shopName = step.name === "answered" && "shop" in step.answer ? step.answer.shop.name : null;
  return (
    <div className="r" data-t={scheme} style={{ minHeight: "100vh" }}>
      <main className="col" style={{ maxWidth: 560, padding: "16px 16px 40px", gap: 16 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark />
          <div style={{ minWidth: 0, lineHeight: 1.3 }}>
            <div style={{ fontWeight: 600 }}>{shopName ?? s.brand}</div>
            {shopName && (
              <div className="mut" style={{ fontSize: 12.5 }}>
                {s.brand}
              </div>
            )}
          </div>
        </header>
        <h1 className="vh">{s.documentTitle}</h1>
        {mode === "fake" && (
          <div className="banner info" role="note">
            <span className="grow">{s.practiceMode}</span>
          </div>
        )}
        <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {body}
        </div>
      </main>
    </div>
  );
}

function SignedIn({ s, email }: { s: JoinStrings; email: string }) {
  return (
    <div className="banner ok" role="status">
      <span className="grow">{s.signedInAs(email)}</span>
    </div>
  );
}

function Answer({ s, answer, email, onSwitch }: { s: JoinStrings; answer: ShownAnswer; email: string; onSwitch: () => void }) {
  switch (answer.answer) {
    case "joined":
      return (
        <article className="box pop" style={CARD} aria-labelledby="joined-title">
          <div>
            <span className="tag ok">
              <CheckIcon />
              {s.joinedTag}
            </span>
          </div>
          <h2 className="big" id="joined-title">
            {s.joinedTitle(answer.shop.name)}
          </h2>
          <p style={{ margin: 0 }}>{s.joinedBody(answer.shop.ownerName)}</p>
          <h3 style={{ margin: "4px 0 0", fontSize: 15, fontWeight: 600 }}>{s.nextTitle}</h3>
          <p style={{ margin: 0 }}>{s.nextBody(email, answer.shop.name)}</p>
          <p className="hint" style={{ margin: 0 }}>
            {s.joinedHint}
          </p>
        </article>
      );
    case "wrong_account": {
      const line = answer.invitedOn === "line";
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="banner warn" role="alert">
            <span className="grow">
              {line ? s.wrongLineTitle(answer.shop.name, email) : s.wrongEmailTitle(answer.shop.name, email)}
            </span>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {line ? s.wrongLineHint(answer.shop.ownerName) : s.wrongEmailHint(answer.shop.ownerName)}
          </p>
          <div>
            <button type="button" className="btn" style={{ minHeight: 44 }} onClick={onSwitch}>
              {s.switchAccount}
            </button>
          </div>
        </div>
      );
    }
    case "expired":
      return <Notice icon={<ClockIcon />} title={s.expiredTitle} body={s.expiredBody} />;
    case "revoked":
      return <Notice icon={<BrokenLinkIcon />} title={s.revokedTitle} body={s.revokedBody} />;
    case "already_used":
      return <Notice icon={<PeopleIcon />} title={s.usedTitle} body={s.usedBody} />;
    case "unknown":
      return <Notice icon={<BrokenLinkIcon />} title={s.unknownTitle} body={s.unknownBody} />;
  }
}
