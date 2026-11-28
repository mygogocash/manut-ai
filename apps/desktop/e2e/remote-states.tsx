// Settings › Sharing and access (src/settings/RemotePage.tsx) drawn in one of its states, on the app's own theme and
// Settings stylesheet, for remote-settings.spec.ts to look at. `?state=` picks the state and `?theme=` the theme. The
// states need a relay and a phone in the app, which the e2e suite has neither of; what each control does is tested in
// src/remote/.
import { createRoot } from "react-dom/client";
import "../src/theme/tokens.css";
import "../src/theme/base.css";
import "../src/theme/motion.css";
import "../src/settings/settings.css";
import { setLang } from "../src/i18n";
import type { RemoteSnapshot } from "../src/remote/host";
import { RemoteView } from "../src/settings/RemotePage";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
setLang("en");

const NOW = Date.UTC(2026, 10, 26, 9, 30);
const LINK = "https://dev.manut.xyz/app/#pair=AQ" + "x7Kq2mZp9VbR4tLw8nYc3HdF6jGs1aEo5uTi0WkQyNvBrCxMzPlOhUgJfDeSaIqKmYtR2c4V6b8N0".repeat(2).slice(0, 149);
// One phone at Answer, as every phone paired before item 108b is, and one narrowed to Watch.
const phones = [
  { id: "A", name: "Somchai's iPhone", pairedAt: NOW - 3 * 86_400_000, lastSeen: NOW - 120_000, connected: true, push: true, grant: { level: "answer", terminal: false, manage: false } },
  { id: "B", name: "Pixel 9", pairedAt: NOW - 86_400_000, lastSeen: NOW - 86_400_000, connected: false, push: false, grant: { level: "watch", terminal: false, manage: false } },
] as const;
const STATES: Record<string, { snapshot: RemoteSnapshot; consenting?: boolean }> = {
  off: { snapshot: { on: false, link: "stopped", pairing: { phase: "idle" }, phones: [] } },
  consent: { snapshot: { on: false, link: "stopped", pairing: { phase: "idle" }, phones: [] }, consenting: true },
  unavailable: { snapshot: { on: true, link: "unavailable", pairing: { phase: "idle" }, phones: [] } },
  ready: { snapshot: { on: true, link: "ready", pairing: { phase: "idle" }, phones } },
  showing: { snapshot: { on: true, link: "ready", pairing: { phase: "showing", link: LINK, expiresAt: NOW + 105_000 }, phones: [] } },
  code: { snapshot: { on: true, link: "ready", pairing: { phase: "code", expiresAt: NOW + 72_000 }, phones: [] } },
  finishing: { snapshot: { on: true, link: "ready", pairing: { phase: "finishing" }, phones: [] } },
  wrong: { snapshot: { on: true, link: "ready", pairing: { phase: "failed", reason: "wrong_code" }, phones: [] } },
  paired: { snapshot: { on: true, link: "ready", pairing: { phase: "paired", name: "Somchai's iPhone" }, phones: phones.slice(0, 1) } },
};
const chosen = STATES[params.get("state") ?? "off"] ?? STATES.off!;
const noop = () => undefined;

createRoot(document.getElementById("root")!).render(
  <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
    <div className="st-body" style={{ width: 720, margin: "0 auto" }}>
      <RemoteView
        snapshot={chosen.snapshot}
        consenting={!!chosen.consenting}
        now={NOW}
        copied={false}
        onSwitch={noop}
        onAccept={noop}
        onDecline={noop}
        onPair={noop}
        onCancel={noop}
        onCopy={noop}
        onCode={noop}
        onUnpair={noop}
      />
    </div>
  </div>,
);
