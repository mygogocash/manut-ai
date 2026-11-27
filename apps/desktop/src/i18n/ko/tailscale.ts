import type { tailscale as en } from "../en/tailscale";

export const tailscale: Record<keyof typeof en, string> = {
  "tailscale.missing": "Tailscale이 설치돼 있지 않아요.",
  "tailscale.signedOut": "Tailscale을 열고 로그인하세요.",
  "tailscale.needsHttps": "tailnet 관리자가 MagicDNS와 HTTPS Certificates를 켜요(Tailscale 관리 콘솔의 DNS 페이지). 그러면 이 Mac의 이름이 공개 인증서 기록에 올라가고, 영구히 남아요.",
  "tailscale.ready": "준비됨: {name}",
};
