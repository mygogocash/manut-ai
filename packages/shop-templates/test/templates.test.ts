import { describe, expect, it } from "vitest";
import { checkTemplate, templateById, templates, type ShopTemplate } from "../src/index.js";

const handmade = templateById("handmade")!;
const broken = (patch: Partial<ShopTemplate>): ShopTemplate => ({ ...handmade, ...patch });

describe("built-in templates", () => {
  it("lists the three in order", () => {
    expect(templates().map((t) => t.id)).toEqual(["handmade", "fashion", "food"]);
    expect(templates().map((t) => t.name)).toEqual([
      "Handmade and gifts",
      "Clothes and accessories",
      "Packaged food and drinks",
    ]);
  });

  it("has no problems in any of them", () => {
    for (const t of templates()) expect(checkTemplate(t)).toEqual([]);
  });

  it("gives handmade its team, routines and questions", () => {
    expect(handmade.team).toEqual(["nam", "pim", "ton"]);
    expect(handmade.routines.map((r) => [r.trigger, r.does, r.asksFirst])).toEqual([
      ["Every day at 08:00", "Morning brief", false],
      ["Every Monday at 08:00", "Weekly growth brief", false],
      ["When stock drops under 5", "Tell me and draft a restock order", false],
      ["On the last day of the month at 18:00", "Send the books to FlowAccount", true],
    ]);
    expect(handmade.questions).toHaveLength(4);
  });

  it("gives fashion a post that asks first and a size trigger", () => {
    const f = templateById("fashion")!;
    expect(f.team).toEqual(["nam", "pim", "ton"]);
    expect(f.routines[1]).toMatchObject({ trigger: "Every Friday at 10:00", does: "Draft a new-arrivals post", asksFirst: true });
    expect(f.routines[2]?.trigger).toBe("When a size drops under 3");
    expect(f.routines[3]?.asksFirst).toBe(true);
    expect(f.questions).toHaveLength(4);
  });

  it("gives food only Nam and Ton, and never guesses at allergies", () => {
    const f = templateById("food")!;
    expect(f.team).toEqual(["nam", "ton"]);
    expect(f.routines.map((r) => r.trigger)).toEqual([
      "Every day at 08:00",
      "Every day at 09:00",
      "Every day at 15:00",
      "On the last day of the month at 18:00",
    ]);
    expect(f.routines.map((r) => r.does)).toContain("List what expires within 7 days");
    expect(f.questions[3]).toContain("never answers allergy questions from guesswork");
  });

  it("keeps the name within 40 characters", () => {
    for (const t of templates()) expect(t.name.length).toBeLessThanOrEqual(40);
  });
});

describe("templateById", () => {
  it("finds a template", () => expect(templateById("food")?.id).toBe("food"));
  it("answers null for an unknown id", () => {
    expect(templateById("bakery")).toBeNull();
    expect(templateById("")).toBeNull();
  });
});

describe("checkTemplate problems", () => {
  it("flags every must-ask kind that does not ask", () => {
    for (const kind of ["reply", "send", "post", "pay", "delete"] as const) {
      const t = broken({ routines: [{ trigger: "Every day at 08:00", does: "Do it", kind, asksFirst: false }] });
      expect(checkTemplate(t).join()).toContain("must ask first");
    }
  });
  it("lets a brief run without asking", () => {
    const t = broken({ routines: [{ trigger: "Every day at 08:00", does: "Brief", kind: "brief", asksFirst: false }] });
    expect(checkTemplate(t)).toEqual([]);
  });
  it("flags Buddy in the team", () => {
    expect(checkTemplate(broken({ team: ["nam", "buddy" as never] }))).toContain(
      "Buddy is always part of the team and must not be listed.",
    );
  });
  it("flags an unknown member", () => {
    expect(checkTemplate(broken({ team: ["nam", "zed" as never] }))).toContain('Unknown team member "zed".');
  });
  it("accepts kit", () => expect(checkTemplate(broken({ team: ["kit"] }))).toEqual([]));
  it("flags a repeated member", () => {
    expect(checkTemplate(broken({ team: ["nam", "nam"] }))).toContain('Team member "nam" is listed twice.');
  });
  it("flags an empty or long name", () => {
    expect(checkTemplate(broken({ name: "  " }))).toContain("The name is empty.");
    expect(checkTemplate(broken({ name: "x".repeat(41) }))).toContain("The name is longer than 40 characters.");
    expect(checkTemplate(broken({ name: "x".repeat(40) }))).toEqual([]);
  });
  it("flags an empty fits line", () => {
    expect(checkTemplate(broken({ fits: "" }))).toContain("The line saying which shops it fits is empty.");
  });
  it("flags an empty trigger and description", () => {
    const t = broken({ routines: [{ trigger: "", does: " ", kind: "brief", asksFirst: false }] });
    const p = checkTemplate(t);
    expect(p).toContain("Routine 1 has an empty trigger.");
    expect(p).toContain("Routine 1 has an empty description of what it does.");
  });
  it("flags empty questions", () => {
    expect(checkTemplate(broken({ questions: ["a?", ""] }))).toContain("Question 2 is empty.");
  });
  it("flags too few and too many questions", () => {
    expect(checkTemplate(broken({ questions: ["a?"] })).join()).toContain("2 to 6 questions, not 1");
    expect(checkTemplate(broken({ questions: Array(7).fill("a?") })).join()).toContain("2 to 6 questions, not 7");
    expect(checkTemplate(broken({ questions: ["a?", "b?"] }))).toEqual([]);
    expect(checkTemplate(broken({ questions: Array(6).fill("a?") }))).toEqual([]);
  });
  it("reports several problems at once", () => {
    expect(checkTemplate(broken({ name: "", fits: "", questions: [] })).length).toBe(3);
  });
});
