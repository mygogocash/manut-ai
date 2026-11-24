/// The Content-Security-Policy of the owner's web app's pages, which the pages Worker sets (pages.ts). It lives apart
/// from pages.ts because a Worker's main module may export only its handlers.
///
/// The owner's web app (`/app/`, docs/web-app.md) runs only this origin's scripts: no script written into a page, from
/// another site, or from a string. Its session is in cookies no script can read, and this keeps a script that should not
/// be there from running in the app at all. Styles may be inline (the offline page's own sheet, and the attributes React
/// sets), the brand's fonts come from Google's two hosts, and the app talks to this origin alone. No other page changes:
/// the console and the links' pages keep pages.ts's own, which only keeps them out of frames.
export const APP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
