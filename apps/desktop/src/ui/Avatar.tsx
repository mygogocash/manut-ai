import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { chatTarget, getStore } from "../state/store";
import { BUDDY, EXTRA, FACE_SIZES, HAIR, faceBox, faceStateIn, lookIn, type FaceLook, type FaceState } from "./face";
import "./face.css";

// The bot's own picture (Hermes keeps it in the profile as assets/avatar.*), fetched once per revision
// and shared by every <Avatar> of that bot.
const cache = new Map<string, Promise<string | null>>();
const ready = new Map<string, string | null>();

function pictureOf(bot: string, rev: number): Promise<string | null> {
  const key = `${bot}:${rev}`;
  let p = cache.get(key);
  if (!p) {
    p = getStore()
      .actions.avatarOf(bot)
      .then((r) => r.data)
      .catch(() => null)
      .then((d) => {
        ready.set(key, d);
        return d;
      });
    cache.set(key, p);
  }
  return p;
}

/** The member's own picture when they have one, else null (the drawn face). */
function useOwnPicture(bot: string): string | null {
  // subscribe to this bot's picture revision only: a face beside every bubble must not re-render on
  // each streamed token the way a whole-store subscription does
  const st = getStore();
  const revOf = () => st.getSnapshot().bots.find((b) => b.name === bot)?.avatar_rev ?? null;
  const rev = useSyncExternalStore(st.subscribe, revOf, revOf);
  const [own, setOwn] = useState<string | null>(rev === null ? null : ready.get(`${bot}:${rev}`) ?? null);
  useEffect(() => {
    if (rev === null) {
      setOwn(null);
      return;
    }
    let live = true;
    setOwn(ready.get(`${bot}:${rev}`) ?? null);
    void pictureOf(bot, rev).then((d) => {
      if (live) setOwn(d);
    });
    return () => {
      live = false;
    };
  }, [bot, rev]);
  return own;
}

/** The member's look and, when `live`, the state their face shows. Each is the same value until it changes (face.ts keeps
 *  them per store change), so a face re-renders when its member's look or state changes, never on a streamed token. */
function useFace(bot: string, live: boolean): { look: FaceLook; st: FaceState | null } {
  const s = getStore();
  const lookNow = () => lookIn(s.getSnapshot(), bot);
  const stNow = () => (live ? faceStateIn(s.getSnapshot(), bot) : null);
  const look = useSyncExternalStore(s.subscribe, lookNow, lookNow);
  const st = useSyncExternalStore(s.subscribe, stNow, stNow);
  return { look, st };
}

/** The kit's face (KitFaces' markup, word for word): the frame, then the body (the tile in the member's colour, the head
 *  and hair in the mark's ink, the ear, eye, tick, mouth and extra cut out in the tile's colour), the signs in front of
 *  the face, and the badge. With a picture of their own, the body is the tile with the picture on it ("Your picture"),
 *  and the frame, signs and badge work the same. */
function FaceSvg({ look, picture }: { look: FaceLook; picture: string | null }) {
  const clip = `fc${useId().replace(/[^\w-]/g, "")}`;
  const { fill } = look;
  return (
    <svg viewBox="0 0 56 56">
      <rect className="fr" x="2.5" y="2.5" width="51" height="51" rx="13.4" pathLength="100" />
      {picture ? (
        <g className="fbody">
          <rect className="fg" x="6" y="6" width="44" height="44" rx="9.9" fill={fill} />
          <clipPath id={clip}>
            <rect x="6" y="6" width="44" height="44" rx="9.9" />
          </clipPath>
          <image href={picture} x="6" y="6" width="44" height="44" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clip})`} />
        </g>
      ) : (
        <g className="fbody">
          <rect className="fg" x="6" y="6" width="44" height="44" rx="9.9" fill={fill} />
          <path
            className="fs"
            d="M21.98 20.44C21.47 22.84 21.12 23.88 20.61 25.42C19.92 26.97 18.55 28 17.86 29.2C17.52 29.89 18.2 30.41 19.75 30.58C20.09 31.09 19.58 31.61 19.58 32.12C19.58 32.64 20.44 32.64 20.44 32.98C20.44 33.5 19.58 33.67 19.75 34.36C19.92 35.05 20.61 35.05 20.61 35.73C20.78 37.45 21.3 39.17 23.53 39.69C25.08 40.03 26.62 39.69 27.66 39.34C28.17 41.23 28 42.95 27.14 44.16C24.56 45.19 18.89 46.22 16.48 50L40.1 50A9.9 9.9 0 0 0 50 40.1L50 37.97C46.39 37.45 42.78 36.59 40.72 34.36C43.81 32.81 45.7 28.52 45.36 23.7C45.02 17.17 40.03 12.7 33.33 12.7C27.48 12.7 23.19 15.97 21.98 20.44Z"
          />
          <path className="fh" d={HAIR[look.hair]} stroke={fill} />
          <g className="fd" fill={fill} stroke={fill}>
            <path className="fa" d="M31.09 26.8C33.16 25.94 34.7 27.83 34.02 29.89C33.5 31.44 31.61 31.78 30.75 30.58" />
            <circle className="fe" cx="24.22" cy="26.11" r="1.6" />
            <path className="fl" d="M22.84 26.45Q24.22 27.66 25.59 26.45" />
            <path className="fk" d="M22.5 25.94L23.7 27.14L25.94 24.56" />
            <path className="fn" d="M23.02 26.45L25.59 26.45" />
            <ellipse className="fm" cx="21.2" cy="32.7" rx="1.1" ry=".55" />
            <path className="fx" d={EXTRA[look.extra]} />
          </g>
        </g>
      )}
      <g className="fo">
        <g className="o-dots">
          <circle cx="17.5" cy="18.4" r="1.2" />
          <circle cx="14" cy="14.4" r="1.6" />
          <circle cx="10.9" cy="10.6" r="2" />
        </g>
        <path className="o-z" d="M10 9.5h4.2l-4.2 4.8h4.2" />
        <path className="o-wave" d="M13.6 25.5q-2.2 3.7 0 7.4M10.4 23.3q-3.6 5.9 0 11.8" />
        <path className="o-spark" d="M14 8.6v3.2M9.6 11.2l2.3 1.6M18.4 11.2l-2.3 1.6" />
      </g>
      <g className="fb">
        <circle cx="46" cy="46" r="7.5" />
        <path className="b-ask" d="M43.4 43.9a2.6 2.6 0 1 1 3.9 2.2c-.8.45-1.3.9-1.3 1.8M46 50.3v.1" />
        <path className="b-done" d="M42.6 46.3l2.3 2.3 4.4-4.8" />
        <path className="b-stuck" d="M46 42.2v4.6M46 49.6v.1" />
        <path className="b-pause" d="M44.2 43.2v5.6M47.8 43.2v5.6" />
      </g>
    </svg>
  );
}

/** Buddy's blue face, as the boards draw Buddy beside the team's faces (Report, Updates): the mark's blue, two eyes and a
 *  smile, filling the footprint. Buddy keeps it (AUTHORING.md, "Team faces"). */
function BuddyFace() {
  return (
    <svg className="buddy-face" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="13" fill="#4DA3FF" />
      <circle cx="10" cy="12.5" r="1.7" fill="#111110" />
      <circle cx="18" cy="12.5" r="1.7" fill="#111110" />
      <path d="M10 17.5c1.1 1.2 2.4 1.8 4 1.8s2.9-.6 4-1.8" fill="none" stroke="#111110" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** A team member's face, `size` px square: the brand's drawn face on the member's own colour (face.ts), their own picture
 *  on that tile when they have one, or Buddy's blue face. The box keeps exactly `size`, as the picture it replaces did; the
 *  face's frame and badge spill past it without moving anything.
 *
 *  `live`: the face shows what the member is doing (the kit's `data-st`, from the Team page's own status rule). Only where
 *  the status word is written beside the face, as the kit's rule asks ("The face never carries a meaning on its own"):
 *  the Team page, Home's Working now and Needs you, and the Needs you page and list. Everywhere else (a message, History,
 *  Settings) it is the member's plain face, so a chat of twenty replies never runs twenty frames. */
export function Avatar({ bot: key, size = 32, className, live = false }: { bot: string; size?: number; className?: string; live?: boolean }) {
  // a thread's or a folder chat's key (`fold:<member>:<id>`, an ask from one) draws its member's face
  const bot = chatTarget(key).bot;
  const own = useOwnPicture(bot);
  const { look, st } = useFace(bot, live);
  const cls = `ui-av${className ? ` ${className}` : ""}`;
  const box = { width: size, height: size };
  if (bot === BUDDY && !own) {
    return (
      <span className={cls} style={box} data-face="buddy">
        <BuddyFace />
      </span>
    );
  }
  const kit = FACE_SIZES[size];
  const fit = kit === undefined ? faceBox(size) : null;
  return (
    <span className={cls} style={box} data-own={own ? "1" : undefined} data-face={bot}>
      <span
        className={kit ? `face ${kit}` : "face"}
        data-st={st ?? undefined}
        aria-hidden="true"
        style={fit ? { width: fit.width, height: fit.height, margin: fit.margin } : undefined}
      >
        <FaceSvg look={look} picture={own} />
      </span>
    </span>
  );
}
