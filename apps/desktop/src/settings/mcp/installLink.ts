// Installing skills from a link (item 84), the page's own logic, kept apart so it can be tested without a page: whether a link is on
// the artifact origin before the shell is asked anything, and what each refusal says. The shell checks the link again and is the
// only one that fetches or writes (src-tauri/src/skill_links.rs).
import { t } from "../../i18n";
import { bundleWords } from "../../runtime/http/artifacts";
import { agentLabel } from "../../sessions/agents";

const LINK_PATH = /^\/a\/[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{32}(\.json)?$/;

/** Whether `link` is a skill link on `origin`: https, the same host and port, no user name, `/a/<shop>.<secret>` and nothing after
 *  it. Anything else is refused here with nothing fetched. */
export function linkOnOrigin(link: string, origin: string | null): boolean {
  if (!origin) return false;
  let l: URL;
  let o: URL;
  try {
    l = new URL(link.trim());
    o = new URL(origin);
  } catch {
    return false;
  }
  return l.protocol === "https:" && o.protocol === "https:" && l.host.toLowerCase() === o.host.toLowerCase() && !l.username && !l.password &&
    !l.search && !l.hash && !link.trim().endsWith("?") && !link.trim().endsWith("#") && LINK_PATH.test(l.pathname);
}

/** What the page says when reading a link or installing from it was refused, by the shell's code. */
export function installWords(code: string, agent: "claude" | "codex" = "claude"): string {
  const [head, rest] = [code.split(":")[0] ?? "", code.split(":").slice(1).join(":")];
  switch (head) {
    case "other_host":
    case "not_a_link":
      return t("skl.in.otherHost");
    case "no_origin":
      return t("skl.in.noOrigin");
    case "not_found":
      return t("skl.in.notFound");
    case "rate_limited":
      return t("skl.in.rateLimited");
    case "offline":
      return t("rt.offline");
    case "bad_bundle":
      // The shell names only the rule a fetched bundle broke, not the file: the whole link is refused.
      return rest === "too_many_skills" || rest === "too_many_files" ? bundleWords({ reason: rest }) : t("skl.in.badBundle");
    case "exists":
      return t("skl.in.exists", { agent: agentLabel(agent, null), name: rest });
    case "link_root":
    case "not_a_folder":
      return t("skl.in.linkRoot", { agent: agentLabel(agent, null) });
    case "expired":
    case "withdrawn":
    case "already_decided":
      return t("skl.in.askGone");
    case "not_reviewed":
      return t("skl.err.notReviewed");
    default:
      return t("skl.in.unavailable");
  }
}
