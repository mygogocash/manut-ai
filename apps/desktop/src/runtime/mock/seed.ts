// What the in-process runtime starts with: Buddy and a small team, a few lines of history each, and the model list
// the picker shows. Everything here is staged. The names follow the design canvas's team (Nam, Pim, Ton, Kit); the
// models are labelled as a demo so nobody reads them as a real provider.
import type { BotStatus, ModelProvider, Skill, SlashCommand } from "../../lib/protocol";

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
