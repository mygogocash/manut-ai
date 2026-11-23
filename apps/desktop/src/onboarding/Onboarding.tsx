// The first-run setup: the design canvas's Welcome.dc.html, then its Onboarding.dc.html steps (1 Your shop, 2 One
// channel, 3 Your team), then Home. It fills the window on a first run until the person presses Open Manut AI on the
// last step or Skip for now on any step, and Settings › General opens it again on Your shop. Its rules are in flow.ts
// and shop.ts; this file draws them, and the store moves, keeps and ends the setup (store.ts, firstRunDo and firstRunEnd).
//
// Where the canvas draws what the app cannot do yet, the setup says what happens instead rather than show a button that
// does nothing or a state that is not true:
// - Welcome's LINE, Google and email sign-in: the desktop has no backend to sign in to until the runtime adapter comes
//   (later in Phase 3), so Welcome offers one way in, on this computer, and says signing in comes later.
// - One channel's Connect buttons and Connected tags: the demo runtime connects nothing, so the step asks which channel
//   matters most and says connecting happens later in Customize.
// - The person's name: the canvas takes it from sign-in, so Your shop asks for it, and it may stay empty.
// The language choice offers the app's own languages; Thai, which the canvas offers beside English, is not one yet.
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import "./onboarding.css";
import { LANG_NAMES, LANG_TAG, LANGS, listText, t, type Key, type Lang } from "../i18n";
import { holdImeEnter } from "../lib/ime";
import { selectSidebarBots, useStore } from "../state/store";
import { BrandMark } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import { CHANNELS, SHOP_LIMITS, type Channel, type ShopProfile } from "./shop";
import {
  practiceTeam,
  problemsOf,
  radioMove,
  stepMark,
  STEPS,
  type FlowEvent,
  type FlowState,
  type PracticeRole,
  type Problem,
  type Step,
  type TextField,
} from "./flow";

const STEP_LABEL: Record<Step, Key> = { shop: "onb.step.shop", channel: "onb.step.channel", team: "onb.step.team" };
const TITLE: Record<Step, Key> = { shop: "onb.shop.title", channel: "onb.channel.title", team: "onb.team.title" };
const LEAD: Record<Step, Key> = { shop: "onb.shop.lead", channel: "onb.channel.lead", team: "onb.team.lead" };

/** Each place in the canvas's words: its short name on Your shop's chips, its full name and what the team would read
 *  there on One channel. Only LINE's full name differs from its short one. */
const CHANNEL_WORDS: Record<Channel, { name: Key; full: Key; note: Key }> = {
  line: { name: "onb.ch.line", full: "onb.ch.lineFull", note: "onb.chNote.line" },
  shopee: { name: "onb.ch.shopee", full: "onb.ch.shopee", note: "onb.chNote.shopee" },
  lazada: { name: "onb.ch.lazada", full: "onb.ch.lazada", note: "onb.chNote.lazada" },
  facebook: { name: "onb.ch.facebook", full: "onb.ch.facebook", note: "onb.chNote.facebook" },
  instagram: { name: "onb.ch.instagram", full: "onb.ch.instagram", note: "onb.chNote.instagram" },
};

/** The control a refused Next sends the keyboard to, for each problem, so the person lands on what is missing. */
function problemTarget(p: Problem, d: ShopProfile): string {
  if (p === "shop") return "frun-shop";
  if (p === "places") return `frun-place-${CHANNELS[0]}`;
  return `frun-main-${d.places[0]}`;
}

/** One member Your team introduces, as the runtime lists them. */
export interface TeamIntro {
  name: string;
  displayName: string;
  description: string;
  role: PracticeRole;
}

export interface OnboardingViewProps {
  flow: FlowState;
  /** the language the app speaks now, which Welcome's choice shows pressed */
  lang: Lang;
  team: TeamIntro[];
  onEvent: (e: FlowEvent) => void;
  onLang: (l: Lang) => void;
  /** Skip for now, and Open Manut AI on the last step */
  onEnd: () => void;
}

/** What a member drafts, in the canvas's words. Nam names the places the shop sells in, as the canvas's does. */
function practiceNote(role: PracticeRole, places: readonly Channel[]): string {
  if (role === "content") return t("onb.team.content");
  if (role === "books") return t("onb.team.books");
  return places.length ? t("onb.team.salesOn", { places: listText(places.map((c) => t(CHANNEL_WORDS[c].name))) }) : t("onb.team.sales");
}

/** A field's label, with the canvas's quiet "Optional" after it where the field may stay empty. The label is one text
 *  node and a span, so its name reads "Your name Optional" with the space a screen reader needs. */
function FieldLabel({ id, label, optional }: { id: string; label: Key; optional?: boolean }) {
  return (
    <label htmlFor={id}>
      {optional ? `${t(label)} ` : t(label)}
      {optional && <span className="mut">{t("onb.optional")}</span>}
    </label>
  );
}

function Welcome({ lang, onEvent, onLang }: Pick<OnboardingViewProps, "lang" | "onEvent" | "onLang">) {
  return (
    <div className="hero">
      <h1 className="wlock" id="frun-title" tabIndex={-1}>
        <BrandMark size={56} />
        Manut AI
      </h1>
      <p className="tagline">{t("onb.welcome.tagline")}</p>
      <div className="ways">
        <button type="button" className="btn dark big" onClick={() => onEvent({ type: "next" })} data-testid="frun-continue">
          {t("onb.welcome.continue")}
        </button>
        <p className="fnote">{t("onb.welcome.later")}</p>
      </div>
      <div className="langs" role="group" aria-label={t("lang.title")}>
        {LANGS.map((l) => (
          // Each language is written in its own words and marked as that language, so a screen reader says it right.
          <button key={l} type="button" className="fchip" aria-pressed={l === lang} lang={LANG_TAG[l]} onClick={() => onLang(l)} data-testid={`frun-lang-${l}`}>
            {LANG_NAMES[l]}
          </button>
        ))}
      </div>
      <p className="fnote">{t("onb.welcome.promise")}</p>
    </div>
  );
}

function ShopStep({ d, bad, onEvent }: { d: ShopProfile; bad: (p: Problem) => boolean; onEvent: (e: FlowEvent) => void }) {
  const edit = (field: TextField) => (e: { target: { value: string } }) => onEvent({ type: "edit", field, value: e.target.value });
  return (
    <>
      <div className="field">
        <FieldLabel id="frun-person" label="onb.shop.person" optional />
        <input
          id="frun-person"
          className="input"
          type="text"
          autoComplete="name"
          maxLength={SHOP_LIMITS.person}
          value={d.person}
          onChange={edit("person")}
          aria-describedby="frun-person-help"
          data-testid="frun-person"
        />
        <span className="help" id="frun-person-help">
          {t("onb.shop.personHelp")}
        </span>
      </div>
      <div className="field">
        <FieldLabel id="frun-shop" label="onb.shop.name" />
        <input
          id="frun-shop"
          className="input"
          type="text"
          autoComplete="organization"
          required
          maxLength={SHOP_LIMITS.shop}
          value={d.shop}
          onChange={edit("shop")}
          aria-invalid={bad("shop") || undefined}
          aria-describedby="frun-shop-help"
          data-testid="frun-shop"
        />
        <span className={bad("shop") ? "help err" : "help"} id="frun-shop-help">
          {bad("shop") ? t("onb.shop.nameErr") : t("onb.shop.nameHelp")}
        </span>
      </div>
      <div className="field">
        <FieldLabel id="frun-sells" label="onb.shop.sells" optional />
        <input
          id="frun-sells"
          className="input"
          type="text"
          maxLength={SHOP_LIMITS.sells}
          placeholder={t("onb.shop.sellsPh")}
          value={d.sells}
          onChange={edit("sells")}
          aria-describedby="frun-sells-help"
          data-testid="frun-sells"
        />
        <span className="help" id="frun-sells-help">
          {t("onb.shop.sellsHelp")}
        </span>
      </div>
      <div className="field" role="group" aria-labelledby="frun-where" aria-describedby="frun-where-help">
        <span className="lab" id="frun-where">
          {t("onb.shop.where")}
        </span>
        <div className="fchips">
          {CHANNELS.map((c) => (
            <button
              key={c}
              type="button"
              className="fchip"
              aria-pressed={d.places.includes(c)}
              id={`frun-place-${c}`}
              onClick={() => onEvent({ type: "place", channel: c })}
              data-testid={`frun-place-${c}`}
            >
              {t(CHANNEL_WORDS[c].name)}
            </button>
          ))}
        </div>
        {/* Live, as the canvas's note under the chips is: the error a refused Next puts here is read out where it
            appears, because the keyboard lands on the first chip, not on this line. */}
        <span className={bad("places") ? "help err" : "help"} id="frun-where-help" aria-live="polite">
          {bad("places") ? t("onb.shop.whereErr") : t("onb.shop.whereHelp")}
        </span>
      </div>
    </>
  );
}

function ChannelStep({ d, bad, onEvent }: { d: ShopProfile; bad: (p: Problem) => boolean; onEvent: (e: FlowEvent) => void }) {
  // A radio group is one stop for Tab: the picked place, or the first while none is, and the arrow keys move the pick.
  const move = (from: Channel) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const to = radioMove(d.places, from, e.key);
    if (!to) return;
    e.preventDefault();
    onEvent({ type: "main", channel: to });
    document.getElementById(`frun-main-${to}`)?.focus();
  };
  return (
    <>
      <div className="part">
        <div className="band">
          <span id="frun-ch-h">{t("onb.channel.band")}</span>
          <span>{t("onb.channel.notYet")}</span>
        </div>
        <div className="rads" role="radiogroup" aria-labelledby="frun-ch-h" aria-describedby="frun-main-help">
          {d.places.map((c, i) => {
            const on = d.main === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                className="rad"
                aria-checked={on}
                tabIndex={on || (!d.main && i === 0) ? 0 : -1}
                id={`frun-main-${c}`}
                onClick={() => onEvent({ type: "main", channel: c })}
                onKeyDown={move(c)}
                data-testid={`frun-main-${c}`}
              >
                <span>
                  {t(CHANNEL_WORDS[c].full)}
                  <small>{t(CHANNEL_WORDS[c].note)}</small>
                </span>
              </button>
            );
          })}
        </div>
        <span className={bad("main") ? "help err" : "help"} id="frun-main-help" aria-live="polite">
          {bad("main") ? t("onb.channel.err") : ""}
        </span>
      </div>
      <p className="fnote">{t("onb.channel.hint")}</p>
    </>
  );
}

function TeamStep({ d, team }: { d: ShopProfile; team: TeamIntro[] }) {
  return (
    <>
      <div className="part">
        <div className="band">
          <span>{t("onb.team.band", { shop: d.shop.trim() || t("onb.team.yourShop") })}</span>
          <span>{t("onb.team.drafts")}</span>
        </div>
        {team.length ? (
          <ul className="rows">
            {team.map((m) => (
              <li key={m.name} className="rowl" data-testid={`frun-team-${m.name}`}>
                {/* The app's own avatars, as the Team page draws them: the canvas's drawn faces are not in the app yet. */}
                <Avatar bot={m.name} size={40} />
                <span className="grow">
                  <span className="l1">
                    {`${m.displayName} `}
                    <span className="mut">{m.description}</span>
                  </span>
                  <span className="l2">{practiceNote(m.role, d.places)}</span>
                </span>
                <span className="tag">{t("onb.team.practice")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="none">{t("team.emptyText")}</p>
        )}
      </div>
      <p className="fnote">{t("onb.team.hint")}</p>
    </>
  );
}

export function OnboardingView({ flow, lang, team, onEvent, onLang, onEnd }: OnboardingViewProps) {
  const { screen, draft: d, problems } = flow;
  const bad = (p: Problem) => problems.includes(p);
  // A new screen takes the keyboard to its heading, so a screen reader reads where the person now is and Tab starts
  // from the top. The first screen keeps the page's own start.
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    document.getElementById("frun-title")?.focus();
  }, [screen]);

  if (screen === "welcome") {
    return (
      <div className="frun welcome" data-testid="first-run" data-screen="welcome" lang={lang}>
        <Welcome lang={lang} onEvent={onEvent} onLang={onLang} />
      </div>
    );
  }

  const next = (e: FormEvent) => {
    e.preventDefault();
    const missing = problemsOf(screen, d);
    onEvent({ type: "next" });
    // A refused Next leaves the person on what is missing first; its error is that control's description.
    if (missing.length) document.getElementById(problemTarget(missing[0], d))?.focus();
  };
  const at = STEPS.indexOf(screen);
  return (
    <div className="frun" data-testid="first-run" data-screen={screen} lang={lang}>
      <header className="top">
        <div className="fbrand">
          <BrandMark size={28} />
          <span>Manut AI</span>
        </div>
        <ol className="stepper" aria-label={t("onb.steps")}>
          {STEPS.map((st, i) => {
            const mark = stepMark(st, screen);
            return (
              <li key={st} className={mark ? `stp ${mark}` : "stp"} aria-current={mark === "now" ? "step" : undefined}>
                <i>{i + 1}</i>
                {t(STEP_LABEL[st])}
              </li>
            );
          })}
        </ol>
        <div className="acts">
          <span className="count">{t("onb.stepOf", { n: at + 1, total: STEPS.length })}</span>
        </div>
      </header>
      {/* One form per step, so Enter in a field is the step's Next, as the browser does for any form. */}
      <form className="col" noValidate onKeyDown={holdImeEnter} onSubmit={next}>
        <div>
          <h1 id="frun-title" tabIndex={-1}>
            {t(TITLE[screen])}
          </h1>
          <p className="lead">{t(LEAD[screen])}</p>
        </div>
        {screen === "shop" ? (
          <ShopStep d={d} bad={bad} onEvent={onEvent} />
        ) : screen === "channel" ? (
          <ChannelStep d={d} bad={bad} onEvent={onEvent} />
        ) : (
          <TeamStep d={d} team={team} />
        )}
        {/* The canvas's row: Back on the left, then Skip for now and Next on the right, and Open Manut AI on the last
            step. Back on Your shop returns to Welcome. Skip for now ends the setup and lands on Home, keeping what was
            typed; it is left off the last step, where Open Manut AI does the same. */}
        <div className="foot" data-testid="frun-foot">
          <button type="button" className="btn" onClick={() => onEvent({ type: "back" })} data-testid="frun-back">
            {t("onb.back")}
          </button>
          <span className="sp" />
          {screen === "team" ? (
            <button type="button" className="btn dark" onClick={onEnd} data-testid="frun-open">
              {t("onb.open")}
            </button>
          ) : (
            <>
              <button type="button" className="lk" onClick={onEnd} data-testid="frun-skip">
                {t("onb.skip")}
              </button>
              <button type="submit" className="btn dark" data-testid="frun-next">
                {t("onb.next")}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

/** The members Your team introduces, from the runtime's listed team (practiceTeam finds them by name). */
export function teamIntros(bots: readonly { name: string; display_name: string; description: string }[]): TeamIntro[] {
  return practiceTeam(bots).map(({ bot, role }) => ({ name: bot.name, displayName: bot.display_name, description: bot.description, role }));
}

/** The setup on the app's store. App.tsx draws it in place of the window while the store holds a setup. */
export function Onboarding() {
  const s = useStore();
  const flow = s.ui.firstRun;
  if (!flow) return null;
  return (
    <OnboardingView
      flow={flow}
      lang={s.ui.lang}
      team={teamIntros(selectSidebarBots(s))}
      onEvent={s.firstRunDo}
      onLang={s.setLanguage}
      onEnd={s.firstRunEnd}
    />
  );
}
