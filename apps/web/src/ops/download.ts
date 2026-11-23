import { formatIsoDate } from "../format";

/// How long an object URL stays alive after its link is clicked. Some browsers read the file only after the
/// click has returned, and revoking the URL first cancels the download, so it is let go a little later.
export const REVOKE_AFTER_MS = 40_000;

/// Long enough to recognise a shop, short enough that the whole name stays under the 255 bytes most file
/// systems allow, even when every character takes four bytes.
const NAME_LIMIT = 50;

/// baan-mali-export-2026-11-23.json: the shop's name, then the day of the export on the shop's calendar.
/// Pilot shops are Thai, so letters in any script are kept; everything else becomes a dash. A name with
/// nothing usable left in it falls back to the shop's id, so two shops never share a file name.
export function exportFileName(shopName: string, tenant: string, exportedAt: string, now: number = Date.now()): string {
  const at = Number.isNaN(Date.parse(exportedAt)) ? new Date(now).toISOString() : exportedAt;
  return `${slugOf(shopName) || slugOf(tenant) || "shop"}-export-${formatIsoDate(at)}.json`;
}

function slugOf(text: string): string {
  // Marks (\p{M}) stay with their letters: Thai writes its vowels and tone marks as marks.
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // Cut by code points, never inside a surrogate pair.
  return Array.from(slug).slice(0, NAME_LIMIT).join("").replace(/-+$/, "");
}

/// Hands `text` to the browser as a file called `fileName`. The link is in the page only while it is
/// clicked, because some browsers ignore a click on a link that is not in the document.
export function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
