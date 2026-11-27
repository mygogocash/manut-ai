// A background job's log line names an error by a code the Worker threw on purpose, or by its kind, never by its free text.
import { describe, expect, it } from "vitest";
import { errorCode } from "../src/log-safe";

describe("errorCode", () => {
  it("keeps a code the Worker throws, and only the kind of any other error", () => {
    expect(errorCode(new Error("routine_unavailable"))).toBe("routine_unavailable");
    expect(errorCode(new TypeError("Cannot read properties of undefined (reading 'message from Lek: my address is ...')"))).toBe("TypeError");
    expect(errorCode(new Error("Customer Somchai owes 500 baht"))).toBe("Error");
    expect(errorCode("vault_unavailable")).toBe("vault_unavailable");
    expect(errorCode({ text: "secret" })).toBe("unknown_error");
  });
});
