import { useEffect, useMemo } from "react";
import { ApiProvider, createApi, type ApiSetup } from "./api";
import { APP_SIGN_IN_OFF, DEMO_DELETION_TOKENS, DEMO_JOIN_TOKENS, DEMO_TOKENS, PRACTICE_OWNER_CODES } from "./api/fake";
import { OwnerApp } from "./app/OwnerApp";
import { ApprovePage } from "./approve/ApprovePage";
import { DeletePage } from "./delete/DeletePage";
import { loadBrandFonts } from "./fonts";
import { JoinPage } from "./join/JoinPage";
import { OpsConsole } from "./ops/OpsConsole";
import { Link, matchRoute, usePathname } from "./router";
import { BrandMark, useColorScheme } from "./ui/marks";

export function App({ setup }: { setup?: ApiSetup }) {
  const api = useMemo(() => setup ?? createApi(), [setup]);
  const route = matchRoute(usePathname());
  // The join page asks no other origin for anything, its fonts included (fonts.ts); every other page has the brand's.
  const joining = route.name === "join";
  useEffect(() => {
    if (!joining) loadBrandFonts();
  }, [joining]);
  return (
    <ApiProvider value={api}>
      {route.name === "approve" ? (
        <ApprovePage key={route.token} token={route.token} />
      ) : route.name === "delete" ? (
        <DeletePage key={route.token} token={route.token} />
      ) : route.name === "join" ? (
        <JoinPage key={route.token} token={route.token} />
      ) : route.name === "ops" ? (
        <OpsConsole />
      ) : route.name === "app" ? (
        <OwnerApp />
      ) : (
        <Home setup={api} notFound={route.name === "notFound"} />
      )}
    </ApiProvider>
  );
}

const DEMO_LINKS: { href: string; label: string }[] = [
  { href: `/approve/${DEMO_TOKENS.waiting}`, label: "Waiting for you, with the one-time permission step" },
  { href: `/approve/${DEMO_TOKENS.failed}`, label: "Approve, then the send fails" },
  { href: `/approve/${DEMO_TOKENS.unknown}`, label: "Approve, then nobody can tell if it was sent" },
  { href: `/approve/${DEMO_TOKENS.sent}`, label: "Already sent" },
  { href: `/approve/${DEMO_TOKENS.declined}`, label: "Already declined" },
  { href: `/approve/${DEMO_TOKENS.expiredRequest}`, label: "Nobody answered in time" },
  { href: `/approve/${DEMO_TOKENS.expiredLink}`, label: "Link expired" },
  { href: "/approve/not-a-real-link", label: "Link that does not work" },
  { href: `/delete/${DEMO_DELETION_TOKENS.waiting}`, label: "Delete a shop's data: waiting for you" },
  { href: `/delete/${DEMO_DELETION_TOKENS.deleting}`, label: "Delete a shop's data: being deleted" },
  { href: `/delete/${DEMO_DELETION_TOKENS.deleted}`, label: "Delete a shop's data: already deleted" },
  { href: `/delete/${DEMO_DELETION_TOKENS.kept}`, label: "Delete a shop's data: data kept" },
  { href: `/delete/${DEMO_DELETION_TOKENS.unanswered}`, label: "Delete a shop's data: nobody answered in time" },
  { href: `/delete/${DEMO_DELETION_TOKENS.expiredLink}`, label: "Delete a shop's data: link expired" },
  { href: `/join/${DEMO_JOIN_TOKENS.joined}`, label: "Join a shop: the invite works" },
  { href: `/join/${DEMO_JOIN_TOKENS.wrongEmail}`, label: "Join a shop: the invite is for another email" },
  { href: `/join/${DEMO_JOIN_TOKENS.wrongLine}`, label: "Join a shop: the invite is for a LINE account" },
  { href: `/join/${DEMO_JOIN_TOKENS.expired}`, label: "Join a shop: invite expired" },
  { href: `/join/${DEMO_JOIN_TOKENS.used}`, label: "Join a shop: invite already used" },
  { href: `/join/${DEMO_JOIN_TOKENS.revoked}`, label: "Join a shop: invite cancelled" },
  { href: "/join/not-a-real-invite", label: "Join a shop: invite link that does not work" },
  { href: `/join/${DEMO_JOIN_TOKENS.signInOff}`, label: "Join a shop: signing in by email is off" },
];

/// The codes an owner's app might show, for linking an owner's account on a shop's People page in practice mode: what each one does.
const DEMO_CODES: { code: string; what: string }[] = [
  { code: PRACTICE_OWNER_CODES.dao, what: "Dao's account. It links Sabai Tea." },
  { code: PRACTICE_OWNER_CODES.fon, what: "Fon's account, which Baan Mali already has. Nothing changes." },
  { code: PRACTICE_OWNER_CODES.guest, what: "another account. It links a shop with no account, and is refused for one that has one." },
  { code: PRACTICE_OWNER_CODES.ranOut, what: "a code that has run out." },
];

/// What anyone who lands outside a link sees. In practice mode it also lists a link for every state of the
/// owner's page, the console, and the codes that link an owner's account.
function Home({ setup, notFound }: { setup: ApiSetup; notFound: boolean }) {
  const scheme = useColorScheme();
  return (
    <div className="r" data-t={scheme} style={{ minHeight: "100vh" }}>
      <main className="col" style={{ maxWidth: 560, padding: "24px 16px 40px" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark />
          <span style={{ fontWeight: 600 }}>Manut AI</span>
        </header>
        <h1 className="big">{notFound ? "This page does not exist" : "Manut AI pilot"}</h1>
        <p style={{ margin: 0 }}>To answer a request, open the link from your LINE message.</p>
        {setup.mode === "fake" && (
          <section className="box" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 className="h2">Practice mode</h2>
            <p className="hint" style={{ margin: 0 }}>
              No API is set (VITE_API_ORIGIN), so the pages run on sample data kept in this browser.
            </p>
            <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
              <li>
                <Link className="lk" href="/ops">
                  Operator console
                </Link>
              </li>
              {/* The owner's app is a page of its own (app/index.html), so these are plain links that load it. */}
              <li>
                <a className="lk" href="/app/">
                  The owner's app: sign in with any email and the code it shows
                </a>
              </li>
              <li>
                <a className="lk" href={`/app/?${APP_SIGN_IN_OFF}`}>
                  The owner's app: signing in by email is off
                </a>
              </li>
              {DEMO_LINKS.map((demo) => (
                <li key={demo.href}>
                  <Link className="lk" href={demo.href}>
                    {demo.label}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="hint" style={{ margin: 0 }}>
              A join page sends no email in practice: it shows the code to type once you ask for one. An invite link from a
              shop's People page works there too, for the email it names.
            </p>
            <h3 className="h2">Owner link codes</h3>
            <p className="hint" style={{ margin: 0 }}>
              On a shop's People page in the console, type one of these to link an owner's account. Each code works once, and is
              used up the first time it is tried.
            </p>
            <ul aria-label="Link codes for a shop's People page"
              style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
              {DEMO_CODES.map((demo) => (
                <li key={demo.code}>
                  <code>{demo.code}</code>: {demo.what}
                </li>
              ))}
            </ul>
            {setup.reset && (
              <div>
                <button type="button" className="btn" onClick={() => setup.reset?.()}>
                  Reset the sample data
                </button>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
