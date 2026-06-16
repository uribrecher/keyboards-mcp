---
topic: monorepo-workspaces-split
issue: https://github.com/uribrecher/keyboards-mcp/issues/135
epic: https://github.com/uribrecher/keyboards-mcp/issues/133
status: design
related:
  - ./2026-06-15-sounds-and-recreation-app-rename-design.md   # #126/#131 — the in-place app rename this builds on
  - ./2026-06-14-installable-mcp-broker-daemon-design.md       # #124/#125 — the lean hardware-owner package + MCB daemon
---

# Restructure into a `packages/*` workspaces monorepo

## Problem

A single `package.json` (`version: 2.0.0`) and a single source tree currently serve
**two different artifacts**: the published `keyboards-mcp` MCP server (an npm library
for hardware owners) and the **Sounds and Recreation** desktop `.app` (an end-user UI
facade, formerly "Mock Runner"). They share one version number, one changelog, one
dependency list, and one set of build scripts. A bump to either forces a bump to both,
and app-only build deps (`electron`, `peaks.js`, `konva`, `waveform-data`, the
`file:` agent-client) sit in the same `package.json` as the lean server.

This is sub-issue **#135** of epic **#133** ("Split into a workspaces monorepo with
independent versions + Changesets"). #135 delivers only the **structural split**; the
independent-versioning machinery is deferred to its sibling sub-issues (see Scope).

## Goal

Turn the repo into an **npm workspaces monorepo** with two packages — the published
`keyboards-mcp` server and the private Sounds and Recreation app — where the app
depends on `keyboards-mcp` and imports its shared model logic **by package name**, with
**no cross-package `../` imports**. The full test suite, lint, and type-check stay green.

## Decisions (settled with the issue author)

1. **Layout — `packages/*`.** The repo root becomes a private workspaces umbrella
   (`"private": true`, `"workspaces": ["packages/*"]`, single root lockfile). The
   current package moves wholesale into `packages/keyboards-mcp/`; the app becomes
   `packages/sounds-and-recreation-app/`. Chosen over keeping the server at the repo
   root because npm does **not** symlink the root package into `node_modules`, so a
   nested workspace could not cleanly `import "keyboards-mcp"` via `^2`. The cost
   (the server's `dist` path moves) is accepted and handled (see "External references").

2. **Two packages, not three.** A dedicated `core` (shared + keyboard_models) package
   was considered and **rejected**. The published `keyboards-mcp` tarball already ships
   `dist/shared/**` + `dist/keyboard_models/**` and stays the single source of truth;
   a third package would mean either a second public npm package + a third independent
   version line, or a new bundler step — both at odds with the epic's
   reduce-versioning-overhead goal. The "the app depends on an *MCP server*" oddity is
   mitigated by the `exports` map: the app only ever sees `keyboards-mcp/shared/*`, the
   *library* face of the package. Extracting `core` later remains a clean, self-contained
   refactor if the coupling ever bites.

3. **App-only modules move into the app.** `audio-analysis-client/` and
   `shared/mockrack-format.ts` are imported **only** by the app (verified: nothing in
   `server.ts`/`index.ts`/`tools/`/`cli/`/`mcb/` touches them). They relocate into
   `packages/sounds-and-recreation-app/`, including the `generate:audio-analysis-types`
   openapi codegen script. This keeps the server's exported surface limited to genuinely
   shared logic.

4. **MCB stays in `keyboards-mcp`.** `src/mcb/` is server infrastructure: `dist/mcb/**`
   is already in the published `files` whitelist, the `mcb` npm script lives there, and
   server tools/CLI import `shared/mcb-client`. The app never imports the MCB *server* —
   only `mcb-client` (shared, exported). Tests spawn the MCB from keyboards-mcp's own
   `src/mcb/index.ts`, so the MCB half of the integration tests needs no cross-package
   reach.

5. **Tests stay in `keyboards-mcp`; helper paths retargeted.** For #135 the whole test
   suite remains under `packages/keyboards-mcp/tests/`. Only the two helpers that spawn
   the headless mock (`tests/helpers/mock-process.ts`,
   `tests/helpers/multi-device-harness.ts`) change, to point at the app's new location.
   A clean per-package test split is a possible later follow-up — not attempted here, to
   keep the diff small and "tests stay green" easiest.

## Target layout

```
keyboards-mcp/                          (repo root — NEW private workspaces umbrella; never published)
├── package.json                        { "private": true, "workspaces": ["packages/*"], thin delegator scripts }
├── package-lock.json                   (single root lockfile)
├── docs/                               (repo-level specs/plans stay at the root — see Open items)
└── packages/
    ├── keyboards-mcp/                  (the published npm server — stays on the 2.0.x line)
    │   ├── package.json                name keyboards-mcp, bin, files whitelist, + NEW exports map
    │   ├── tsconfig.json               (+ "declaration": true so consumers get types)
    │   ├── eslint.config.js
    │   ├── README.md  CHANGELOG.md  LICENSE   (published surface — move with the package)
    │   ├── Dockerfile  docker-compose.test.yml  data/
    │   ├── src/                        index.ts server.ts cli/ mcb/ tools/ midi/ shared/ keyboard_models/
    │   └── tests/                      ALL tests stay here (helpers retargeted to the app)
    └── sounds-and-recreation-app/      (private app — initial version 0.1.0)
        ├── package.json                { "private": true, deps: { "keyboards-mcp": "^2", electron stack, … } }
        └── src/                        main.ts cli.ts transport.ts shell/ preload.cjs
                                        audio-analysis-client/   (MOVED in, + openapi codegen)
                                        mockrack-format.ts        (MOVED in from shared/)
```

## The dependency edge + `exports` map

After the two app-only modules move out, the app imports **only** `shared/*` from the
server. `keyboards-mcp` adds a minimal subpath `exports` map (with types for DX):

```jsonc
"exports": {
  ".":          { "types": "./dist/index.d.ts",    "default": "./dist/index.js" },   // MCP server entry — unchanged
  "./shared/*": { "types": "./dist/shared/*.d.ts", "default": "./dist/shared/*.js" }  // model-registry, mock-registry, mcb-client, keyboard-model, midi-codec, …
}
```

- The app rewrites `import … from "../shared/model-registry.js"` →
  `from "keyboards-mcp/shared/model-registry"`. **Zero `../` cross-package imports.**
- The app declares `"keyboards-mcp": "^2"`; `npm install` symlinks the local
  `packages/keyboards-mcp` (v2.0.0) into `node_modules`, satisfying `^2`.
- `keyboards-mcp`'s `tsconfig.json` gains `"declaration": true` so `.d.ts` files exist
  for the `types` entries (the app must type-check its imports of the server).
- **`keyboard_models/` needs no export.** `model-registry` discovers models by scanning
  `join(__dirname, "..", "keyboard_models")` relative to its own `import.meta.url`, then
  dynamic-imports each model by absolute path. Imported from
  `node_modules/keyboards-mcp/dist/shared/model-registry.js`, it scans
  `node_modules/keyboards-mcp/dist/keyboard_models/` — verified to work across the
  package boundary with no code change.
- The model `web/` UI assets the app loads at runtime are **files**, not module imports.
  They are resolved from the resolved `keyboards-mcp` package path — an electron-builder
  packaging detail, not an `exports`-map concern (see Open items / #136).

## Build order

The app imports the server's **compiled** `dist/` (the `exports` map points at
`./dist/...`), so **`keyboards-mcp` builds before the app**. The root delegator scripts
encode that order. The app's own `tsc` then compiles its `src/` → its own `dist/`.

## Scripts split

- **Root** (`package.json`): thin `npm -w` delegators only (e.g. `build`, `test`, `lint`
  fanning out to the workspaces in dependency order). No app/server logic.
- **`keyboards-mcp`**: keeps `build`, `start`, `dev`, `mcb`, `lint`, `test*`,
  `test:check`, `test:ci`. **Drops** `sar*`, `presar*`, `copy:peaks-vendor`,
  `copy:agent-vendor`, `build:sdk`, `generate:audio-analysis-types` (all move to the app).
- **`sounds-and-recreation-app`**: gains `sar`, `sar:debug`, `sar:headless`, `sar:dist`,
  `presar*`, `copy:*-vendor`, `generate:audio-analysis-types`, and the electron-builder
  `build` block (moved verbatim from the current root `package.json`; its `files`/
  `extraMetadata` globs are rebased onto the app's own `dist` + the model `web/` assets
  pulled from the `keyboards-mcp` dependency).

## Testing strategy ("stay green")

- All tests stay under `packages/keyboards-mcp/tests/`. The two spawn helpers
  (`mock-process.ts`, `multi-device-harness.ts`) are retargeted to launch the app's
  headless mock from its new path (`../sounds-and-recreation-app/src/cli.ts`, or via the
  app's `sar:headless` script). The MCB spawn stays pointed at keyboards-mcp's own
  `src/mcb/index.ts`.
- **Green bar for #135**: `lint` + `test:check` (type-check) + `test:unit`, plus the
  app's `tsc` build succeeding and resolving `keyboards-mcp/shared/*`.
- The CoreMIDI-dependent `test:integration` / `test:e2e:mcb` suites keep their **existing
  environment gating** — they open virtual CoreMIDI ports and require a GUI/CI-Docker
  session with `MIDI_TRANSPORT=ws`; this split does not change that contract, only the
  path the helpers spawn.
- **`npm pack --dry-run`** on `packages/keyboards-mcp` confirms the published tarball
  stays lean (app code absent; `dist/shared/**`, `dist/keyboard_models/**`, `dist/mcb/**`
  still present).

## External references to update

Because the server moves to `packages/keyboards-mcp/`, references to its `dist` path may change.

**In-repo — mostly safe, verify:**
- The server's own `package.json` entries (`main: dist/index.js`, `start: node dist/index.js`)
  are **relative to the package** and move with it — they stay valid, no edit needed.
- There is **no `.mcp.json`** in this repo, so nothing to repoint there.
- `Dockerfile` + `docker-compose.test.yml`: verify their **build context** still resolves
  after the move (if the context was the repo root, it now points into `packages/keyboards-mcp/`).
- `docs/plans/**` and prior `specs/**` are an immutable historical record (per the #126
  convention) — **not** rewritten.

**Out-of-repo (flag + coordinate; NOT edited here):**
- Sibling `sound-recreation-agent`'s default `--keyboards-mcp ../keyboards-mcp/dist/index.js`
  now needs `…/packages/keyboards-mcp/dist/index.js`.
- The parent-dir umbrella `CLAUDE.md` (the `sounds-and-recreation/` monorepo doc) references
  the same path.
- `macos-packager` is a scaffold plan only; note the path change for whenever it lands.

These are listed in the implementation plan as a coordination checklist; #135's PR
description will call them out so the agent/parent-docs can be updated in lockstep.

## Scope

**In #135:**
- Root umbrella `package.json` + `packages/*` workspaces config + single root lockfile.
- Move the current package into `packages/keyboards-mcp/` (src, tests, tsconfig, eslint
  config, README/CHANGELOG/LICENSE, Dockerfile, compose, data).
- Move `audio-analysis-client/` + `mockrack-format.ts` (and the openapi codegen script)
  into `packages/sounds-and-recreation-app/`.
- Add the `exports` map + `declaration: true` to `keyboards-mcp`.
- Create the app `package.json` (`private`, initial `version: 0.1.0`, `"keyboards-mcp": "^2"`,
  electron stack deps, app scripts + electron-builder block).
- Rewrite the app's cross-package imports to `keyboards-mcp/shared/*`.
- Retarget the two test spawn helpers.
- Fix in-repo path references.
- Result: the app builds and imports shared logic via the dependency; test suites green.

**Out (other sub-issues / separate concerns):**
- **#136** — making the app version *authoritative*: electron-builder `extraMetadata.version`
  → `CFBundleShortVersionString`. (This spec sets `0.1.0` as the initial value but does
  **not** wire the bundle-stamping.)
- **#137** — adopting Changesets (per-package versions + changelogs).
- **#138** — release automation (prefixed tags / `changesets/action`; publish only
  `keyboards-mcp`, skip the private app).
- A clean per-package test split (app tests moving into the app package).
- Extracting `shared`/`keyboard_models` into a separate `core` package.

## Open items (default chosen, recorded for transparency)

- **Repo-level `docs/`** stays at the **repo root** (monorepo-level specs/plans that span
  both packages), rather than moving under `packages/keyboards-mcp/`. The package's own
  published docs (README/CHANGELOG/LICENSE) move with the package. Disposition of
  `keyboards-mcp`'s `CLAUDE.md` (root vs package) is a plan-time detail; default is to
  keep it with the package it documents and add a thin root note.
- **App initial version** is `0.1.0` (brand-new, still-stabilizing — not `2.0.0`).
  Version *stamping into the bundle* is deferred to #136.

## Risks

- **Large git move.** Moving the whole package into `packages/keyboards-mcp/` is a big
  rename diff. Mitigate with `git mv` (preserves history) and a post-move repo-wide grep
  for stale `src/`/`dist/` path references.
- **Types across the boundary.** The app can't type-check `keyboards-mcp/shared/*` without
  emitted `.d.ts`. Mitigate by enabling `declaration: true` and verifying `test:check`
  passes in the app.
- **Build-order coupling.** The app needs `keyboards-mcp`'s `dist` present. Mitigate by
  ordering the root delegators (server build → app build) and documenting it.
- **`files` whitelist drift.** The move must not pull app code into the published tarball.
  Mitigate with `npm pack --dry-run` as a checklist item (carried over from the #126 spec).
- **Out-of-repo path drift.** The sibling agent and parent docs spawn the server by path;
  if not updated in lockstep, `dev:full`/end-to-end wiring breaks. Mitigate via the
  coordination checklist in the PR description.

## Done when

- The repo is a `packages/*` workspaces monorepo with a private root umbrella and a single
  root lockfile.
- `keyboards-mcp` lives at `packages/keyboards-mcp/`, stays on `2.0.x`, ships the same lean
  tarball (`npm pack --dry-run` confirms app code absent), and exposes a `shared/*` exports
  map.
- `sounds-and-recreation-app` lives at `packages/sounds-and-recreation-app/`, is `private`
  at `0.1.0`, declares `"keyboards-mcp": "^2"`, and imports shared logic **only** by package
  name — no `../` cross-package imports.
- The app builds (`tsc`) and resolves `keyboards-mcp/shared/*` (with types).
- `lint`, `test:check`, and `test:unit` are green; the CoreMIDI integration/e2e suites run
  unchanged under their existing gating.
