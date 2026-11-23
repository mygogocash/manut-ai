// Settings › Developer, drawn with react-dom/server: Practice or Connected, the API origin, the restart that applies a
// new choice, and signing in to the API in each of its states.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { DeveloperView, type DeveloperViewProps } from "./DeveloperPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};
const CONNECTED = { mode: "connected", origin: "https://dev.manut.xyz" } as const;

function draw(over: Partial<DeveloperViewProps> = {}) {
  setLang("en");
  return renderToString(
    <DeveloperView
      saved={{ mode: "practice" }}
      restart={false}
      mode="practice"
      originText=""
      originError={null}
      signIn={null}
      notTold={false}
      token=""
      nonce=""
      onMode={noop}
      onOriginText={noop}
      onSave={noop}
      onRestart={noop}
      onToken={noop}
      onNonce={noop}
      onSignIn={noop}
      onSignOut={noop}
      {...over}
    />,
  );
}

afterEach(() => setLang("en"));

describe("Settings › Developer", () => {
  it("offers Practice and Connected, Practice chosen by default, and says what each does", () => {
    const html = draw();
    expect(words(html)).toContain("Practice runs a demo team inside the app and never shows real shop data.");
    expect(html).toMatch(/data-testid="dev-runtime"/);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Practice</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Connected</);
    // nothing to sign in to and nothing to restart
    expect(html).not.toContain('data-testid="dev-origin"');
    expect(html).not.toContain('data-testid="dev-sign-in"');
    expect(html).not.toContain('data-testid="dev-restart"');
  });

  it("asks for the API origin once Connected is picked, and says why one is refused", () => {
    const html = draw({ mode: "connected", originText: "https://dev.manut.xyz" });
    expect(html).toMatch(/<input type="url"[^>]*data-testid="dev-origin"[^>]*value="https:\/\/dev.manut.xyz"/);
    expect(html).toMatch(/data-testid="dev-save"[^>]*>Save</);
    expect(words(html)).toContain("Where the API runs, such as https://dev.manut.xyz. Plain http works only for this computer.");
    expect(words(draw({ mode: "connected", originText: "http://dev.manut.xyz", originError: "not_https" }))).toContain(
      "Use https. Plain http works only for this computer (localhost).",
    );
  });

  it("offers a restart when the saved choice is not the one running, and says what a restart stops", () => {
    const html = draw({ saved: CONNECTED, mode: "connected", originText: CONNECTED.origin, restart: true, signIn: { kind: "signed_out" } });
    expect(html).toMatch(/data-testid="dev-restart"[^>]*>Restart to apply</);
    expect(words(html)).toContain("Restarting stops the terminals and coding sessions it runs.");
  });

  it("signs in with an identity token kept out of sight and its nonce", () => {
    const html = draw({ saved: CONNECTED, mode: "connected", originText: CONNECTED.origin, signIn: { kind: "signed_out" } });
    expect(words(html)).toContain("The API signs in with Apple. Until the app can ask Apple itself, paste an identity token and the nonce it was made with.");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*aria-label="Identity token"[^>]*data-testid="dev-token"/);
    expect(html).toMatch(/<input[^>]*type="text"[^>]*aria-label="Nonce"[^>]*data-testid="dev-nonce"/);
    expect(html).toMatch(/<button type="button" class="st-btn" data-testid="dev-sign-in">Sign in<\/button>/);
  });

  it("says why the last sign-in failed, or that the API ended the session", () => {
    const at = (signIn: DeveloperViewProps["signIn"]) => words(draw({ saved: CONNECTED, mode: "connected", originText: CONNECTED.origin, signIn }));
    expect(at({ kind: "signed_out", failure: "invalid_identity" })).toContain("The API did not accept that identity token and nonce.");
    expect(at({ kind: "signed_out", failure: "not_configured" })).toContain("This API has no Sign in with Apple set up.");
    expect(at({ kind: "signed_out", failure: "offline" })).toContain("The API cannot be reached.");
    expect(at({ kind: "signed_out", failure: "keychain" })).toContain("The keychain did not keep the session.");
    expect(at({ kind: "signed_out", ended: "expired" })).toContain("The API ended the session. Sign in again.");
  });

  it("holds the button while signing in", () => {
    const html = draw({ saved: CONNECTED, mode: "connected", originText: CONNECTED.origin, signIn: { kind: "signing_in" } });
    expect(html).toMatch(/<button type="button" class="st-btn" disabled=""[^>]*data-testid="dev-sign-in">Signing in…<\/button>/);
  });

  it("names who is signed in and offers to sign out, with no token field left", () => {
    const html = draw({ saved: CONNECTED, mode: "connected", originText: CONNECTED.origin, signIn: { kind: "signed_in", tenant: "apple:owner-1", signedInAt: 0 } });
    expect(words(html)).toContain("Signed in as apple:owner-1");
    expect(html).toMatch(/data-testid="dev-sign-out"[^>]*>Sign out</);
    expect(html).not.toContain('data-testid="dev-token"');
  });

  it("says when a sign-out could not reach the API", () => {
    const html = draw({ saved: CONNECTED, mode: "connected", originText: CONNECTED.origin, signIn: { kind: "signed_out" }, notTold: true });
    expect(words(html)).toContain("Signed out on this computer. The API could not be told, so the session ends by itself later.");
  });

  it("says plainly when this computer cannot keep a session, and offers no sign-in", () => {
    const html = draw({ saved: CONNECTED, mode: "connected", originText: CONNECTED.origin, signIn: { kind: "no_keychain" } });
    expect(words(html)).toContain("This computer cannot keep a session yet: only the macOS app uses the keychain so far.");
    expect(html).not.toContain('data-testid="dev-token"');
    expect(html).not.toContain('data-testid="dev-sign-in"');
  });

  it("speaks the app's language", () => {
    setLang("ko");
    const html = renderToString(
      <DeveloperView
        saved={{ mode: "practice" }}
        restart={false}
        mode="practice"
        originText=""
        originError={null}
        signIn={null}
        notTold={false}
        token=""
        nonce=""
        onMode={noop}
        onOriginText={noop}
        onSave={noop}
        onRestart={noop}
        onToken={noop}
        onNonce={noop}
        onSignIn={noop}
        onSignOut={noop}
      />,
    );
    expect(words(html)).toContain("연습");
    expect(words(html)).toContain("런타임");
  });
});

describe("Settings › Developer on the app's store", () => {
  // Settings loads every one of its pages' modules, which takes a few seconds on a cold run.
  it("is a page of the App group that Settings opens by name", { timeout: 30_000 }, async () => {
    setLang("en");
    const { getStore } = await import("../state/store");
    const { default: Settings } = await import("./Settings.slot");
    await getStore().actions.init();
    const html = renderToString(<Settings page="developer" onClose={noop} />);
    expect(html).toMatch(/data-testid="settings-nav-developer"[^>]*>Developer</);
    expect(html).toContain('data-testid="settings-page-developer"');
    expect(html).toContain('data-testid="dev-runtime"');
  });
});
