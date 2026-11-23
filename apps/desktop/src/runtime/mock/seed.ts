// What the in-process runtime starts with: Buddy and a small team, a few lines of history each, and the model list
// the picker shows. Everything here is staged. The names follow the design canvas's team (Nam, Pim, Ton, Kit); the
// models are labelled as a demo so nobody reads them as a real provider.
import type { BotStatus, ModelProvider, Skill, SlashCommand } from "../../lib/protocol";
import { OWNER, type ActivityEvent, type JobRecipient, type JobStage, type TraceStep } from "../mission";

export interface BotSeed {
  name: string;
  display_name: string;
  is_default: boolean;
  description: string;
  status: BotStatus;
  model: string;
  provider: string;
  reasoning: string;
}

export const DEMO_PROVIDER = "demo";

export const BOT_SEED: readonly BotSeed[] = [
  { name: "buddy", display_name: "Buddy", is_default: true, description: "Your assistant", status: "online", model: "demo-standard", provider: DEMO_PROVIDER, reasoning: "medium" },
  { name: "nam", display_name: "Nam", is_default: false, description: "Sales chat", status: "online", model: "demo-standard", provider: DEMO_PROVIDER, reasoning: "low" },
  { name: "pim", display_name: "Pim", is_default: false, description: "Content", status: "online", model: "demo-standard", provider: DEMO_PROVIDER, reasoning: "medium" },
  { name: "ton", display_name: "Ton", is_default: false, description: "Books", status: "online", model: "demo-careful", provider: DEMO_PROVIDER, reasoning: "high" },
  { name: "kit", display_name: "Kit", is_default: false, description: "Engineer", status: "online", model: "demo-careful", provider: DEMO_PROVIDER, reasoning: "high" },
];

export const PROVIDERS: readonly ModelProvider[] = [{ slug: DEMO_PROVIDER, name: "Demo runtime", models: ["demo-standard", "demo-careful"] }];
export const REASONING_LEVELS: readonly string[] = ["none", "low", "medium", "high"];

/** [role, text, seconds ago]. Kept short: the point is that a chat opens with something in it. */
export type HistorySeed = readonly ["user" | "assistant", string, number];

export const HISTORY_SEED: Readonly<Record<string, readonly HistorySeed[]>> = {
  buddy: [
    [
      "assistant",
      "Hi, I'm Buddy. This build runs on a demo runtime inside the app: nothing here reaches a real model, a real shop or a real customer.\n\nType anything for a sample answer, or try `/approve`, `/clarify`, `/interview` and `/delegate` to see how the team asks before it acts.",
      3600,
    ],
  ],
  nam: [
    ["user", "Did anyone ask about delivery today?", 2 * 3600],
    ["assistant", "Three customers did. I drafted a reply for each and I am waiting for you before anything is sent.", 2 * 3600 - 30],
  ],
  pim: [
    ["user", "Draft a post for the weekend sale.", 5 * 3600],
    ["assistant", "Here is a first draft:\n\n> New arrivals this weekend. Come by on Saturday for the first look.\n\nI will not post it until you say so.", 5 * 3600 - 40],
  ],
  ton: [["assistant", "Yesterday's books are closed. Nothing needs you.", 20 * 3600]],
  kit: [],
};

/** The composer's `./` picker. */
export const SKILL_SEED: readonly Skill[] = [
  { name: "plan", description: "Break the work into steps and agree on them before doing it." },
  { name: "research", description: "Find sources, read them and answer with what they say." },
  { name: "review", description: "Check a piece of work for mistakes, worst first." },
];

/** The composer's `/` menu: the demo runtime's own scripted turns, so they can be found without reading this file. */
export const COMMAND_SEED: readonly SlashCommand[] = [
  { name: "approve", description: "Demo: the team asks before it sends something", hint: "", kind: "command", prefix: "/" },
  { name: "clarify", description: "Demo: the team asks one question", hint: "", kind: "command", prefix: "/" },
  { name: "interview", description: "Demo: the team asks several questions at once", hint: "", kind: "command", prefix: "/" },
  { name: "delegate", description: "Demo: two helpers work side by side", hint: "[fail]", kind: "command", prefix: "/" },
];

/** What the scripted approval asks for: an outward-facing action, named exactly, as every real one will be. */
export const APPROVAL_SEED = {
  title: "Send a reply to a customer",
  command: 'Reply to Khun Mali on LINE: "Your order ships tomorrow morning."',
  status: "Preparing the reply…",
  done: (choice: string) => `Sent the reply (approved: ${choice}).`,
} as const;

export const CLARIFY_SEED = {
  status: "Checking what you meant…",
  question: "Which page should the post go on?",
  choices: ["Facebook", "Instagram"],
} as const;

export const INTERVIEW_SEED = {
  status: "Planning the weekend promotion…",
  questions: [
    { qid: "q1", question: "Who is the promotion for?", choices: ["New customers", "Returning customers", "Both"] },
    { qid: "q2", question: "Where should it run?", choices: ["LINE", "Facebook", "Instagram", "In the shop"], multi_select: true },
    { qid: "q3", question: "Anything to leave out?" },
  ],
} as const;

export const NORMAL_ANSWER =
  "Done. Here is what I found:\n\n- Three orders are waiting to ship\n- One customer asked about delivery times\n\nThis is a sample answer from the demo runtime.";

// ---- Mission Control: jobs, the activity log and the routines Pause everyone would hold --------------------------------
//
// Staged like the rest: Baan Mali's week as the design canvas tells it (Job.dc.html, Activity.dc.html, PauseAll.dc.html),
// with its times counted back from the moment the runtime starts, so "Today" and "Yesterday" are always true of it.
// Nothing here is a payment: the canvas's refund lines are left out, because payment work waits (docs/decisions.md).

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/** A job as it is staged: each step as `[stage, seconds before the runtime started]`, oldest first. */
export interface JobSeed {
  id: string;
  title: string;
  goal: string;
  /** the rule the owner could keep from this job ("parcels are late"), or null */
  again: string | null;
  bot: string;
  steps: readonly (readonly [JobStage, number])[];
  summary: string;
  recipients: readonly JobRecipient[];
  /** integer satang; the sum of the trace's costs */
  costSatang: number;
  tookSeconds: number | null;
  trace: readonly TraceStep[];
}

const step = (tool: string, found: string, ms: number, more: Partial<Omit<TraceStep, "tool" | "found" | "ms">> = {}): TraceStep => ({
  tool,
  found,
  ms,
  costSatang: null,
  tokens: null,
  result: null,
  ...more,
});

export const JOB_SEED: readonly JobSeed[] = [
  {
    id: "late-parcels",
    title: "Replies about late parcels",
    goal: "Reply to customers whose parcels are late.",
    again: "parcels are late",
    bot: "nam",
    steps: [
      ["proposed", 50 * MIN],
      ["approved", 46 * MIN],
      ["sent", 46 * MIN],
      ["checked", 40 * MIN],
    ],
    summary:
      "Nam found 3 customers whose parcels were more than 2 days late, wrote each a reply with the new arrival day, and sent them after you approved. All three were delivered and two have been read.",
    recipients: [
      { name: "Khun Ploy", status: "read" },
      { name: "Khun Mint", status: "read" },
      { name: "Khun Tee", status: "delivered" },
    ],
    costSatang: 120,
    tookSeconds: 40,
    trace: [
      step("shopee.list_orders", "late > 2 days, 3 found", 800),
      step("carrier.track × 3", "new arrival: Tuesday", 1_900),
      step("draft_reply", "demo-standard, 1,412 tokens", 31_200, { costSatang: 98, tokens: 1_412 }),
      step("approval.wait", "allow once, by you", 240_000),
      step("line.send × 3", "3 accepted", 1_100),
      step("verify.delivery", "3 of 3 delivered", 5_000, { costSatang: 22, tokens: 552, result: "pass" }),
    ],
  },
  {
    id: "weekend-replies",
    title: "Replies about weekend orders",
    goal: "Answer the customers who asked about weekend orders.",
    again: "a customer asks about weekend orders",
    bot: "nam",
    steps: [
      ["proposed", 12 * MIN],
      ["approved", 9 * MIN],
      ["working", 9 * MIN],
    ],
    summary: "Nam is replying to 3 customers who asked about weekend orders. 1 reply has gone out and 2 are waiting.",
    recipients: [
      { name: "Khun Nok", status: "delivered" },
      { name: "Khun Pan", status: "waiting" },
      { name: "Khun Rit", status: "waiting" },
    ],
    costSatang: 45,
    tookSeconds: null,
    trace: [
      step("shopee.list_orders", "3 customers asked about weekend orders", 700),
      step("draft_reply", "demo-standard, 903 tokens", 18_400, { costSatang: 45, tokens: 903 }),
      step("line.send × 3", "1 of 3 accepted", 400, { result: "running" }),
    ],
  },
  {
    id: "teaser-draft",
    title: "Captions for the pre-order page",
    goal: "Write short captions for the pre-order page.",
    again: null,
    bot: "pim",
    steps: [["working", 20 * MIN]],
    summary: "Pim is writing captions for the pre-order page. Nothing goes live until you say so.",
    recipients: [],
    costSatang: 31,
    tookSeconds: null,
    trace: [step("draft_post", "first draft, 2 captions", 14_000, { costSatang: 31, tokens: 640, result: "running" })],
  },
  {
    id: "daily-summary",
    title: "Daily sales summary",
    goal: "Send me yesterday's sales every morning.",
    again: null,
    bot: "ton",
    steps: [
      ["proposed", 3 * HOUR + 10 * MIN],
      ["approved", 3 * HOUR + 8 * MIN],
      ["sent", 3 * HOUR + 8 * MIN],
    ],
    summary: "Ton wrote yesterday's sales summary: 14 orders and ฿8,420. It went only to you.",
    recipients: [],
    costSatang: 14,
    tookSeconds: 9,
    trace: [
      step("shopee.list_orders", "14 orders yesterday", 2_100),
      step("write_summary", "demo-careful, 311 tokens", 6_900, { costSatang: 14, tokens: 311 }),
    ],
  },
  {
    id: "teaser-post",
    title: "12.12 teaser post",
    goal: "Post a teaser for the 12.12 sale on Instagram.",
    again: null,
    bot: "pim",
    steps: [["proposed", 18 * HOUR]],
    summary: "Pim wrote a teaser post for Instagram. It waits for your approval, and nothing is posted before then.",
    recipients: [],
    costSatang: 28,
    tookSeconds: 11,
    trace: [step("draft_post", "demo-standard, 588 tokens", 11_000, { costSatang: 28, tokens: 588 })],
  },
  {
    id: "order-status",
    title: "Order-status replies to 5 customers",
    goal: "Answer questions about where an order is.",
    again: "a customer asks where an order is",
    bot: "nam",
    steps: [["sent", 20 * HOUR]],
    summary: "Nam answered 5 customers who asked where their orders were. Order-status questions only: everything else waited for you.",
    recipients: [
      { name: "Khun Ann", status: "read" },
      { name: "Khun Bee", status: "read" },
      { name: "Khun Chai", status: "delivered" },
      { name: "Khun Dao", status: "delivered" },
      { name: "Khun Em", status: "delivered" },
    ],
    costSatang: 85,
    tookSeconds: 22,
    trace: [
      step("shopee.list_orders", "5 order questions", 900),
      step("carrier.track × 5", "5 parcels found", 3_100),
      step("draft_reply", "demo-standard, 1,044 tokens", 16_000, { costSatang: 85, tokens: 1_044 }),
      step("line.send × 5", "5 accepted", 2_000),
    ],
  },
];

/** An event as it is staged: `ago` is the seconds before the runtime started. */
export interface ActivitySeed extends Omit<ActivityEvent, "at"> {
  ago: number;
}

/** How long the shop's log keeps an event before it is deleted for good (the canvas says 12 months). */
export const ACTIVITY_KEPT_MONTHS = 12;

export const ACTIVITY_SEED: readonly ActivitySeed[] = [
  { id: "e1", ago: 30 * MIN, who: "kit", kind: "code", title: "Kit pushed 2 changes to the PromptPay branch", item: "kit/promptpay-qr", job: null, approval: "No approval needed", status: "checked", where: "GitHub, project baanmali-preorder", undo: "Yes. The branch keeps every earlier version.", note: "14 tests passed. Customers see nothing until you put the page live.", text: null },
  { id: "e2", ago: 46 * MIN, who: "nam", kind: "msg", title: "Nam sent 3 LINE replies about late parcels", item: "Replies about late parcels", job: "late-parcels", approval: "You approved it", status: "sent", where: "LINE Official Account", undo: "No. LINE messages can’t be unsent.", note: "To Khun Ploy and 2 others. All three were delivered.", text: { body: "ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ ขอส่งโค้ดส่วนลด 5% สำหรับครั้งหน้าให้นะคะ", private: true } },
  { id: "e3", ago: 53 * MIN, who: "nam", kind: "signin", title: "Nam used the Carrier portal sign-in", item: "Carrier portal", job: null, approval: "Allowed for Nam in the vault", status: "used", where: "Vault", undo: "Nothing to undo. Nam only read tracking details.", note: "The vault typed the password in. Nam never saw it. Used to track 3 late parcels.", text: null },
  { id: "e4", ago: 56 * MIN, who: "nam", kind: "signin", title: "Nam used the Shopee Seller Centre sign-in", item: "Shopee Seller Centre", job: null, approval: "Allowed for Nam in the vault", status: "used", where: "Vault", undo: "Nothing to undo. Nam only read orders.", note: "The vault typed the password in. Nam never saw it. Used to find orders more than 2 days late.", text: null },
  { id: "e5", ago: 3 * HOUR + 8 * MIN, who: "ton", kind: "msg", title: "Ton sent you the daily sales summary", item: "Daily sales summary", job: "daily-summary", approval: "You approved it", status: "sent", where: "This app", undo: "Not needed. It went only to you.", note: "14 orders and ฿8,420 yesterday.", text: null },
  { id: "e6", ago: 3 * HOUR + 10 * MIN, who: "buddy", kind: "msg", title: "Buddy sent you the morning brief", item: "Morning brief", job: null, approval: "A routine, no approval needed", status: "sent", where: "This app", undo: "Not needed. It went only to you.", note: "14 orders and ฿8,420 yesterday. Five chats are waiting, and the jasmine candle is down to 4.", text: null },
  { id: "e7", ago: 18 * HOUR, who: "pim", kind: "post", title: "Pim asked to post the 12.12 teaser on Instagram", item: "12.12 teaser post", job: "teaser-post", approval: "Waiting for you", status: "needs_you", where: "Instagram", undo: "Nothing is posted until you approve.", note: "", text: { body: "12.12 นี้ เซ็ตของขวัญปีใหม่กลับมาแล้วค่ะ สั่งจองล่วงหน้าได้ตั้งแต่วันนี้", private: false } },
  { id: "e8", ago: 20 * HOUR, who: "nam", kind: "msg", title: "Nam replied to 5 customers about their orders", item: "Order-status replies", job: "order-status", approval: "Allowed alone under Small things alone", status: "sent", where: "Shopee chat", undo: "No. Sent messages can’t be taken back.", note: "Order-status questions only. Everything else waited for you.", text: { body: "ออเดอร์ของคุณลูกค้าส่งออกแล้วค่ะ ดูเลขพัสดุได้ในแชตนี้เลยนะคะ", private: true } },
  { id: "e9", ago: 21 * HOUR, who: OWNER, kind: "settings", title: "You set Nam to Small things alone", item: "Nam’s settings", job: null, approval: "Your own change", status: "changed", where: "Team, Nam", undo: "Yes. Pick another level on Nam’s page.", note: "Before: Asks every time.", text: null },
  { id: "e10", ago: 2 * DAY + 3 * HOUR, who: "pim", kind: "post", title: "Pim posted the jasmine candle photo on Facebook", item: "Jasmine candle post", job: null, approval: "You approved it", status: "posted", where: "Facebook", undo: "Yes. You can delete the post.", note: "", text: { body: "เทียนหอมกลิ่นมะลิพร้อมส่งแล้วค่ะ สั่งได้ทาง LINE และ Shopee", private: false } },
  { id: "e11", ago: 3 * DAY + 4 * HOUR, who: "ton", kind: "money", title: "Ton closed yesterday’s books", item: "Yesterday’s books", job: null, approval: "A routine, no approval needed", status: "checked", where: "Books", undo: "Yes. Reopen the day in Books.", note: "14 orders and ฿8,420. Nothing needs you.", text: null },
  { id: "e12", ago: 6 * DAY + 5 * HOUR, who: "buddy", kind: "msg", title: "Buddy sent you the weekly report", item: "Weekly report", job: null, approval: "A routine, no approval needed", status: "sent", where: "This app and your LINE", undo: "Not needed. It went only to you.", note: "Sales ฿52,860, up 12% on the week before.", text: null },
  { id: "e13", ago: 11 * DAY + 6 * HOUR, who: OWNER, kind: "signin", title: "You added the Carrier portal sign-in to the vault", item: "Carrier portal", job: null, approval: "Your own change", status: "changed", where: "Vault", undo: "Yes. Remove it in Connections.", note: "Allowed for Nam only.", text: null },
  { id: "e14", ago: 19 * DAY + 7 * HOUR, who: OWNER, kind: "settings", title: "You set the AI budget limit to ฿300", item: "Budget and plan", job: null, approval: "Your own change", status: "changed", where: "Customize, budget and plan", undo: "Yes. Change the limit at any time.", note: "Before: ฿250.", text: null },
];

/** The routines Pause everyone would hold: their runs are skipped while the team is paused, and History says so. */
export const ROUTINE_SEED: readonly string[] = [
  "Morning brief",
  "Weekly growth brief",
  "Tell me and draft a restock order",
  "Send the books to FlowAccount",
  "Answer order-status questions",
];
