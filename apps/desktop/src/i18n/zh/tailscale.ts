import type { tailscale as en } from "../en/tailscale";

export const tailscale: Record<keyof typeof en, string> = {
  "tailscale.missing": "未安装 Tailscale。",
  "tailscale.signedOut": "请打开 Tailscale 并登录。",
  "tailscale.needsHttps": "由你的 tailnet 管理员开启 MagicDNS 和 HTTPS Certificates（在 Tailscale 管理控制台的 DNS 页面）。这会让这台 Mac 的名称永久出现在公开的证书日志中。",
  "tailscale.ready": "已就绪：{name}",
};
