import { createRoot } from "react-dom/client";
import { startMotionDriver } from "./lib/firstPaint";
import { startHiddenMark } from "./app/hidden";
import { App } from "./app/App";
import { getSessions } from "./sessions/sessions";
import { bootResume } from "./app/resumeBoot";
import { startTermLinks } from "./sessions/termLinkOpen";
import { startTermShare } from "./sessions/termShare";
import { startSnapshots } from "./computer/snapshot";
import { resolveTheme } from "./app/theme";
import { readTheme } from "./state/store";
import { learnThisHost } from "./terminal/host";
import { watchPageErrors } from "./report/errors";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { LoadFailed } from "./pages/MenuPage";
import { maskSecrets } from "./lib/secrets";

// The theme is set before <App> mounts, so the first paint is already in the person's theme.
document.documentElement.dataset.theme = resolveTheme(readTheme());

// the page's own uncaught errors, kept in memory for Settings › Report a problem and nowhere else
watchPageErrors();

// A reload keeps the shell (and any agent the last page started) alive: stop those before any UI exists.
void getSessions().reset();
// This computer's name, once, before any terminal starts: OSC 7 from it counts as local in every terminal.
void learnThisHost();
// Then put back what was open before manut last closed (an update restart, a quit, a crash); the sessions that
// continue by themselves start once that reset is done.
bootResume();
// manut://terminal/<id> links opened from outside: the ones waiting, then each new one (after the list is back)
startTermLinks();
// the status files bots holding a terminal link read, and the requests they leave (shown as cards, typed only on Allow)
startTermShare();
// a snapshot of any app (item 104): what the key the person set took opens in a new chat's box, never sent from here
startSnapshots();
// "Reach this Mac from your phone" comes back on only for a person who turned it on after its consent sheet; for everyone
// else this reads one saved choice and does nothing (src/remote/state.ts).
void import("./remote/state").then((m) => m.resumeRemote());
// pages that name their moves (rows arriving once, rows sliding to a new place) are looked after in one place
startMotionDriver();
// a hidden window holds its loops still (item 136)
startHiddenMark();
// No gate in front of the app: Oh My Hermes waited here for its bridge process (and offered to install Hermes).
// Manut AI's runtime is reached through `src/runtime`, and the default one lives in this page, so there is nothing
// to wait for. A runtime that can be away says so through the store's `conn` state, which the chat already shows.
// A render that throws past every part's own boundary shows the page's "did not load" banner instead of a blank window; Try
// again draws the app once more.
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary fallback={(e, retry) => <LoadFailed details={maskSecrets(e.message || e.name)} onRetry={retry} testId="app-failed" />}>
    <App />
  </ErrorBoundary>,
);
