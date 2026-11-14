# Fonts

All UI type is the Geist family, each member with one job. Pally is used for the wordmark only.

- **Geist Sans** (`Geist-Variable.woff2`, `--font-sans`): all interface text, assistant prose, every title (weight 600; -0.01em, display titles -0.02em), plain numbers (`.tnum` = tabular figures).
- **Geist Mono** (`GeistMono-Variable.woff2`, `--font-mono`): code, paths, commands, the terminal; uppercase section labels (`--text-micro`), keycaps and timestamps in the timeline.
- Geist and Geist Mono are SIL OFL 1.1 (Vercel, with basement.studio).
- **Pally** (`--font-wordmark`, only in `Wordmark.tsx`): **not committed.** Indian Type Foundry, https://www.fontshare.com/fonts/pally. Its licence, the ITF Free Font License (https://www.fontshare.com/licenses/itf-ffl), allows embedding in desktop apps but forbids redistributing the font files (including in repositories) and modifying or subsetting them.
  So `scripts/fetch-fonts.mjs` downloads the official woff2 from Fontshare into `pally/` on `pnpm install` (postinstall; `pnpm fonts` redoes it) and generates `pally/pally.css`. The folder is git-ignored. `src/main.tsx` loads that CSS only if it exists (`import.meta.glob`), so builds without it succeed and the wordmark falls back to Geist Sans 700.
- Fonts are never loaded from a CDN at runtime; Fontshare is contacted only at install time.
