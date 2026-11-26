// Settings › General › Delete account (item 124), drawn with react-dom/server in every state: the account's row with no
// account (Practice, signed out), with one, and after it was deleted; the page's first step, which says what goes and what
// stays; its second step for an owner, whose red button waits for the shop's name, and for a helper, who presses the red
// Delete; each error; and the line that says it is done, with what became of the Sign in with Apple link.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import {
  DeleteAccountRow,
  DeleteAccountView,
  errorOf,
  namesTyped,
  sameName,
  type DeleteAccountViewProps,
  type DeleteError,
} from "./DeleteAccount";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};
const SHOP = { id: "pilot:a", name: "Baan Mali" };
const HELPED = { id: "pilot:b", name: "Khao Hom" };

function view(over: Partial<DeleteAccountViewProps>): string {
  return renderToString(
    <DeleteAccountView status="signed_in" owned={[SHOP]} helping={[]} step={{ kind: "what" }} typed={{}} onType={noop} onContinue={noop}
      onKeep={noop} onDelete={noop} onRestart={noop} {...over} />,
  );
}

/** The red button of the last step, as drawn. */
const confirmButton = (html: string) => /<button[^>]*data-testid="delete-confirm"[^>]*>/.exec(html)?.[0] ?? "";

describe("the account's row in Settings › General", () => {
  afterEach(() => setLang("en"));

  it("in Practice says there is no account to delete, and offers nothing", () => {
    const html = renderToString(<DeleteAccountRow status="practice" onOpen={noop} />);
    expect(words(html)).toBe("Account Delete account There is no account to delete. Practice mode keeps everything on this Mac.");
    expect(html).not.toContain("<button");
  });

  it("signed out says there is no account here, and offers nothing", () => {
    const html = renderToString(<DeleteAccountRow status="signed_out" onOpen={noop} />);
    expect(words(html)).toContain("You are not signed in, so there is no account here to delete.");
    expect(html).not.toContain("<button");
  });

  it("signed in offers Delete account in the danger style, and nothing else", () => {
    const html = renderToString(<DeleteAccountRow status="signed_in" onOpen={noop} />);
    expect(words(html)).toBe("Account Delete account Deletes your Manut AI account. It says what goes first, and asks you twice. Delete account");
    expect(html).toMatch(/<button type="button" class="st-btn danger" data-testid="account-delete-open">Delete account<\/button>/);
  });

  it("after a deletion says it is done", () => {
    const html = renderToString(<DeleteAccountRow status="deleted" onOpen={noop} />);
    expect(words(html)).toContain("Your account is deleted.");
    expect(html).not.toContain("<button");
  });
});

describe("the page", () => {
  afterEach(() => setLang("en"));

  it("with no account says so, and asks nothing", () => {
    expect(words(view({ status: "practice" }))).toBe(
      "Delete your account There is no account to delete. Practice mode keeps everything on this Mac.");
    expect(view({ status: "signed_out" })).not.toContain("<button");
  });

  it("step 1, for an owner, says exactly what goes, what stays, and that it cannot be undone", () => {
    const text = words(view({ helping: [HELPED] }));
    expect(text).toBe(
      "Delete your account What goes Your Manut AI account, and your sign-in on every device. Baan Mali, the shop you own: its " +
        "customers' messages, the replies, the payments, the LINE connection, the team and what it remembers, and your helpers' " +
        "access. Your access to Khao Hom as a helper. The shop and everything in it stay with its owner. What stays Nothing on " +
        "this Mac is touched: your coding agents, your files and git stay as they are. Practice mode is unaffected. Step 1 of 2 " +
        "Delete your account? This cannot be undone. Continue Keep my account");
    // The one black button keeps the account; Continue is the quiet one; nothing is red yet.
    const html = view({});
    expect(html).toMatch(/class="st-btn" data-testid="delete-continue">Continue/);
    expect(html).toMatch(/class="st-btn dark" data-testid="delete-keep">Keep my account/);
    expect(html).not.toContain("danger");
  });

  it("step 1, for a helper, names only their account and their access", () => {
    const text = words(view({ owned: [], helping: [HELPED] }));
    expect(text).toContain("Your Manut AI account, and your sign-in on every device. Your access to Khao Hom as a helper.");
    expect(text).not.toContain("payments");
  });

  it("step 2, for an owner, asks for the shop's name in a labelled field, and the red button submits the form", () => {
    const empty = view({ step: { kind: "confirm", busy: false } });
    expect(words(empty)).toContain("Step 2 of 2 Delete Baan Mali and your account for good? This is the last step. You will be " +
      "signed out, and nothing can be brought back. To confirm, type the shop's name exactly as it is shown. Type Baan Mali");
    expect(empty).toMatch(/^<form class="st-del-dialog"|<form class="st-del-dialog"/);
    expect(confirmButton(empty)).toContain('type="submit"');
    expect(confirmButton(empty)).toContain('class="st-btn danger solid"');
    // Never greyed out for a name not typed yet: pressing says what is wrong beside the field (the page checks it first).
    expect(confirmButton(empty)).not.toContain("disabled");
    expect(empty).toMatch(/<label class="st-del-field"><span>Type Baan Mali<\/span><input[^>]*autoComplete="off"|<label class="st-del-field"><span>Type Baan Mali<\/span><input[^>]*autocomplete="off"/);
    expect(empty).toContain('data-testid="delete-name-0"');
  });

  it("step 2, for an owner of several shops, asks for each name", () => {
    const html = view({ owned: [SHOP, { id: "pilot:c", name: "Second" }], step: { kind: "confirm", busy: false }, typed: { "pilot:a": "Baan Mali" } });
    expect(words(html)).toContain("Delete your shops and your account for good?");
    expect(html).toContain('data-testid="delete-name-1"');
    // A wrong name marks only the field that is wrong.
    const wrong = view({ owned: [SHOP, { id: "pilot:c", name: "Second" }], step: { kind: "confirm", busy: false, error: "name" }, typed: { "pilot:a": "Baan Mali" } });
    expect(/<input[^>]*data-testid="delete-name-0"[^>]*>/.exec(wrong)?.[0]).not.toContain("aria-invalid");
    expect(/<input[^>]*aria-invalid="true"[^>]*>/.exec(wrong)?.[0]).toContain('data-testid="delete-name-1"');
  });

  it("step 2, for a helper, is the red Delete with nothing to type, and the focus on Keep my account", () => {
    const html = view({ owned: [], helping: [HELPED], step: { kind: "confirm", busy: false } });
    expect(words(html)).toContain("Delete your account for good?");
    expect(html).not.toContain("delete-name-");
    expect(confirmButton(html)).not.toContain("disabled");
  });

  it("while it runs, says so and takes no second press", () => {
    const html = view({ step: { kind: "confirm", busy: true }, typed: { "pilot:a": "Baan Mali" } });
    expect(confirmButton(html)).toContain("disabled");
    expect(confirmButton(html)).toContain('aria-busy="true"');
    expect(words(html)).toContain("Deleting…");
  });

  it("says each error in its own words, where it happened", () => {
    const said: Record<DeleteError, string> = {
      changed: "Your shops changed since this page opened. Read the list again, then continue.",
      name: "That is not the shop's name. Type it exactly as it is shown above. Nothing was deleted.",
      running: "A deletion is already running. Wait a minute, then try again.",
      incomplete: "Deleting did not finish. Press Delete account again to finish it.",
      offline: "No answer came back. If deleting started, pressing again finishes it.",
      failed: "Your account could not be deleted just now. Nothing was deleted. Try again in a moment.",
      signedOut: "You were signed out. Sign in again to delete your account.",
    };
    for (const [error, text] of Object.entries(said) as [DeleteError, string][]) {
      const html = view({ step: { kind: "confirm", busy: false, error } });
      expect(html).toMatch(/role="alert" data-testid="delete-error"/);
      expect(words(html)).toContain(text);
    }
    expect(view({ step: { kind: "confirm", busy: false, error: "name" } })).toContain('aria-invalid="true"');
    expect(view({ step: { kind: "confirm", busy: false, error: "name" }, typed: { "pilot:a": "Baan Mali" } })).not.toContain("aria-invalid");
    expect(words(view({ step: { kind: "what", error: "changed" } }))).toContain("Your shops changed since this page opened.");
  });

  it("when it is done, says so, what went, what became of Apple's link, and that Practice comes back at the next start", () => {
    const text = words(view({ step: { kind: "done", shops: [SHOP], left: [HELPED], apple: "revoked" } }));
    expect(text).toBe("Delete your account Your account is deleted. Deleted with it: Baan Mali. You no longer help at Khao Hom. " +
      "Sign in with Apple no longer lets Manut AI in. This Mac goes back to Practice mode at the next start. Restart now " +
      "Restarting stops terminals and coding sessions.");
    expect(words(view({ step: { kind: "done", shops: [], left: [], apple: "retrying" } })))
      .toContain("Apple has not confirmed yet. Manut AI keeps asking it to end Sign in with Apple for Manut AI.");
    for (const apple of ["no_token", "gave_up"] as const) {
      expect(words(view({ step: { kind: "done", shops: [], left: [], apple } })))
        .toContain("open Sign in with Apple in your Apple Account settings and stop using it with Manut AI.");
    }
    // An account signed in by email has no Apple line, and the done line shows whatever the status reads now.
    const email = view({ status: "signed_out", step: { kind: "done", shops: [], left: [] } });
    expect(email).not.toContain("delete-apple");
    expect(words(email)).toContain("Your account is deleted.");
  });

  it("reads in every language with nothing left in English but the names", () => {
    for (const lang of ["ja", "ko", "zh"] as const) {
      setLang(lang);
      const text = words(view({ helping: [HELPED] })) + words(view({ step: { kind: "confirm", busy: false } }));
      for (const english of ["What goes", "What stays", "Continue", "Keep my account", "cannot be undone", "Type Baan"]) {
        expect(text, `${lang}: ${english}`).not.toContain(english);
      }
    }
  });
});

describe("the rules the page keeps", () => {
  it("reads a typed name as the API does: outer spaces and how an accent was typed do not count", () => {
    expect(sameName("  Baan Mali ", "Baan Mali")).toBe(true);
    expect(sameName("Café", "Café")).toBe(true);
    expect(sameName("baan mali", "Baan Mali")).toBe(false);
    expect(namesTyped([], {})).toBe(true);
    expect(namesTyped([SHOP], { "pilot:a": "Baan Mali" })).toBe(true);
    expect(namesTyped([SHOP], {})).toBe(false);
  });

  it("maps each answer to the page's words, and a deletion to none", () => {
    expect(errorOf({ kind: "deleted", shops: [], left: [] })).toBeNull();
    expect(errorOf({ kind: "owned_changed", owned: [] })).toBe("changed");
    expect(errorOf({ kind: "name_mismatch", shop: "pilot:a" })).toBe("name");
    expect(errorOf({ kind: "running" })).toBe("running");
    expect(errorOf({ kind: "incomplete" })).toBe("incomplete");
    expect(errorOf({ kind: "signed_out" })).toBe("signedOut");
    expect(errorOf({ kind: "offline" })).toBe("offline");
    expect(errorOf({ kind: "failed" })).toBe("failed");
  });
});
