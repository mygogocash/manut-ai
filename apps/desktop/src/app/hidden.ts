// Marks the page while its window is hidden (`<html data-hidden>`, item 136): motion.css then holds every loop still, so a
// spinner or a live dot in a minimised window does not keep the machine drawing it. The page's own `visibilitychange` says
// when; nothing is read or sent.
export function startHiddenMark(doc: Pick<Document, "documentElement" | "visibilityState" | "addEventListener" | "removeEventListener"> = document): () => void {
  const mark = () => doc.documentElement.toggleAttribute("data-hidden", doc.visibilityState === "hidden");
  mark();
  doc.addEventListener("visibilitychange", mark);
  return () => doc.removeEventListener("visibilitychange", mark);
}
