/// The Content-Security-Policies of the web app's pages, which the pages Worker sets (pages.ts). They live apart from
/// pages.ts because a Worker's main module may export only its handlers.
///
/// Every page is one origin with the API, so any script that runs on any of them can use what that origin holds while it
/// runs: the owner's web app's cookies, and the operator key the console keeps in `sessionStorage`, on pages that show
/// what customers wrote. So every page runs only this origin's scripts: no script written into a page, from another
/// site, or from a string, and no page can be framed (docs/decisions.md, 24 Nov 2026). Styles may be inline (the
/// attributes React sets, and the offline page's own sheet), and each page talks to this origin alone. Three policies,
/// by what each page loads, each in the same order:
///
/// - `APP_POLICY`, the owner's web app (`/app/`, docs/web-app.md): the brand's fonts from Google's two hosts, and its
///   manifest and service worker from this origin.
/// - `PAGE_POLICY`, every other page but one: the operator console at `/ops`, the owner's approval and deletion pages
///   (`/approve/`, `/delete/`), the practice home and the rest of apps/web's one page, with the brand's fonts.
/// - `JOIN_POLICY`, the page an invite link opens (`/join/`): nothing from any other origin, fonts included, since its
///   path carries the invite's token (src/fonts.ts in apps/web).

function policy(page: { fonts: boolean; app: boolean }): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    page.fonts ? "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" : "style-src 'self' 'unsafe-inline'",
    page.fonts ? "font-src 'self' https://fonts.gstatic.com" : "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    ...(page.app ? ["manifest-src 'self'", "worker-src 'self'"] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const APP_POLICY = policy({ fonts: true, app: true });

export const PAGE_POLICY = policy({ fonts: true, app: false });

export const JOIN_POLICY = policy({ fonts: false, app: false });
