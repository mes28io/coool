# Fonts

- `Geist-Variable.woff2`, `GeistMono-Variable.woff2`: bundled (SIL OFL). Geist Mono is used for everything monospaced; Geist is the fallback UI font.
- `pally/`: **not committed.** Pally (Indian Type Foundry, https://www.fontshare.com/fonts/pally) is the UI font. Its licence, the ITF Free Font License (https://www.fontshare.com/licenses/itf-ffl), allows embedding in desktop apps but forbids redistributing the font files (including in repositories) and modifying or subsetting them.
  So `scripts/fetch-fonts.mjs` downloads the official woff2 from Fontshare into `pally/` on `pnpm install` (postinstall; run `pnpm fonts` to redo it), and generates `pally/pally.css`. The folder is git-ignored.
- `src/main.tsx` loads `pally/pally.css` only if it exists (`import.meta.glob`), so builds without it succeed and the UI falls back to Geist.
- Fonts are never loaded from a CDN at runtime; Fontshare is contacted only at install time.
- Pally has no tabular figures, so numbers that must not jitter (`.tnum`) use Geist Mono.
