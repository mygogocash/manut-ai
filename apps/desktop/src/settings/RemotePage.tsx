// Settings › Sharing and access (item 78b, docs/remote-access.md, "What a person does", steps 1, 2 and 4 on the Mac):
// "Reach this Mac from your phone", which stays off until the person accepts the consent sheet; "Pair a phone", a QR code
// and a link for two minutes, hidden at the phone's first step, then a field for the four digits the phone shows, typed
// once; the paired phones with Unpair; and, while a phone is connected, one quiet line saying so. Nothing else in the
// app changes.
//
// Each paired phone also shows what it may do from afar, Watch or Answer (item 108b, remote/levels.ts), and the person
// sets it here; it applies to that phone's next request. Work and its permissions are not offered until their requests
// exist; a phone whose record already holds one (kept by a later build) shows it, and can be narrowed.
//
// `RemoteView` draws a given state so a test can draw it; `RemotePage` reads the app's RemoteMac (remote/state.ts).
import { useEffect, useRef, useState } from "react";
import "./remote.css";
import { type Key, locale, t } from "../i18n";
import { Toggle } from "../pages/kit";
import { Modes } from "../ui/Modes";
import type { RemoteSnapshot } from "../remote/host";
import { type Level, OFFERED_LEVELS } from "../remote/levels";
import type { PairingView } from "../remote/pairing";
import { QrCode } from "../remote/QrCode";
import { acceptAndTurnOn, acceptTailscaleAndTurnOn, consentCovers, readChoice, readTailscaleChoice, remoteMac, TAILSCALE_CONSENT_VERSION, turnOff, turnOn, turnTailscaleOff, turnTailscaleOn, useRemote } from "../remote/state";
import { readTailscale, tailscaleLine, type TailscaleState } from "../remote/tailscale";
import { Row } from "./DevRow";

/** The consent sheet's points, in order. `rm.consent.operator` is the owner's to write (a marked placeholder). */
export const CONSENT_POINTS: Key[] = ["rm.consent.encrypted", "rm.consent.relaySees", "rm.consent.operator", "rm.consent.retention", "rm.consent.boundary", "rm.consent.stop"];

const LINK_WORDS: Record<RemoteSnapshot["link"], Key> = {
  stopped: "rm.state.off",
  connecting: "rm.state.connecting",
  ready: "rm.state.ready",
  waiting: "rm.state.waiting",
  unavailable: "rm.state.unavailable",
  no_origin: "rm.state.noOrigin",
  no_keychain: "rm.state.noKeychain",
};

const LEVEL_WORDS: Record<Level, Key> = {
  watch: "rm.level.watch",
  answer: "rm.level.answer",
  work: "rm.level.work",
};

const FAILED_WORDS: Record<Extract<PairingView, { phase: "failed" }>["reason"], Key> = {
  wrong_code: "rm.failed.wrongCode",
  expired: "rm.failed.expired",
  refused: "rm.failed.refused",
  full: "rm.failed.full",
  taken: "rm.failed.taken",
  cancelled: "rm.failed.refused",
};

function when(ms: number): string {
  return new Date(ms).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

function left(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface RemoteViewProps {
  readonly snapshot: RemoteSnapshot;
  readonly consenting: boolean;
  readonly now: number;
  readonly copied: boolean;
  onSwitch(on: boolean): void;
  onAccept(): void;
  onDecline(): void;
  onPair(): void;
  onCancel(): void;
  onCopy(link: string): void;
  onCode(code: string): void;
  onUnpair(id: string): void;
  /** Sets what a paired phone may do from afar (item 108b). */
  onLevel?(id: string, level: Level): void;
  /** Tailscale on this Mac (item 78f-2b), read when the page opens; null until read, or where there is no shell. */
  readonly tailscaleHere?: TailscaleState | null;
  readonly tailscaleConsenting?: boolean;
  onTailscale?(on: boolean): void;
  onTailscaleAccept?(): void;
  onTailscaleDecline?(): void;
}

/** The Tailscale sheet's points, in order. */
export const TAILSCALE_CONSENT_POINTS: Key[] = ["rm.ts.consent.serve", "rm.ts.consent.who", "rm.ts.consent.tls", "rm.ts.consent.public"];

/** The Tailscale road's line: what it is doing, or why it cannot be turned on yet. */
export function tailscaleHint(road: RemoteSnapshot["tailscale"], here: TailscaleState): string {
  if (road.state === "on") return t("rm.ts.on", { name: road.name, port: road.port });
  if (road.state === "starting") return t("rm.ts.starting");
  if (road.state === "failed") return t("rm.ts.failed", { why: road.why });
  return here.state === "ready" ? t("rm.ts.off", { name: here.name }) : tailscaleLine(here);
}

/** The Tailscale road under the main switch: its line, its own switch (on only where Tailscale is ready), and its sheet. */
function TailscaleRoad(props: RemoteViewProps & { here: TailscaleState }) {
  const road = props.snapshot.tailscale;
  const on = road.state === "on" || road.state === "starting";
  const name = props.here.state === "ready" ? props.here.name : "";
  return (
    <>
      <div className="st-grp" data-testid="remote-tailscale">
        <Row title={t("rm.ts.title")} hint={tailscaleHint(road, props.here)}>
          <Toggle on={on} label={t("rm.ts.title")} disabled={!on && props.here.state !== "ready"} onChange={(v) => props.onTailscale?.(v)} testId="remote-tailscale-switch" />
        </Row>
      </div>
      {props.tailscaleConsenting && (
        <div className="rm-card rm-consent" role="dialog" aria-modal="false" aria-labelledby="rm-ts-consent-title" data-testid="remote-tailscale-consent">
          <h3 id="rm-ts-consent-title">{t("rm.ts.consent.title")}</h3>
          <ul>
            {TAILSCALE_CONSENT_POINTS.map((k) => (
              <li key={k}>{t(k, { name })}</li>
            ))}
          </ul>
          <div className="rm-actions">
            <button type="button" className="btn ghost" onClick={props.onTailscaleDecline} data-testid="remote-tailscale-no">
              {t("rm.ts.consent.decline")}
            </button>
            <button type="button" className="btn dark" onClick={props.onTailscaleAccept} data-testid="remote-tailscale-yes">
              {t("rm.ts.consent.accept")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function CodeField({ expiresAt, now, onCode, onCancel }: { expiresAt: number; now: number; onCode(code: string): void; onCancel(): void }) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = () => {
    if (sent || code.length !== 4) return;
    setSent(true);
    onCode(code);
  };
  return (
    <form
      className="rm-code"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor="rm-code-in" className="rm-lab">
        {t("rm.code")}
      </label>
      <div className="rm-code-row">
        <input
          ref={ref}
          id="rm-code-in"
          className="input rm-code-in"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={4}
          value={code}
          disabled={sent}
          aria-describedby="rm-code-help"
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
          data-testid="remote-code"
        />
        <button type="submit" className="btn dark" disabled={sent || code.length !== 4} data-testid="remote-code-send">
          {t("rm.codeSend")}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t("rm.cancel")}
        </button>
      </div>
      <span id="rm-code-help" className="help">
        {t("rm.codeHelp", { time: left(expiresAt - now) })}
      </span>
    </form>
  );
}

function Pairing({ view, now, copied, onCancel, onCopy, onCode, onPair }: { view: PairingView; now: number; copied: boolean } & Pick<RemoteViewProps, "onCancel" | "onCopy" | "onCode" | "onPair">) {
  switch (view.phase) {
    case "showing":
      return (
        <div className="rm-card" role="group" aria-label={t("rm.pair")} data-testid="remote-pairing">
          <div className="rm-scan">
            <QrCode text={view.link} label={t("rm.qr")} />
            <div className="rm-scan-t">
              <p>{t("rm.scan")}</p>
              <span className="help">{t("rm.expires", { time: left(view.expiresAt - now) })}</span>
              <div className="rm-acts">
                <button type="button" className="btn" onClick={() => onCopy(view.link)} data-testid="remote-copy">
                  {copied ? t("rm.copied") : t("rm.copy")}
                </button>
                <button type="button" className="btn ghost" onClick={onCancel}>
                  {t("rm.cancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    case "checking":
      return (
        <div className="rm-card" role="status" data-testid="remote-pairing">
          <p>{t("rm.checking")}</p>
        </div>
      );
    case "code":
      return (
        <div className="rm-card" data-testid="remote-pairing">
          <CodeField expiresAt={view.expiresAt} now={now} onCode={onCode} onCancel={onCancel} />
        </div>
      );
    case "finishing":
      return (
        <div className="rm-card" role="status" data-testid="remote-pairing">
          <p>{t("rm.finishing")}</p>
        </div>
      );
    case "paired":
      return (
        <div className="rm-card" role="status" data-testid="remote-pairing">
          <p>{t("rm.paired", { name: view.name })}</p>
          <div className="rm-acts">
            <button type="button" className="btn" onClick={onCancel}>
              {t("rm.done")}
            </button>
          </div>
        </div>
      );
    case "failed":
      return (
        <div className="rm-card" role="alert" data-testid="remote-pairing">
          <p>{t(FAILED_WORDS[view.reason])}</p>
          <div className="rm-acts">
            {view.reason !== "full" && (
              <button type="button" className="btn" onClick={onPair}>
                {t("rm.again")}
              </button>
            )}
            <button type="button" className="btn ghost" onClick={onCancel}>
              {t("rm.cancel")}
            </button>
          </div>
        </div>
      );
    default:
      return null;
  }
}

export function RemoteView(props: RemoteViewProps) {
  const { snapshot, consenting, now } = props;
  const connected = snapshot.phones.filter((p) => p.connected);
  const canPair = snapshot.on && snapshot.link === "ready";
  return (
    <div className="st-page rm" data-testid="remote-page">
      <div className="st-gh st-gh0">{t("set.remote")}</div>
      <div className="st-note">{t("rm.intro")}</div>
      <div className="st-grp">
        <Row title={t("rm.switch")} hint={t(snapshot.on ? LINK_WORDS[snapshot.link] : "rm.state.off")}>
          <Toggle on={snapshot.on} label={t("rm.switch")} onChange={props.onSwitch} testId="remote-switch" />
        </Row>
      </div>
      {snapshot.on && props.tailscaleHere && <TailscaleRoad {...props} here={props.tailscaleHere} />}
      {connected.length > 0 && (
        <div className="st-note rm-live" role="status" data-testid="remote-connected">
          {connected.length === 1 ? t("rm.connected", { name: connected[0]!.name }) : t("rm.connectedMany", { n: connected.length })}
        </div>
      )}
      {consenting && (
        <div className="rm-card rm-consent" role="dialog" aria-modal="false" aria-labelledby="rm-consent-title" data-testid="remote-consent">
          <h3 id="rm-consent-title">{t("rm.consent.title")}</h3>
          <ul>
            {CONSENT_POINTS.map((key) => (
              <li key={key} data-key={key}>
                {t(key)}
              </li>
            ))}
          </ul>
          <div className="rm-acts">
            <button type="button" className="btn ghost" onClick={props.onDecline} data-testid="remote-consent-no">
              {t("rm.consent.decline")}
            </button>
            <button type="button" className="btn dark" onClick={props.onAccept} data-testid="remote-consent-yes">
              {t("rm.consent.accept")}
            </button>
          </div>
        </div>
      )}
      <div className="st-gh">{t("rm.phones")}</div>
      <div className="st-grp">
        {snapshot.pairing.phase === "idle" && (
          <Row title={t("rm.pair")} hint={t(canPair ? "rm.pairHint" : "rm.pairOff")}>
            <button type="button" className="btn" disabled={!canPair} onClick={props.onPair} data-testid="remote-pair">
              {t("rm.pair")}
            </button>
          </Row>
        )}
        {snapshot.pairing.phase !== "idle" && (
          <div className="rm-pairing">
            <Pairing view={snapshot.pairing} now={now} copied={props.copied} onCancel={props.onCancel} onCopy={props.onCopy} onCode={props.onCode} onPair={props.onPair} />
          </div>
        )}
        {snapshot.phones.length === 0 ? (
          <Row hint={t("rm.none")} />
        ) : (
          snapshot.phones.map((phone) => {
            const line = phone.lastSeen && phone.lastSeen !== phone.pairedAt ? t("rm.pairedSeen", { paired: when(phone.pairedAt), seen: when(phone.lastSeen) }) : t("rm.pairedAt", { paired: when(phone.pairedAt) });
            // Watch and Answer, and the phone's own level beside them when its record holds one not offered here.
            const levels = OFFERED_LEVELS.includes(phone.grant.level) ? OFFERED_LEVELS : [...OFFERED_LEVELS, phone.grant.level];
            return (
              <Row
                key={phone.id}
                title={phone.name}
                // a phone that turned on "Tell me when my Mac needs me" on its Your Mac tab says so (item 78d)
                hint={phone.push ? t("rm.pushOn", { line }) : line}
              >
                <span className="st-pair">
                  <Modes
                    label={t("rm.level", { name: phone.name })}
                    value={phone.grant.level}
                    options={levels.map((level) => ({ value: level, label: t(LEVEL_WORDS[level]) }))}
                    onChange={(level) => props.onLevel?.(phone.id, level as Level)}
                    testId="remote-level"
                  />
                  <button type="button" className="btn" onClick={() => props.onUnpair(phone.id)} data-testid="remote-unpair">
                    {t("rm.unpair")}
                  </button>
                </span>
              </Row>
            );
          })
        )}
      </div>
      {snapshot.phones.length > 0 && (
        <div className="st-note" data-testid="remote-levels-note">
          {t("rm.levels")}
        </div>
      )}
    </div>
  );
}

export function RemotePage() {
  const snapshot = useRemote();
  const [consenting, setConsenting] = useState(false);
  const [here, setHere] = useState<TailscaleState | null>(null);
  const [tsConsenting, setTsConsenting] = useState(false);
  useEffect(() => {
    // what Tailscale says on this Mac, read again whenever the main switch changes; only the shell's read, nothing changed
    if (!snapshot.on) return;
    let live = true;
    void readTailscale()
      .then((s) => live && setHere(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [snapshot.on]);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const counting = snapshot.pairing.phase === "showing" || snapshot.pairing.phase === "code";
  useEffect(() => {
    // The paired phones are listed while the switch is off too, read without making anything.
    void remoteMac().loadPhones().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  return (
    <RemoteView
      snapshot={snapshot}
      consenting={consenting}
      now={now}
      copied={copied}
      onSwitch={(on) => {
        if (!on) {
          setConsenting(false);
          turnOff();
          return;
        }
        if (consentCovers(readChoice())) void turnOn();
        else setConsenting(true);
      }}
      onAccept={() => {
        setConsenting(false);
        void acceptAndTurnOn();
      }}
      onDecline={() => setConsenting(false)}
      onPair={() => {
        setCopied(false);
        remoteMac().cancelPairing();
        void remoteMac().startPairing();
      }}
      onCancel={() => remoteMac().cancelPairing()}
      onCopy={(link) => {
        void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => undefined);
      }}
      onCode={(code) => void remoteMac().typeCode(code)}
      onUnpair={(id) => void remoteMac().unpair(id)}
      onLevel={(id, level) => void remoteMac().setLevel(id, level).catch(() => undefined)}
      tailscaleHere={here}
      tailscaleConsenting={tsConsenting}
      onTailscale={(on) => {
        if (!on) {
          setTsConsenting(false);
          turnTailscaleOff();
          return;
        }
        if (consentCovers(readTailscaleChoice(), TAILSCALE_CONSENT_VERSION)) void turnTailscaleOn();
        else setTsConsenting(true);
      }}
      onTailscaleAccept={() => {
        setTsConsenting(false);
        void acceptTailscaleAndTurnOn();
      }}
      onTailscaleDecline={() => setTsConsenting(false)}
    />
  );
}
