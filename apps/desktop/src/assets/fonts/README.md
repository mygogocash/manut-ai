# Bundled fonts

Bundled unmodified; licences beside them and in `../../../THIRD_PARTY_NOTICES.md`.

## Terminal fonts

From the projects' own releases (inherited from Oh My Hermes' omher).

| File | From | Licence |
| --- | --- | --- |
| `JetBrainsMono-{Regular,Bold,Italic,BoldItalic}.woff2` | JetBrains/JetBrainsMono v2.304, `JetBrainsMono-2.304.zip` `fonts/webfonts/` (sha256 of the zip `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`) | SIL OFL 1.1, `JetBrainsMono-OFL.txt` |
| `SymbolsNerdFontMono-Regular.woff2` | ryanoasis/nerd-fonts v3.5.1, `NerdFontsSymbolsOnly.zip` `SymbolsNerdFontMono-Regular.ttf` (sha256 of the zip `fdca3682534f6f65e1ccb2345b0362ccf67d9b8eca7c8025330946e93e2473bc`), converted with `fonttools ttLib.woff2 compress` | MIT, `SymbolsNerdFont-LICENSE.txt` |

## Interface fonts

The fonts of Manut AI's design tokens (`packages/ui-kit/tokens.json`), declared in `src/theme/fonts.css`. Taken from
the Fontsource packages on the npm registry (the files inside each tarball's `files/` folder, unchanged). Only the
subsets the app needs are kept.

| File | From | Licence |
| --- | --- | --- |
| `geist-latin-wght-normal.woff2`, `geist-latin-ext-wght-normal.woff2` | `@fontsource-variable/geist` 5.3.0 (sha256 of the tarball `533dd66117795ac12316fb05fce27736c4bc63c31613b302d0a5285ca3a291d7`) | SIL OFL 1.1, `Geist-OFL.txt` |
| `geist-mono-latin-wght-normal.woff2`, `geist-mono-latin-ext-wght-normal.woff2` | `@fontsource-variable/geist-mono` 5.3.0 (sha256 `af7a9f156602b859efa95cd1acb824a5322c51a1eca53afb38ed033885736a70`) | SIL OFL 1.1, `GeistMono-OFL.txt` |
| `ibm-plex-sans-thai-thai-{400,500,600}-normal.woff2` | `@fontsource/ibm-plex-sans-thai` 5.3.0 (sha256 `5ca89cc99ea11b8ee264f9b9dc5deae8a448693cbc2a467a3719146230f3ffd4`) | SIL OFL 1.1, `IBMPlexSansThai-OFL.txt` |
| `source-serif-4-{latin,latin-ext}-wght-{normal,italic}.woff2` | `@fontsource-variable/source-serif-4` 5.3.1 (sha256 `8c452853c74be1e43e9fbfe76321c26f4678a2d431e93209ff1d9faec03fd96f`) | SIL OFL 1.1, `SourceSerif4-OFL.txt` (the package's own `LICENSE`) |
