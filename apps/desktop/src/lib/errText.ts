// The words for a thrown value that may be an Error, a host refusal (`{ message }`) or a bare string. Showing the
// message when there is one, and the value itself otherwise, keeps a failed call from ever printing `[object Object]`.
export const errText = (e: unknown): string =>
  typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
