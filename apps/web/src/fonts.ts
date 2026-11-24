/// The brand's typefaces, from Google Fonts: Geist and Geist Mono, IBM Plex Sans Thai, Noto Serif Thai and Source Serif 4,
/// as the design canvas loads them. They used to be linked from index.html, which made every page ask Google for them.
/// The join page's path carries an invite token, and it makes no request to any other origin, so the app links the fonts
/// itself on every other page (App.tsx) and the join page shows the system's own typefaces.

export const BRAND_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500" +
  "&family=IBM+Plex+Sans+Thai:wght@400;500;600&family=Noto+Serif+Thai:wght@400;600&family=Source+Serif+4:wght@400;600" +
  "&display=swap";

/// The origins the fonts come from, connected to early: the stylesheet's, and the font files'.
const FONT_ORIGINS = [
  { href: "https://fonts.googleapis.com", crossOrigin: false },
  { href: "https://fonts.gstatic.com", crossOrigin: true },
];

/// Links the brand's fonts into the page's head, once: a second call finds them there and adds nothing.
export function loadBrandFonts(doc: Document = document): void {
  if (doc.getElementById("brand-fonts")) return;
  for (const origin of FONT_ORIGINS) {
    const preconnect = doc.createElement("link");
    preconnect.rel = "preconnect";
    preconnect.href = origin.href;
    if (origin.crossOrigin) preconnect.crossOrigin = "";
    doc.head.append(preconnect);
  }
  const sheet = doc.createElement("link");
  sheet.id = "brand-fonts";
  sheet.rel = "stylesheet";
  sheet.href = BRAND_FONTS_URL;
  doc.head.append(sheet);
}
