// Starting setups for three kinds of online seller. Data and checks only: applying a template to a shop is
// somebody else's job. English for now.

export type MemberId = "nam" | "pim" | "ton" | "kit";

/** What a routine does, which decides whether it must ask the owner first. */
export type RoutineKind = "brief" | "draft" | "remind" | "reply" | "send" | "post" | "pay" | "delete";

export interface TemplateRoutine {
  /** The trigger, in words: "Every day at 08:00". */
  readonly trigger: string;
  /** What the routine does, in words. */
  readonly does: string;
  readonly kind: RoutineKind;
  readonly asksFirst: boolean;
}

export interface ShopTemplate {
  readonly id: string;
  readonly name: string;
  /** One line saying which shops it fits. */
  readonly fits: string;
  /** Team members on by default. Buddy is always on and is not listed. */
  readonly team: readonly MemberId[];
  readonly routines: readonly TemplateRoutine[];
  /** What Buddy asks the owner in the first week, so what the team knows comes from the owner. */
  readonly questions: readonly string[];
}

// Kinds that reach a customer, a service or money, or remove something: these always ask first.
const MUST_ASK: ReadonlySet<RoutineKind> = new Set(["reply", "send", "post", "pay", "delete"]);
const MEMBER_IDS: ReadonlySet<string> = new Set(["nam", "pim", "ton", "kit"]);

const morningBrief: TemplateRoutine = {
  trigger: "Every day at 08:00",
  does: "Morning brief",
  kind: "brief",
  asksFirst: false,
};
const sendBooks: TemplateRoutine = {
  trigger: "On the last day of the month at 18:00",
  does: "Send the books to FlowAccount",
  kind: "send",
  asksFirst: true,
};

const TEMPLATES: readonly ShopTemplate[] = [
  {
    id: "handmade",
    name: "Handmade and gifts",
    fits: "Candles, soap, crafts and gift sets, like Baan Mali.",
    team: ["nam", "pim", "ton"],
    routines: [
      morningBrief,
      { trigger: "Every Monday at 08:00", does: "Weekly growth brief", kind: "brief", asksFirst: false },
      { trigger: "When stock drops under 5", does: "Tell me and draft a restock order", kind: "draft", asksFirst: false },
      sendBooks,
    ],
    questions: [
      "What is your price list?",
      "What order total gets free shipping?",
      "How long do pre-orders take?",
      "Do you gift-wrap, and what does it cost?",
    ],
  },
  {
    id: "fashion",
    name: "Clothes and accessories",
    fits: "Shops selling clothes, bags and accessories in sizes.",
    team: ["nam", "pim", "ton"],
    routines: [
      morningBrief,
      { trigger: "Every Friday at 10:00", does: "Draft a new-arrivals post", kind: "draft", asksFirst: true },
      { trigger: "When a size drops under 3", does: "Tell me and draft a restock order", kind: "draft", asksFirst: false },
      sendBooks,
    ],
    questions: [
      "What is your size chart?",
      "Do you take exchanges, and for how long?",
      "How do pre-orders work?",
      "Which items are never discounted?",
    ],
  },
  {
    id: "food",
    name: "Packaged food and drinks",
    fits: "Shops selling packaged food and drinks that keep for a limited time.",
    team: ["nam", "ton"],
    routines: [
      morningBrief,
      { trigger: "Every day at 09:00", does: "List what expires within 7 days", kind: "brief", asksFirst: false },
      { trigger: "Every day at 15:00", does: "Remind me of today's delivery cut-off", kind: "remind", asksFirst: false },
      sendBooks,
    ],
    questions: [
      "How long does each product keep?",
      "Where do you deliver, and what is the day's cut-off time?",
      "Which products must stay cold?",
      "What should Buddy say when a customer asks about allergies? (Buddy never answers allergy questions from guesswork.)",
    ],
  },
];

/** Every built-in template. */
export function templates(): readonly ShopTemplate[] {
  return TEMPLATES;
}

/** The template with this id, or `null`. */
export function templateById(id: string): ShopTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Every problem with a template, as plain sentences; an empty list means it is fine. */
export function checkTemplate(template: ShopTemplate): string[] {
  const problems: string[] = [];
  const blank = (s: string) => s.trim().length === 0;

  if (blank(template.name)) problems.push("The name is empty.");
  else if (template.name.length > 40) problems.push("The name is longer than 40 characters.");
  if (blank(template.fits)) problems.push("The line saying which shops it fits is empty.");

  const seen = new Set<string>();
  for (const member of template.team as readonly string[]) {
    if (member === "buddy") problems.push("Buddy is always part of the team and must not be listed.");
    else if (!MEMBER_IDS.has(member)) problems.push(`Unknown team member "${member}".`);
    if (seen.has(member)) problems.push(`Team member "${member}" is listed twice.`);
    seen.add(member);
  }

  template.routines.forEach((r, i) => {
    const n = i + 1;
    if (blank(r.trigger)) problems.push(`Routine ${n} has an empty trigger.`);
    if (blank(r.does)) problems.push(`Routine ${n} has an empty description of what it does.`);
    if (MUST_ASK.has(r.kind) && !r.asksFirst) {
      problems.push(`Routine ${n} ("${r.does}") ${r.kind}s, so it must ask first.`);
    }
  });

  template.questions.forEach((q, i) => {
    if (blank(q)) problems.push(`Question ${i + 1} is empty.`);
  });
  if (template.questions.length < 2 || template.questions.length > 6) {
    problems.push(`There must be 2 to 6 questions, not ${template.questions.length}.`);
  }
  return problems;
}
