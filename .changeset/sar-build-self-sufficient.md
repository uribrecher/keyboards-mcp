---
---

Dev-build robustness for `sounds-and-recreation-app` (no release intended —
the app is private and `keyboards-mcp`'s published artifact is unchanged).

- The app build now builds its `keyboards-mcp` dependency first (`build:deps`
  in `prebuild`), so building the app standalone (`npm run build -w
  sounds-and-recreation-app`) no longer fails type-checking against a stale
  `keyboards-mcp/dist`.
- `npm run sar` / `sar:debug` now run a full build first (via `presar`), so
  `src/shell/vendor/` is populated and `dist/main.js` is fresh before Electron
  launches — fixing the non-responsive renderer (the peaks/konva/marked vendor
  scripts the shell loads were missing). `sar:dist` already did this.
- Root `build` delegates to the app (which cascades to `keyboards-mcp`),
  avoiding a redundant double build.
