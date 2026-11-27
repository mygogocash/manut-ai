/// What a background job's log line may say about an error: a code the Worker throws on purpose (`routine_unavailable`,
/// `vault_unavailable`), or else only the error's kind (`TypeError`). An error's free text can quote what it was working on, a
/// customer's message or a shop's data, and a log line is kept outside the shop's own records, so it never carries that.
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function errorCode(error: unknown): string {
  if (error instanceof Error) return CODE.test(error.message) ? error.message : error.name || "Error";
  return typeof error === "string" && CODE.test(error) ? error : "unknown_error";
}
