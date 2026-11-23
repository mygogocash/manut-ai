import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { getSessions } from "./sessions/sessions";
import { bootResume } from "./app/resumeBoot";
import { startTermLinks } from "./sessions/termLinkOpen";
import { startTermShare } from "./sessions/termShare";
import { resolveTheme } from "./app/theme";
import { readTheme } from "./state/store";
import { learnThisHost } from "./terminal/host";

// The theme is set before <App> mounts, so the first paint is already in the person's theme.
document.documentElement.dataset.theme = resolveTheme(readTheme());

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
// No gate in front of the app: Oh My Hermes waited here for its bridge process (and offered to install Hermes).
// Manut AI's runtime is reached through `src/runtime`, and the default one lives in this page, so there is nothing
// to wait for. A runtime that can be away says so through the store's `conn` state, which the chat already shows.
createRoot(document.getElementById("root")!).render(<App />);
