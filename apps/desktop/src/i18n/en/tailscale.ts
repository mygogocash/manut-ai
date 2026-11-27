export const tailscale = {
  // Tailscale (item 78f, docs/remote-access.md, "The second road: Tailscale"): what Settings, Sharing and access will say
  // about Tailscale on this Mac, as src-tauri/src/tailscale.rs reads it (src/remote/tailscale.ts). Nothing shows them yet.
  "tailscale.missing": "Tailscale isn't installed.",
  "tailscale.signedOut": "Open Tailscale and sign in.",
  "tailscale.needsHttps": "An admin of your tailnet turns on MagicDNS and HTTPS Certificates (the DNS page of Tailscale's admin console). This publishes this Mac's name in public certificate logs, for good.",
  "tailscale.ready": "Ready: {name}",
};
