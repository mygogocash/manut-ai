// "The main branch moved", drawn with react-dom/server from props, and its buttons read from the elements it returns (the
// view uses no hooks; its two sides are drawn by the diff view, which has). The project is the canvas's baanmali-preorder.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { LISTED, MainMovedView, type MainMovedProps } from "./MainMoved";
import { diffOf, type Moved, type Side } from "./moved";

const moved: Moved = { branch: "kit/promptpay-qr", base: "main", files: ["src/checkout.tsx"] };

const props = (over: Partial<MainMovedProps> = {}): MainMovedProps => ({ moved, both: { state: "closed" }, onMerge: vi.fn(), onShow: vi.fn(), ...over });

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byId = (p: MainMovedProps, id: string) => drawn(MainMovedView(p)).filter((e) => e.props["data-testid"] === id);
const html = (p: MainMovedProps) => renderToString(createElement(MainMovedView, p));

const DIFF = (body: string[]) => ["diff --git a/src/checkout.tsx b/src/checkout.tsx", "--- a/src/checkout.tsx", "+++ b/src/checkout.tsx", "@@ -1,2 +1,3 @@", " keep", ...body, ""].join("\n");
const side = (theirs: string[], ours: string[]): Side => ({ path: "src/checkout.tsx", theirs: diffOf("src/checkout.tsx", DIFF(theirs)), ours: diffOf("src/checkout.tsx", DIFF(ours)) });

afterEach(() => setLang("en"));

describe("the line, the files and the two buttons", () => {
  it("says what the canvas says for one file", () => {
    const out = html(props());
    expect(out).toContain("main changed while Kit worked. 1 file needs both changes.");
    expect(out).toContain("src/checkout.tsx");
    expect(out).toContain("Let Kit merge");
    expect(out).toContain("Show me both");
    expect(out).toContain("Kit can merge, and shows the result as a diff before anything is pushed.");
  });

  it("counts the files when several need both changes, and names the branch the lane started from", () => {
    const out = html(props({ moved: { branch: "kit/x", base: "master", files: ["a.ts", "b.ts", "c.ts"] } }));
    expect(out).toContain("master changed while Kit worked. 3 files need both changes.");
    for (const f of ["a.ts", "b.ts", "c.ts"]) expect(out).toContain(f);
  });

  it("lists the first files and counts the rest", () => {
    const files = Array.from({ length: LISTED + 4 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    const out = html(props({ moved: { ...moved, files } }));
    expect(out).toContain(files[LISTED - 1]);
    expect(out).not.toContain(files[LISTED]);
    expect(out).toContain("and 4 more files");
  });

  it("sends the ask with Let Kit merge, and opens or closes both sides with Show me both", () => {
    const p = props();
    (byId(p, "kit-moved-merge")[0].props.onClick as () => void)();
    (byId(p, "kit-moved-show")[0].props.onClick as () => void)();
    expect(p.onMerge).toHaveBeenCalledTimes(1);
    expect(p.onShow).toHaveBeenCalledTimes(1);
  });

  it("is in all four languages", () => {
    for (const [lang, words] of [["ko", "양쪽 다 보기"], ["ja", "両方を見る"], ["zh", "两边都看看"]] as const) {
      setLang(lang);
      expect(html(props()), lang).toContain(words);
    }
  });
});

describe("both sides", () => {
  it("is closed until asked for: the button says Show me both and nothing is read", () => {
    const out = html(props());
    expect(out).not.toContain("What main changed");
    expect(byId(props(), "kit-moved-show")[0].props["aria-expanded"]).toBe(false);
  });

  it("says it is reading them, and when it could not", () => {
    expect(html(props({ both: { state: "loading" } }))).toContain("Reading both sides…");
    expect(html(props({ both: { state: "failed" } }))).toContain("Could not read the two sides. Try again in a moment.");
    expect(html(props({ both: { state: "loading" } }))).toContain("Hide both");
  });

  it("shows what main changed beside what Kit changed, for each file", () => {
    const out = html(props({ both: { state: "open", sides: [side(["-  const total = 1;", "+  const total = 1 + shipping(order);"], ["-  const total = 1;", "+  const total = 2;"])] } }));
    expect(out).toContain("What main changed");
    expect(out).toContain("What Kit changed");
    expect(out).toContain("const total = 1 + shipping(order);");
    expect(out).toContain("const total = 2;");
    expect(out).toContain("Hide both");
    // one heading for the file, and one diff for each side
    expect(out.match(/data-testid="kit-moved-pair"/g)).toHaveLength(1);
    expect(out.match(/data-testid="diff-view"/g)).toHaveLength(2);
  });

  it("never shows a key that is in a diff", () => {
    const key = `ghp_${"a".repeat(36)}`;
    const out = html(props({ both: { state: "open", sides: [side([`+token=${key}`], [`+const k = "${key}";`])] } }));
    expect(out).not.toContain("a".repeat(36));
    expect(out).toContain("••••");
  });

  it("says a file is not text, rather than drawing nothing", () => {
    const png = diffOf("logo.png", "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n");
    const out = html(props({ both: { state: "open", sides: [{ path: "logo.png", theirs: png, ours: png }] } }));
    expect(out).toContain("This is not a text file, so its changes can&#x27;t be shown.");
  });
});
