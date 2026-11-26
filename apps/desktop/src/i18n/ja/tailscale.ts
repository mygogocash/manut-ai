import type { tailscale as en } from "../en/tailscale";

export const tailscale: Record<keyof typeof en, string> = {
  "tailscale.missing": "Tailscale がインストールされていません。",
  "tailscale.signedOut": "Tailscale を開いてサインインしてください。",
  "tailscale.needsHttps": "tailnet の管理者が MagicDNS と HTTPS Certificates をオンにします（Tailscale の管理コンソールの DNS ページ）。これで、この Mac の名前が公開の証明書ログに載り、消えることはありません。",
  "tailscale.ready": "準備完了: {name}",
};
