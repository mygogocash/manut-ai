import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MentionLink, useMentions } from "./Mention";
import { remarkMentions } from "./remarkMentions";
import { isBare, LinkChip } from "./LinkChip";
import { keepTermLinks, remarkTermLinks } from "./remarkTermLinks";
import { TermLinkChip } from "./TermLinkChip";
import { parseTermLink } from "../../sessions/termLink";
import { CopyButton } from "./Copy";
import { DrawableCode } from "../drawing/Drawing";
import { drawableFence } from "../drawing/drawingDoc";

const plain = [remarkGfm, remarkTermLinks];

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

/** Plain text inside an element, for deciding how to emphasise it. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/** A fenced block's language, from the `language-*` class remark gives its code element. */
function fenceOf(node: unknown): string | null {
  const code = (node as { children?: { tagName?: string; properties?: { className?: unknown } }[] } | undefined)?.children?.[0];
  if (code?.tagName !== "code") return null;
  const names = Array.isArray(code.properties?.className) ? (code.properties!.className as unknown[]) : [];
  const lang = names.map(String).find((c) => c.startsWith("language-"));
  return lang ? lang.slice("language-".length) : null;
}

/** Bot markdown. Inside a MentionContext (the app), `@name` of a known bot opens that bot's chat. `drawingsBy`: a finished
 *  answer in a chat's timeline, whose html and svg blocks offer Show drawing by that member or agent (src/chat/drawing/);
 *  nowhere else does: an ask, an approval card, a task or a run's drawer never pass it. */
export const Markdown = memo(function Markdown({ text, drawingsBy }: { text: string; drawingsBy?: string }) {
  const resolve = useMentions()?.resolve;
  const plugins = useMemo(() => (resolve ? [remarkGfm, remarkTermLinks, [remarkMentions, { resolve }] as const] : plain), [resolve]);
  return (
    <ReactMarkdown
      remarkPlugins={plugins as typeof plain}
      urlTransform={keepTermLinks}
      components={{
        // a bare URL becomes a chip (service mark + short label); a link with its own text keeps it, after the mark
        // an manut terminal link: the manut chip (the session's mark, title and state), its own text kept as the label
        a: ({ node: _n, href, children, ...p }) =>
          href && parseTermLink(href) ? (
            <TermLinkChip url={href} label={textOf(children).trim() && textOf(children).trim() !== href ? textOf(children).trim() : undefined} />
          ) : href && /^https?:\/\//i.test(href) ? (
            <LinkChip url={href}>{isBare(href, textOf(children)) ? undefined : children}</LinkChip>
          ) : (
            <a {...p} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        span: ({ node: _n, ...p }) => {
          const bot = (p as Record<string, unknown>)["data-mention"];
          return typeof bot === "string" ? <MentionLink bot={bot}>{p.children}</MentionLink> : <span {...p} />;
        },
        // a code block: its own copy control in the corner, shown on hover; an html or svg one in a finished answer also
        // offers Show drawing under it
        pre: ({ node, children, ...p }) => {
          const block = (
            <div className="md-pre">
              <pre {...p}>{children}</pre>
              <CopyButton className="md-pre-copy" text={() => textOf(children).replace(/\n$/, "")} testId="copy-code" />
            </div>
          );
          if (!drawingsBy || !drawableFence(fenceOf(node))) return block;
          return (
            <DrawableCode code={textOf(children).replace(/\n$/, "")} by={drawingsBy}>
              {block}
            </DrawableCode>
          );
        },
        // Hangul has no italic face; a synthetic slant reads as broken, so emphasis there is weight instead
        em: ({ node: _n, children, ...p }) => (
          <em {...p} className={HANGUL.test(textOf(children)) ? "hangul" : undefined}>
            {children}
          </em>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});
