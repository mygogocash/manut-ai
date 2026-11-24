// Customize › Connections, as the design canvas draws its Outposts box (Connections.dc.html): "Outposts. The machines
// your team works on.", and this Mac's row with where it stands, Online or Asleep, and one button: Register this Mac,
// Stop or Start. The canvas's other parts of the page (the shop's channels, the AI models, the vault's sign-ins and the
// cloud outpost) are later slices, so the box stands alone here.
//
// The view uses no hooks, so a test can call it as a plain function and read its button's handler. `useOutpost` feeds it:
// it reads where this Mac's outpost stands for the shop the switcher shows from the shell when the tab opens and every 3
// seconds while it is open (the shell answers from memory), and does what the button says. The page never sees the
// outpost's credential: registering goes through that shop's own owner session (or the sign-in while the person is in no
// shops), but its answer stops in the shell (src/runtime/http/outpost.ts).
import { useEffect, useState } from "react";
import { t } from "../i18n";
import type { ShopRow } from "../lib/protocol";
import { ownerLinkFor } from "../runtime/http";
import { registerThisMac, shellOutpost, type OutpostView } from "../runtime/http/outpost";
import { runtimeKind, startedRuntime } from "../runtime";
import { useSignIn } from "../runtime/link";
import { actionLabel, outpostRow, registeredError, type OutpostAction, type OutpostContext, type OutpostRow } from "./outpost";

export interface OutpostPaneProps {
  row: OutpostRow;
  /** a click is being carried out */
  busy: boolean;
  /** why the last click did not do what it said */
  error: string | null;
  onAction: (action: OutpostAction) => void;
}

export function OutpostPane({ row, busy, error, onAction }: OutpostPaneProps) {
  const action = row.action;
  return (
    <section className="side2 outposts" aria-labelledby="outposts-title" data-testid="outposts">
      <h2 className="h2" id="outposts-title">
        {t("outpost.title")}
      </h2>
      <p className="hint">{t("outpost.hint")}</p>
      <div className="box">
        <div className="tr" data-testid="outpost-row">
          <span className="grow">
            <span className="conn-name">{t("outpost.thisMac")}</span>
            {row.line && (
              <span className="conn-line" data-testid="outpost-line">
                {row.line}
              </span>
            )}
          </span>
          {row.tag && (
            <span className={row.tag === "online" ? "tag ok" : "tag"} data-testid="outpost-tag">
              {row.tag === "online" ? t("outpost.online") : t("outpost.asleep")}
            </span>
          )}
          {action && (
            <button type="button" className={action === "register" ? "btn dark" : "btn"} disabled={busy} onClick={() => onAction(action)} data-testid={`outpost-${action}`}>
              {actionLabel(action, busy)}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="msg err" role="alert" data-testid="outpost-error">
          {error}
        </p>
      )}
      <p className="hint" data-testid="outpost-window">
        {t("outpost.window")}
      </p>
    </section>
  );
}

/** The Outposts box's state and its button, for the runtime this page started with and the shop the switcher shows
 *  (`viewing`, one of `shops`; null while the person is in no shops, when the box is about their signed-in tenant). */
export function useOutpost(viewing: string | null = null, shops: readonly ShopRow[] = []): OutpostPaneProps {
  const setting = startedRuntime();
  const origin = runtimeKind(setting) === "http" && setting.mode === "connected" ? setting.origin : null;
  const signIn = useSignIn(origin);
  const signedIn = signIn?.kind === "signed_in" ? signIn.tenant : null;
  // The shop the box is about: the one the switcher shows, whose tenant is its id, or the signed-in tenant.
  const tenant = signedIn === null ? null : (viewing ?? signedIn);
  const helper = viewing !== null && shops.find((s) => s.id === viewing)?.role === "helper";
  const [view, setView] = useState<OutpostView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    if (!origin || !tenant) return;
    let live = true;
    const shell = shellOutpost();
    const read = () => void shell.status(origin, tenant).then((next) => live && setView(next));
    read();
    const timer = setInterval(read, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [origin, tenant]);

  const act = async (action: OutpostAction) => {
    if (!origin || !tenant || busy) return;
    setBusy(true);
    setError(null);
    const shell = shellOutpost();
    try {
      if (action === "register") setError(registeredError(await registerThisMac(ownerLinkFor(origin), viewing, shell, t("outpost.thisMac"))));
      else await shell.run(origin, tenant, action === "start");
    } catch {
      setError(t("outpost.err.failed"));
    }
    setView(await shell.status(origin, tenant));
    setBusy(false);
  };

  const context: OutpostContext = !origin ? { kind: "practice" } : !tenant ? { kind: "signed_out" } : helper ? { kind: "helper" } : { kind: "signed_in", view };
  return { row: outpostRow(context), busy, error, onAction: (action) => void act(action) };
}
