// English: the source. Each area's keys are in a file of their own, en/<prefix>.ts, named after the keys' prefix,
// and ko, ja and zh mirror each file key for key (README.md says how to add keys and areas). This file only puts
// the areas together, so `en` stays one object and `Key` every key.
import { ab } from "./en/ab";
import { acc } from "./en/acc";
import { acct } from "./en/acct";
import { act } from "./en/act";
import { ag } from "./en/ag";
import { art } from "./en/art";
import { ask } from "./en/ask";
import { att } from "./en/att";
import { auto } from "./en/auto";
import { aw } from "./en/aw";
import { awake } from "./en/awake";
import { bb } from "./en/bb";
import { bot } from "./en/bot";
import { box } from "./en/box";
import { brief } from "./en/brief";
import { bub } from "./en/bub";
import { buddy } from "./en/buddy";
import { card } from "./en/card";
import { carry } from "./en/carry";
import { chat } from "./en/chat";
import { cmp } from "./en/cmp";
import { cn } from "./en/cn";
import { computer } from "./en/computer";
import { conn } from "./en/conn";
import { cont } from "./en/cont";
import { copy } from "./en/copy";
import { ctl } from "./en/ctl";
import { customize } from "./en/customize";
import { dev } from "./en/dev";
import { diff } from "./en/diff";
import { disk } from "./en/disk";
import { dock } from "./en/dock";
import { drafts } from "./en/drafts";
import { dw } from "./en/dw";
import { editor } from "./en/editor";
import { ew } from "./en/ew";
import { failed } from "./en/failed";
import { fb } from "./en/fb";
import { find } from "./en/find";
import { gate } from "./en/gate";
import { google } from "./en/google";
import { graph } from "./en/graph";
import { harness } from "./en/harness";
import { head } from "./en/head";
import { history } from "./en/history";
import { home } from "./en/home";
import { id } from "./en/id";
import { imp } from "./en/imp";
import { inbox } from "./en/inbox";
import { job } from "./en/job";
import { key } from "./en/key";
import { kit } from "./en/kit";
import { lane } from "./en/lane";
import { lang } from "./en/lang";
import { later } from "./en/later";
import { list } from "./en/list";
import { live } from "./en/live";
import { lk } from "./en/lk";
import { look } from "./en/look";
import { make } from "./en/make";
import { mark } from "./en/mark";
import { mcp } from "./en/mcp";
import { md } from "./en/md";
import { memory } from "./en/memory";
import { mention } from "./en/mention";
import { menu } from "./en/menu";
import { mode } from "./en/mode";
import { mp } from "./en/mp";
import { nav } from "./en/nav";
import { needs } from "./en/needs";
import { note } from "./en/note";
import { older } from "./en/older";
import { omh } from "./en/omh";
import { omhp } from "./en/omhp";
import { onb } from "./en/onb";
import { out } from "./en/out";
import { outpost } from "./en/outpost";
import { outposts } from "./en/outposts";
import { owners } from "./en/owners";
import { page } from "./en/page";
import { pal } from "./en/pal";
import { panel } from "./en/panel";
import { paste } from "./en/paste";
import { pause } from "./en/pause";
import { peer } from "./en/peer";
import { people } from "./en/people";
import { pl } from "./en/pl";
import { plan } from "./en/plan";
import { plans } from "./en/plans";
import { plug } from "./en/plug";
import { pn } from "./en/pn";
import { pr } from "./en/pr";
import { proj } from "./en/proj";
import { prov } from "./en/prov";
import { prs } from "./en/prs";
import { pull } from "./en/pull";
import { pv } from "./en/pv";
import { resume } from "./en/resume";
import { review } from "./en/review";
import { risk } from "./en/risk";
import { rm } from "./en/rm";
import { rn } from "./en/rn";
import { routines } from "./en/routines";
import { row } from "./en/row";
import { rp } from "./en/rp";
import { rs } from "./en/rs";
import { rt } from "./en/rt";
import { run } from "./en/run";
import { rw } from "./en/rw";
import { sched } from "./en/sched";
import { sessions } from "./en/sessions";
import { set } from "./en/set";
import { shops } from "./en/shops";
import { side } from "./en/side";
import { skills } from "./en/skills";
import { skl } from "./en/skl";
import { sounds } from "./en/sounds";
import { split } from "./en/split";
import { sq } from "./en/sq";
import { sqs } from "./en/sqs";
import { src } from "./en/src";
import { ss } from "./en/ss";
import { st } from "./en/st";
import { stash } from "./en/stash";
import { sub } from "./en/sub";
import { suggest } from "./en/suggest";
import { tailscale } from "./en/tailscale";
import { tasks } from "./en/tasks";
import { team } from "./en/team";
import { term } from "./en/term";
import { termpanel } from "./en/termpanel";
import { think } from "./en/think";
import { thread } from "./en/thread";
import { time } from "./en/time";
import { titles } from "./en/titles";
import { tl } from "./en/tl";
import { tlink } from "./en/tlink";
import { tmenu } from "./en/tmenu";
import { tray } from "./en/tray";
import { tshare } from "./en/tshare";
import { ty } from "./en/ty";
import { ui } from "./en/ui";
import { unit } from "./en/unit";
import { upd } from "./en/upd";
import { update } from "./en/update";
import { use } from "./en/use";
import { vault } from "./en/vault";
import { voice } from "./en/voice";
import { watch } from "./en/watch";
import { wf } from "./en/wf";
import { win } from "./en/win";
import { worktrees } from "./en/worktrees";
import { zone } from "./en/zone";

export const en = {
  ...ab,
  ...acc,
  ...acct,
  ...act,
  ...ag,
  ...art,
  ...ask,
  ...att,
  ...auto,
  ...aw,
  ...awake,
  ...bb,
  ...bot,
  ...box,
  ...brief,
  ...bub,
  ...buddy,
  ...card,
  ...carry,
  ...chat,
  ...cmp,
  ...cn,
  ...computer,
  ...conn,
  ...cont,
  ...copy,
  ...ctl,
  ...customize,
  ...dev,
  ...diff,
  ...disk,
  ...dock,
  ...drafts,
  ...dw,
  ...editor,
  ...ew,
  ...failed,
  ...fb,
  ...find,
  ...gate,
  ...google,
  ...graph,
  ...harness,
  ...head,
  ...history,
  ...home,
  ...id,
  ...imp,
  ...inbox,
  ...job,
  ...key,
  ...kit,
  ...lane,
  ...lang,
  ...later,
  ...list,
  ...live,
  ...lk,
  ...look,
  ...make,
  ...mark,
  ...mcp,
  ...md,
  ...memory,
  ...mention,
  ...menu,
  ...mode,
  ...mp,
  ...nav,
  ...needs,
  ...note,
  ...older,
  ...omh,
  ...omhp,
  ...onb,
  ...out,
  ...outpost,
  ...outposts,
  ...owners,
  ...page,
  ...pal,
  ...panel,
  ...paste,
  ...pause,
  ...peer,
  ...people,
  ...pl,
  ...plan,
  ...plans,
  ...plug,
  ...pn,
  ...pr,
  ...proj,
  ...prov,
  ...prs,
  ...pull,
  ...pv,
  ...resume,
  ...review,
  ...risk,
  ...rm,
  ...rn,
  ...routines,
  ...row,
  ...rp,
  ...rs,
  ...rt,
  ...run,
  ...rw,
  ...sched,
  ...sessions,
  ...set,
  ...shops,
  ...side,
  ...skills,
  ...skl,
  ...sounds,
  ...split,
  ...sq,
  ...sqs,
  ...src,
  ...ss,
  ...st,
  ...stash,
  ...sub,
  ...suggest,
  ...tailscale,
  ...tasks,
  ...team,
  ...term,
  ...termpanel,
  ...think,
  ...thread,
  ...time,
  ...titles,
  ...tl,
  ...tlink,
  ...tmenu,
  ...tray,
  ...tshare,
  ...ty,
  ...ui,
  ...unit,
  ...upd,
  ...update,
  ...use,
  ...vault,
  ...voice,
  ...watch,
  ...wf,
  ...win,
  ...worktrees,
  ...zone,
};
