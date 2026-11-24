import { describe, expect, it } from "vitest";
// The API's audit log module, read as text. It cannot be imported: it runs on Durable Object storage and pulls in the
// Worker's other modules, none of which belong in the console's bundle or its jsdom tests. `?raw` hands the test the file's
// own words, so the lists below are checked against the API as it stands, not against what someone remembered of it.
import auditLogSource from "../../api/src/audit-log.ts?raw";
import type { AuditActor, AuditEntry } from "../src/api";
import {
  auditActionsWithWords,
  auditActorText,
  auditOutcomeTag,
  auditSentence,
  auditSubjectText,
} from "../src/ops/words";

// What the API can write into a shop's audit log, copied from `apps/api/src/audit-log.ts` (`AUDIT_ACTIONS`). The copy is
// here so a reader of this test sees the whole list at a glance; the first test below fails the moment the file and the
// copy differ, naming what changed, and the rest then hold the console to the copy. To catch up with the API: add the new
// action to this list, then give it words in `AUDIT_ACTIONS` in `src/ops/words.ts`.
const API_AUDIT_ACTIONS = [
  "shop.created",
  "line.connected",
  "reply.proposed",
  "payment.recorded",
  "subscription_payment.recorded",
  "model.cap_set",
  "model.cap_cleared",
  "deletion.requested",
  "reply.decided",
  "deletion.decided",
  "consent.given",
  "consent.withdrawn",
  "dispatch.started",
  "dispatch.settled",
  "attempt.started",
  "attempt.ended",
  "approval.requested",
  "approval.decided",
  "approval.superseded",
  "memory.remembered",
  "memory.proposed",
  "memory.confirmed",
  "memory.corrected",
  "memory.forgotten",
  "routine.created",
  "routine.paused",
  "routine.resumed",
  "routine.removed",
  "routine.ran",
  "team.paused",
  "team.resumed",
  "template.applied",
  "question.answered",
  "invite.created",
  "invite.revoked",
  "helper.joined",
  "helper.session_opened",
  "helper.removed",
  "away.set",
  "away.cleared",
  "request.passed_on",
  "owner.linked",
  "owner.unlinked",
  "owner.session_opened",
  "owner.session_ended",
  "helper.session_ended",
  "signin.created",
  "signin.password_replaced",
  "signin.removed",
  "signin.broken",
  "signin.requested",
  "signin.redeemed",
  "vault.resealed",
  "outpost.registered",
  "outpost.removed",
  "outpost.credential_rotated",
  "browser_step.queued",
  "browser_step.fetched",
  "browser_step.reported",
];

/// The string literals of one `export const NAME = [ ... ] as const;` in the API's audit log, comments left out.
function listFrom(name: string): string[] {
  const start = auditLogSource.indexOf(`export const ${name} = [`);
  const end = auditLogSource.indexOf("] as const;", start);
  if (start < 0 || end < 0) {
    throw new Error(`apps/api/src/audit-log.ts no longer has "export const ${name} = [ ... ] as const;": teach this test where the list went`);
  }
  const body = auditLogSource.slice(start, end).replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

/// The kinds of the API's `AuditActor` union: the text between its declaration and the next export.
function actorKindsFrom(): string[] {
  const start = auditLogSource.indexOf("export type AuditActor =");
  const end = auditLogSource.indexOf("export type AuditEntry", start);
  if (start < 0 || end < 0) throw new Error("apps/api/src/audit-log.ts no longer declares `AuditActor` before `AuditEntry`");
  return [...auditLogSource.slice(start, end).matchAll(/\{ kind: "([a-z_]+)"/g)].map((match) => match[1]!);
}

const NOW = "2026-11-24T03:00:00.000Z";
const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d", at: NOW,
  actor: { kind: "system" }, action: "shop.created", subject: {}, outcome: "ok", ...overrides });

/// One actor of each kind the API writes, with the fields its kind carries.
const SAMPLE_ACTORS: Record<string, AuditActor> = {
  operator: { kind: "operator", email: "ops@manut.test" },
  owner: { kind: "owner", id: "owner-1" },
  helper: { kind: "helper", id: "helper-1" },
  worker: { kind: "worker", attemptId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" },
  outpost: { kind: "outpost", id: "b4c8d1e2-5f60-4a71-8b92-0c3d4e5f6a7b" },
  system: { kind: "system" },
};

describe("the console's words against what the API's audit log can write", () => {
  it("is held to the API's own list: the copy in this test matches audit-log.ts, so a new action cannot slip past", () => {
    const fromApi = listFrom("AUDIT_ACTIONS");
    expect(fromApi.length).toBeGreaterThan(50);
    const gained = fromApi.filter((action) => !API_AUDIT_ACTIONS.includes(action));
    const lost = API_AUDIT_ACTIONS.filter((action) => !fromApi.includes(action));
    expect({ gained, lost }, "audit-log.ts and this test's copy of AUDIT_ACTIONS differ").toEqual({ gained: [], lost: [] });
    expect(new Set(API_AUDIT_ACTIONS).size).toBe(API_AUDIT_ACTIONS.length);
  });

  it("has words for every action the API writes, none shown by its raw name", () => {
    // Every action in the API's file, read from the file itself, so this fails for an action the copy above lacks too.
    const missing = listFrom("AUDIT_ACTIONS").filter((action) => !auditActionsWithWords().includes(action));
    expect(missing, "actions the API writes that the Audit page has no words for").toEqual([]);
    for (const action of listFrom("AUDIT_ACTIONS")) {
      for (const actor of Object.values(SAMPLE_ACTORS)) {
        const sentence = auditSentence(entry({ actor, action }), "Fon", {});
        expect(sentence, `${action} by ${actor.kind}`).not.toContain(action);
        expect(sentence, `${action} by ${actor.kind}`).not.toMatch(/\bdid\b/);
        expect(sentence.endsWith("."), `${action} by ${actor.kind}`).toBe(true);
      }
    }
  });

  it("has no words for an action the API does not write, which would be a typo or one that was retired", () => {
    const stale = auditActionsWithWords().filter((action) => !listFrom("AUDIT_ACTIONS").includes(action));
    expect(stale, "words for actions that are not in audit-log.ts").toEqual([]);
  });

  it("says who acted for every kind of actor the API names", () => {
    const kinds = actorKindsFrom();
    expect(kinds.sort()).toEqual(["helper", "operator", "outpost", "owner", "system", "worker"]);
    for (const kind of kinds) {
      const actor = SAMPLE_ACTORS[kind];
      expect(actor, `this test has no sample for the API's new actor kind "${kind}"`).toBeDefined();
      const said = auditActorText(actor!, "Fon", {});
      expect(said, kind).not.toBe("Someone");
      expect(said.length, kind).toBeGreaterThan(0);
    }
  });

  it("gives every outcome the API writes a tag, or none for the plain ok", () => {
    for (const outcome of listFrom("AUDIT_OUTCOMES")) {
      const tag = auditOutcomeTag(outcome, "Fon");
      if (outcome === "ok") {
        expect(tag).toBeNull();
        continue;
      }
      expect(tag, outcome).not.toBeNull();
      // A word the console wrote, not the API's code handed back.
      expect(tag!.label, outcome).not.toBe(outcome);
      expect(tag!.label, outcome).not.toMatch(/_/);
    }
  });

  it("labels every id an entry may name, none shown by its raw key", () => {
    for (const key of listFrom("AUDIT_SUBJECT_KEYS")) {
      const said = auditSubjectText({ [key]: "x1" });
      expect(said, key).toMatch(/x1$/);
      expect(said, key).not.toBe(`${key} x1`);
    }
  });
});
