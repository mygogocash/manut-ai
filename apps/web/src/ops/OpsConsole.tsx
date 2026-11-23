import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useApiSetup } from "../api";
import {
  AuditIcon,
  BrandMark,
  DraftIcon,
  FlagIcon,
  MemoryIcon,
  ShopsIcon,
  SpendIcon,
  StoreIcon,
  useColorScheme,
} from "../ui/marks";
import { AuditView } from "./AuditView";
import { DeletionNotices } from "./DeletionNotices";
import { DraftsView } from "./DraftsView";
import { GateView } from "./GateView";
import { MemoryView } from "./MemoryView";
import { MessagesTab } from "./MessagesTab";
import { ModelSpendView } from "./ModelSpendView";
import { forgetOperatorKey, readOperatorKey, saveOperatorKey } from "./operatorKey";
import { PaymentsTab } from "./PaymentsTab";
import { ShopDataTab } from "./ShopDataTab";
import { ShopsView, type ShopPage } from "./ShopsView";
import { useLoad } from "./useLoad";
import { deletionOf, useShopDeletion } from "./useShopDeletion";
import {
  auditWords,
  draftsWords,
  errorText,
  gateWords,
  isAuthError,
  memoryWords,
  modelSpendWords,
  shopDataWords,
  shopsWords,
} from "./words";

/// The operator console for the concierge pilot, desktop first, in the canvas's side-menu layout: shops in
/// the side menu, the chosen shop's messages, replies, payments and data in the main column. The Shops overview, first
/// in the menu, lists every shop at a glance with a link to each of its pages. The Pilot gate puts every shop in the main
/// column at once too: where the pilot stands against its Phase 1 gate.
/// The Audit page beside it reads one shop's audit log: who did what for it, and when. The Memory page reads what the
/// team knows about one shop, and is where an operator relays the owner's say over it. The Drafts page reads what Nam,
/// Pim and Ton wrote for one shop, with nothing on it that sends a draft. The Model spend page reads one shop's model
/// spend for a month against its monthly cap, and sets or clears the cap.

export const REFRESH_MS = 15000;

type Tab = "messages" | "payments" | "data";
/// What the main column shows: the chosen shop, every shop at a glance, the Pilot gate across all of them, or one shop's
/// audit log, memory, drafts or model spend.
type Page = "overview" | "shop" | "gate" | "audit" | "memory" | "drafts" | "model";

export function OpsConsole() {
  const { api, mode } = useApiSetup();
  const scheme = useColorScheme();
  const [hasKey, setHasKey] = useState(() => readOperatorKey() !== null);
  const [tenant, setTenant] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("messages");
  const [page, setPage] = useState<Page>("shop");

  const shops = useLoad(hasKey ? () => api.listShops() : null, `shops:${hasKey}`);
  // After a deletion the operator lands on the next shop's messages, never on its delete button.
  const deletion = useShopDeletion(api, { onAnswered: shops.reload, onDeleted: () => setTab("messages") });
  const shopList = useMemo(
    () => shops.data?.filter((s) => !deletion.gone.has(s.tenant)) ?? null,
    [shops.data, deletion.gone],
  );
  const shop = shopList?.find((s) => s.tenant === tenant) ?? null;
  // A live shop's deletion waits for its owner: the header says so, and the Shop data tab shows the link.
  const shopDeletion = shop ? deletionOf(shop, deletion.asked) : null;
  const messages = useLoad(shop ? () => api.listMessages(shop.tenant) : null, `messages:${shop?.tenant ?? ""}`);
  const actions = useLoad(shop ? () => api.listActions(shop.tenant) : null, `actions:${shop?.tenant ?? ""}`);
  const { reload: reloadMessages } = messages;
  const { reload: reloadActions } = actions;

  useEffect(() => {
    document.title = "Pilot console";
  }, []);

  // Lands on the first shop when none (or a gone one) is chosen. The check runs against the choice at the moment
  // the update applies, not the one this render saw: a click on a shop that arrives between the list's render and
  // this effect must win, and with the render's own value the effect put the first shop back over the click.
  useEffect(() => {
    const first = shopList?.[0];
    if (!first) return;
    setTenant((current) => (shopList.some((s) => s.tenant === current) ? current : first.tenant));
  }, [shopList]);

  // Owners answer from their phones, so the lists refresh themselves while the console shows them.
  useEffect(() => {
    if (!shop || page !== "shop") return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      reloadMessages();
      reloadActions();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [shop, page, reloadMessages, reloadActions]);

  /// The overview's links: the page opens on that shop, a shop's own page on its messages.
  const open = (target: string, next: ShopPage) => {
    setTenant(target);
    setPage(next);
    if (next === "shop") setTab("messages");
    deletion.dismissFinished();
  };

  const forget = () => {
    forgetOperatorKey();
    setHasKey(false);
    setTenant(null);
    setPage("shop");
  };

  const refresh = () => {
    shops.reload();
    reloadMessages();
    reloadActions();
  };

  const authFailed = [shops.error, messages.error, actions.error].some(isAuthError);

  return (
    <div className="r app" data-t={scheme}>
      <nav className="sb" aria-label="Console">
        <div className="brand">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BrandMark />
            <span style={{ fontWeight: 600 }}>Pilot console</span>
          </span>
        </div>
        {hasKey && (
          <>
            <button
              type="button"
              className="nav"
              style={{ width: "100%" }}
              aria-current={page === "overview" ? "page" : undefined}
              onClick={() => setPage("overview")}
            >
              <ShopsIcon />
              <span style={{ flex: 1, minWidth: 0 }}>{shopsWords.nav}</span>
            </button>
            <button
              type="button"
              className="nav"
              style={{ width: "100%" }}
              aria-current={page === "gate" ? "page" : undefined}
              onClick={() => setPage("gate")}
            >
              <FlagIcon />
              <span style={{ flex: 1, minWidth: 0 }}>{gateWords.nav}</span>
            </button>
            <button
              type="button"
              className="nav"
              style={{ width: "100%" }}
              aria-current={page === "audit" ? "page" : undefined}
              onClick={() => setPage("audit")}
            >
              <AuditIcon />
              <span style={{ flex: 1, minWidth: 0 }}>{auditWords.nav}</span>
            </button>
            <button
              type="button"
              className="nav"
              style={{ width: "100%" }}
              aria-current={page === "memory" ? "page" : undefined}
              onClick={() => setPage("memory")}
            >
              <MemoryIcon />
              <span style={{ flex: 1, minWidth: 0 }}>{memoryWords.nav}</span>
            </button>
            <button
              type="button"
              className="nav"
              style={{ width: "100%" }}
              aria-current={page === "drafts" ? "page" : undefined}
              onClick={() => setPage("drafts")}
            >
              <DraftIcon />
              <span style={{ flex: 1, minWidth: 0 }}>{draftsWords.nav}</span>
            </button>
            <button
              type="button"
              className="nav"
              style={{ width: "100%" }}
              aria-current={page === "model" ? "page" : undefined}
              onClick={() => setPage("model")}
            >
              <SpendIcon />
              <span style={{ flex: 1, minWidth: 0 }}>{modelSpendWords.nav}</span>
            </button>
            <div className="mut" style={{ padding: "12px 10px 4px", fontSize: 12 }} id="shops-label">
              Shops
            </div>
            {shopList ? (
              <ul aria-labelledby="shops-label" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {shopList.map((s) => (
                  <li key={s.tenant}>
                    <button
                      type="button"
                      className="nav"
                      style={{ width: "100%" }}
                      aria-current={page === "shop" && s.tenant === tenant ? "page" : undefined}
                      onClick={() => {
                        setTenant(s.tenant);
                        setPage("shop");
                        deletion.dismissFinished();
                      }}
                    >
                      <StoreIcon />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : shops.loading ? (
              <div className="skel" style={{ height: 34, margin: "0 6px" }} aria-label="Loading shops" />
            ) : null}
          </>
        )}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 6, padding: "0 6px" }}>
          {mode === "fake" && <span className="planp" style={{ alignSelf: "flex-start" }}>Practice mode</span>}
          {hasKey && (
            <div className="mut" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 4px 6px" }}>
              <span style={{ flex: 1 }}>Operator key kept for this tab</span>
              <button type="button" className="lk" onClick={forget}>
                Forget
              </button>
            </div>
          )}
        </div>
      </nav>

      <div className="mainc">
        {!hasKey ? (
          <KeyForm
            practice={mode === "fake"}
            onSaved={() => {
              setHasKey(true);
            }}
          />
        ) : page === "overview" ? (
          <ShopsView shops={shopList} onOpen={open} onForget={forget} />
        ) : page === "gate" ? (
          <GateView onForget={forget} />
        ) : page === "audit" ? (
          <AuditView shops={shopList} tenant={tenant} onForget={forget} />
        ) : page === "memory" ? (
          <MemoryView shops={shopList} tenant={tenant} onForget={forget} />
        ) : page === "drafts" ? (
          <DraftsView shops={shopList} tenant={tenant} onForget={forget} />
        ) : page === "model" ? (
          <ModelSpendView shops={shopList} tenant={tenant} onForget={forget} />
        ) : (
          <>
            <div className="top">
              <h1>{shop?.name ?? "Shops"}</h1>
              {shop && (
                <>
                  <span className="mut" style={{ fontSize: 13 }}>
                    Owner {shop.ownerName}
                  </span>
                  <span className={shop.lineConnectionId ? "tag ok" : "tag"}>
                    {shop.lineConnectionId ? "LINE connected" : "LINE not connected"}
                  </span>
                  <span className={shop.consent ? "tag ok" : "tag warn"}>
                    {shop.consent ? "Owner allowed sending" : "Owner has not allowed sending yet"}
                  </span>
                  {shopDeletion?.state === "awaiting_owner" && (
                    <span className="tag warn">{shopDataWords.waitingTag(shop.ownerName)}</span>
                  )}
                  {shopDeletion?.state === "deleting" && <span className="tag err">{shopDataWords.unfinishedTag}</span>}
                </>
              )}
              <div className="tabs" role="tablist" aria-label="Sections">
                <button
                  type="button"
                  role="tab"
                  id="tab-messages"
                  className="tab"
                  aria-selected={tab === "messages"}
                  aria-controls="panel-messages"
                  onClick={() => setTab("messages")}
                >
                  Messages
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-payments"
                  className="tab"
                  aria-selected={tab === "payments"}
                  aria-controls="panel-payments"
                  onClick={() => setTab("payments")}
                >
                  PromptPay
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-data"
                  className="tab"
                  aria-selected={tab === "data"}
                  aria-controls="panel-data"
                  onClick={() => setTab("data")}
                >
                  {shopDataWords.tab}
                </button>
              </div>
              <div className="acts">
                <button type="button" className="btn ghost" onClick={refresh}>
                  Refresh
                </button>
              </div>
            </div>
            <DeletionNotices deletion={deletion} />
            {authFailed && (
              <div style={{ padding: "12px 16px 0" }}>
                <div className="banner err" role="alert">
                  <span className="grow">{errorText(shops.error ?? messages.error ?? actions.error)}</span>
                  <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={forget}>
                    Enter another key
                  </button>
                </div>
              </div>
            )}
            {shops.error && !authFailed ? (
              <div style={{ padding: 16 }}>
                <div className="banner err" role="alert">
                  <span className="grow">{errorText(shops.error)}</span>
                  <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={shops.reload}>
                    Try again
                  </button>
                </div>
              </div>
            ) : shopList && shopList.length === 0 ? (
              <div className="empty">
                <span className="ico">
                  <StoreIcon />
                </span>
                <h3>No shops yet</h3>
                <p>Add a shop with POST /v1/admin/pilot/shops, then connect its LINE account.</p>
              </div>
            ) : shop ? (
              tab === "messages" ? (
                <MessagesTab
                  key={shop.tenant}
                  shop={shop}
                  messages={messages}
                  actions={actions}
                  onChanged={() => {
                    reloadMessages();
                    reloadActions();
                  }}
                />
              ) : tab === "payments" ? (
                <PaymentsTab key={shop.tenant} shop={shop} />
              ) : (
                <ShopDataTab
                  key={shop.tenant}
                  shop={shop}
                  request={shopDeletion}
                  onDelete={(name) => deletion.run(shop.tenant, name)}
                  onFinish={() => deletion.run(shop.tenant, shop.name, true)}
                />
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function KeyForm({ practice, onSaved }: { practice: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    saveOperatorKey(value);
    setValue("");
    onSaved();
  }

  return (
    <div className="col" style={{ maxWidth: 460, paddingTop: 64 }}>
      <form className="box" onSubmit={submit} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <h1 className="big">Enter the operator key</h1>
        <div className="field">
          <label htmlFor="operator-key">Operator key</label>
          <input
            id="operator-key"
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-describedby="operator-key-help"
          />
          <div id="operator-key-help" className="help">
            Kept only in this tab and sent only to the admin routes. Closing the tab forgets it.
            {practice ? " Practice mode: any key works." : ""}
          </div>
        </div>
        <div>
          <button type="submit" className="btn dark" disabled={!value.trim()}>
            Use this key
          </button>
        </div>
      </form>
    </div>
  );
}
