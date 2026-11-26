// Open a file a chat sent with the system's default app, or show it in Finder / Explorer.
//
// Oh My Hermes' shell did this through an `open_media` command that accepted only a file its bridge process had just
// served, so the page could never name an arbitrary path. Manut AI's shell has no bridge to keep that list, and a
// path the page names by itself must not be opened, so the command was removed and nothing can be opened yet: the
// buttons in Media.tsx do not show. A runtime that serves real files has to bring its own trusted list back before
// this returns true.
import { t } from "../i18n";

export const canOpenFiles = () => false;

export async function openMedia(_path: string, _reveal = false): Promise<void> {
  // nothing may be opened (see above); kept so Media.tsx needs no change when a trusted opener returns
}

export const revealLabel = () =>
  t(typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "md.explorer" : "md.finder");
