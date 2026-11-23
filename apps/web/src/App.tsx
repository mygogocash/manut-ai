import { useMemo } from "react";
import { ApiProvider, createApi, type ApiSetup } from "./api";
import { DEMO_TOKENS } from "./api/fake";
import { ApprovePage } from "./approve/ApprovePage";
import { OpsConsole } from "./ops/OpsConsole";
import { Link, matchRoute, usePathname } from "./router";
import { BrandMark, useColorScheme } from "./ui/marks";

export function App({ setup }: { setup?: ApiSetup }) {
  const api = useMemo(() => setup ?? createApi(), [setup]);
  const route = matchRoute(usePathname());
  return (
    <ApiProvider value={api}>
      {route.name === "approve" ? (
        <ApprovePage key={route.token} token={route.token} />
      ) : route.name === "ops" ? (
        <OpsConsole />
      ) : (
        <Home setup={api} notFound={route.name === "notFound"} />
      )}
    </ApiProvider>
  );
}

const DEMO_LINKS: { token: string; label: string }[] = [
  { token: DEMO_TOKENS.waiting, label: "Waiting for you, with the one-time permission step" },
  { token: DEMO_TOKENS.failed, label: "Approve, then the send fails" },
  { token: DEMO_TOKENS.unknown, label: "Approve, then nobody can tell if it was sent" },
  { token: DEMO_TOKENS.sent, label: "Already sent" },
  { token: DEMO_TOKENS.declined, label: "Already declined" },
  { token: DEMO_TOKENS.expiredRequest, label: "Nobody answered in time" },
  { token: DEMO_TOKENS.expiredLink, label: "Link expired" },
  { token: "not-a-real-link", label: "Link that does not work" },
];

/// What anyone who lands outside a link sees. In practice mode it also lists a link for every state of the
/// owner's page, and the console.
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
              {DEMO_LINKS.map((demo) => (
                <li key={demo.token}>
                  <Link className="lk" href={`/approve/${demo.token}`}>
                    {demo.label}
                  </Link>
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
