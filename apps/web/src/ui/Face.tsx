/// A team member's face, drawn exactly as AUTHORING.md's markup: a profile cut like the brand mark, on the
/// member's own colour, with the frame and badge saying what they are doing. A member without a drawn look
/// gets the initial form of the same face.

export type FaceState = "idle" | "listen" | "think" | "do" | "solve" | "write" | "ask" | "done" | "stuck" | "pause";

type Look = { colour: string; hair: string; extra: string };

const SILHOUETTE =
  "M21.98 20.44C21.47 22.84 21.12 23.88 20.61 25.42C19.92 26.97 18.55 28 17.86 29.2C17.52 29.89 18.2 30.41 19.75 30.58C20.09 31.09 19.58 31.61 19.58 32.12C19.58 32.64 20.44 32.64 20.44 32.98C20.44 33.5 19.58 33.67 19.75 34.36C19.92 35.05 20.61 35.05 20.61 35.73C20.78 37.45 21.3 39.17 23.53 39.69C25.08 40.03 26.62 39.69 27.66 39.34C28.17 41.23 28 42.95 27.14 44.16C24.56 45.19 18.89 46.22 16.48 50L40.1 50A9.9 9.9 0 0 0 50 40.1L50 37.97C46.39 37.45 42.78 36.59 40.72 34.36C43.81 32.81 45.7 28.52 45.36 23.7C45.02 17.17 40.03 12.7 33.33 12.7C27.48 12.7 23.19 15.97 21.98 20.44Z";

const HAIR = {
  short:
    "M21.64 21.12C21.81 15.45 26.97 10.98 33.67 10.98C41.23 10.98 46.39 16.14 46.39 23.53C46.39 27.83 45.19 30.92 43.47 32.81C42.78 30.58 41.92 28.52 40.72 27.48C40.89 25.42 40.03 23.7 38.48 23.19C35.73 22.5 33.67 20.95 31.09 20.09C28.17 19.23 25.42 19.75 23.7 21.12C23.02 21.64 22.16 21.81 21.64 21.12Z",
  bun: "M21.64 21.12C21.81 15.45 26.97 10.98 33.67 10.98C36.25 10.98 38.66 11.5 40.55 12.53C40.55 9.61 43.81 8.06 46.05 9.44C48.11 10.81 47.77 14.42 45.53 15.45C46.05 18.03 46.56 20.61 46.39 23.53C46.39 27.83 45.19 30.92 43.47 32.81C42.78 30.58 41.92 28.52 40.72 27.48C40.89 25.42 40.03 23.7 38.48 23.19C35.73 22.5 33.67 20.95 31.09 20.09C28.17 19.23 25.42 19.75 23.7 21.12C23.02 21.64 22.16 21.81 21.64 21.12Z",
  swoop:
    "M21.47 21.64C18.89 19.75 18.89 15.62 21.98 13.39C25.08 10.98 30.92 9.78 35.56 10.3C42.09 11.16 46.39 16.14 46.39 23.53C46.39 27.83 45.19 30.92 43.47 32.81C42.78 30.58 41.92 28.52 40.72 27.48C40.89 25.42 40.03 23.7 38.48 23.19C35.73 22.5 33.16 20.78 30.06 20.27C27.31 19.75 25.08 20.44 23.53 21.47C22.84 21.98 22.16 22.16 21.47 21.64Z",
  beanie:
    "M20.61 20.44C20.78 14.25 26.45 9.95 33.67 9.95C41.23 9.95 46.73 14.77 47.08 20.44L48.45 20.44C49.14 20.44 49.66 20.95 49.66 21.64L49.66 22.84C49.66 23.53 49.14 24.05 48.45 24.05L20.27 24.05C19.58 24.05 19.06 23.53 19.06 22.84L19.06 21.64C19.06 20.95 19.58 20.44 20.27 20.44ZM31.78 8.06A1.89 1.89 0 1 0 35.56 8.06A1.89 1.89 0 1 0 31.78 8.06Z",
};

const EXTRA = {
  none: "M0 0",
  glasses: "M21.47 26.11A2.75 2.75 0 1 0 26.97 26.11A2.75 2.75 0 1 0 21.47 26.11ZM26.97 25.77L31.09 26.62",
  headset:
    "M27.66 15.11C32.81 12.7 39.69 13.56 43.12 18.89M30.92 26.28L34.36 26.28L34.36 30.92L30.92 30.92ZM32.64 30.92C31.95 33.67 27.66 35.05 23.19 34.19",
};

/// The sample team's default looks (AUTHORING.md, Team faces).
const LOOKS: Record<string, Look> = {
  nam: { colour: "#CDDDEB", hair: HAIR.short, extra: EXTRA.headset },
  pim: { colour: "#DBD6EC", hair: HAIR.bun, extra: EXTRA.none },
  ton: { colour: "#CEDFCE", hair: HAIR.swoop, extra: EXTRA.glasses },
  kit: { colour: "#E6D9C2", hair: HAIR.beanie, extra: EXTRA.none },
};

export function Face({ name, state, size }: { name: string; state: FaceState; size?: "md" | "lg" }) {
  const look = LOOKS[name.trim().toLowerCase()];
  const colour = look?.colour ?? "#EDE1B6";
  return (
    <span className={size ? `face ${size}` : "face"} data-st={state} aria-hidden="true">
      <svg viewBox="0 0 56 56">
        <rect className="fr" x="2.5" y="2.5" width="51" height="51" rx="13.4" pathLength={100} />
        <g className="fbody">
          <rect className="fg" x="6" y="6" width="44" height="44" rx="9.9" fill={colour} />
          {look && (
            <>
              <path className="fs" d={SILHOUETTE} />
              <path className="fh" d={look.hair} stroke={colour} />
              <g className="fd" fill={colour} stroke={colour}>
                <path className="fa" d="M31.09 26.8C33.16 25.94 34.7 27.83 34.02 29.89C33.5 31.44 31.61 31.78 30.75 30.58" />
                <circle className="fe" cx="24.22" cy="26.11" r="1.6" />
                <path className="fl" d="M22.84 26.45Q24.22 27.66 25.59 26.45" />
                <path className="fk" d="M22.5 25.94L23.7 27.14L25.94 24.56" />
                <path className="fn" d="M23.02 26.45L25.59 26.45" />
                <ellipse className="fm" cx="21.2" cy="32.7" rx="1.1" ry=".55" />
                <path className="fx" d={look.extra} />
              </g>
            </>
          )}
        </g>
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
      {!look && <span className="fit">{name.trim().charAt(0).toUpperCase()}</span>}
    </span>
  );
}
