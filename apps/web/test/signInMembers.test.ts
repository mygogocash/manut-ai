import { describe, expect, it } from "vitest";
import { DEFAULT_ROSTER } from "../../../packages/member-grants/src/roster";
// The API's vault, read as text: it runs in the Worker and cannot be imported here, and what it says is the rule to hold the
// console's list to.
import vaultSource from "../../api/src/sign-in-vault.ts?raw";
import { SIGN_IN_MEMBERS } from "../src/api";

// The Connections page lets an operator choose who may use a sign-in from `SIGN_IN_MEMBERS`, which this app keeps as a copy because it
// does not depend on `@manut/member-grants`. The vault refuses any member that is not in its own list, so a copy that has drifted
// would offer a member the vault refuses, or leave one out that it takes. This holds the copy to the roster itself.
describe("the members a sign-in may name", () => {
  it("are the roster's members whose jobs run through a connection, in its order", () => {
    const fromRoster = DEFAULT_ROSTER
      .filter((member) => member.capabilities.some((capability) => capability.needsConnection))
      .map((member) => member.id);
    expect([...SIGN_IN_MEMBERS]).toEqual(fromRoster);
    // Buddy routes work and never signs in to a site.
    expect(SIGN_IN_MEMBERS).not.toContain("buddy");
  });

  it("are read from the roster by the rule the API's vault uses, so a change to that rule is seen here", () => {
    expect(vaultSource).toContain('import { DEFAULT_ROSTER } from "@manut/member-grants";');
    expect(vaultSource).toContain(
      "export const SIGN_IN_MEMBERS: readonly string[] = DEFAULT_ROSTER\n" +
      "  .filter((member) => member.capabilities.some((capability) => capability.needsConnection))\n" +
      "  .map((member) => member.id);",
    );
  });
});
