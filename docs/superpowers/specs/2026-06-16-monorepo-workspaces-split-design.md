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

5. **Spawn-based tests stay in `keyboards-mcp`; app-only *unit* tests move with the app.**
   The chosen strategy is "keep tests in keyboards-mcp, retarget paths" — which holds for
   the server/shared/model unit tests, the MCP e2e tests, and the integration/e2e:mcb
   tests that launch the mock as a **subprocess** (those only need the two spawn helpers,
   `tests/helpers/mock-process.ts` + `multi-device-harness.ts`, retargeted to the app's
   new path). **Forced exception:** ~5 app-only unit tests **import app modules directly**
   (verified: `transport-state-changed`, `mock-runner-ui-emit`, `mock-runner/event-log-ipc`,
   `mock-runner/unread-state`, and the `packaging-config`/`packaging-artifact` tests of the
   electron-builder `build` block). Keeping those in keyboards-mcp once the app moves would
   recreate the cross-package `../` imports this split removes — and the `src/**` coverage
   gate wouldn't count app code anyway. So those move into a new
   `packages/sounds-and-recreation-app/tests/` alongside the code they test.

## Target layout

```
keyboards-mcp/                          (repo root — NEW private workspaces umbrella; never published)
├── package.json                        { "private": true, "workspaces": ["packages/*"], thin delegator scripts }
├── package-lock.json                   (single root lockfile)
├── .claude-plugin/plugin.json          (Claude Code plugin manifest — marketplace discovery; STAYS at root)
├── README.md                           (GitHub repo + marketplace face; STAYS at root, unchanged during review)
├── LICENSE                             (GPL-3.0-or-later; STAYS at root for the marketplace/GitHub URL)
├── PRIVACY.md                          (privacy-policy md referenced by the marketplace form; STAYS at root)
├── docs/                               (repo-level specs/plans + the GitHub Pages source at /docs; STAYS at root)
├── .github/workflows/                  (ci.yml + release.yml — repo CI; STAY at root, internals updated)
├── .run/                               (JetBrains run configs — repoint each to its workspace package.json)
├── Dockerfile                          (CI test image — monorepo test infra; STAYS at root, workspace-aware)
├── docker-compose.test.yml             (CI mock/mcb/test/coverage services; STAYS at root, command paths updated)
├── .gitignore  .dockerignore           (STAY at root; vendor-dir path + nested-match patterns updated)
├── CLAUDE.md                           (monorepo guidance; build/test/run commands updated to the workspace form)
└── packages/
    ├── keyboards-mcp/                  (the published npm server — stays on the 2.0.x line)
    │   ├── package.json                name keyboards-mcp, bin, files whitelist, + NEW exports map
    │   ├── tsconfig.json  tsconfig.test.json   (moved in; tsconfig ALREADY has "declaration": true)
    │   ├── eslint.config.js            (moved in; root "lint" delegates across workspaces)
    │   ├── README.md  LICENSE  CHANGELOG.md   (npm tarball copies: README + LICENSE copied for the package; CHANGELOG moves here — see Marketplace constraints)
    │   ├── src/                        index.ts server.ts cli/ mcb/ tools/ midi/ shared/ keyboard_models/
    │   └── tests/                      server/shared/model unit + MCP e2e + spawn-based integration/e2e:mcb (helpers retargeted)
    └── sounds-and-recreation-app/      (private app — initial version 0.1.0)
        ├── package.json                { "private": true, deps: { "keyboards-mcp": "^2", electron stack, agent-client (file: depth fixed) }, electron-builder build block }
        ├── tsconfig.json  eslint.config.js     (the app's own)
        ├── src/                        main.ts cli.ts transport.ts shell/ preload.cjs
        │                               audio-analysis-client/   (MOVED in, + openapi codegen)
        │                               mockrack-format.ts        (MOVED in from shared/)
        └── tests/                      app-only unit tests that import app code (transport, ui-emit,
                                        event-log-ipc, unread-state, packaging-config/artifact) — MOVED in
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
- `keyboards-mcp`'s `tsconfig.json` **already has `"declaration": true`** (verified), so the
  `.d.ts` files for the `types` entries are already emitted — no tsconfig change needed for
  types; the app type-checks its imports of the server against them.
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
- `Dockerfile` + `docker-compose.test.yml` **stay at the repo root** as monorepo test infra and
  need internal updates — see the **Global / repo-root breakage inventory** below.
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

## Global / repo-root breakage inventory

Every root-level / cross-package artifact that silently assumes the package sits at the repo
root. Anything not cleanly owned by one package is a risk; this is the explicit checklist, and a
**green CI run on the PR is the backstop**. `main` is currently **not** branch-protected, so
there are no required-status-check names to preserve — but keep CI job names stable for when it is.

| Artifact | Disposition | Required change |
|---|---|---|
| `.github/workflows/ci.yml` | stays at root | `lint`: root script delegates across workspaces. **`audit`: scope to `--workspace keyboards-mcp`** so the app's Electron deps don't pollute the "what `npm i -g keyboards-mcp` installs" audit. `test`/`coverage`: compose path + `.coverage-out` bind-mount stay valid; **re-validate the 90% gate** (measured surface shifts). |
| `.github/workflows/release.yml` | stays at root | **Goal for #135: keep the *current* single-package release working** — nothing more. Version check → read `packages/keyboards-mcp/package.json` (not the private root umbrella). `npm publish` → `-w keyboards-mcp` (a root publish would try to publish the private umbrella). OIDC trusted publishing binds to repo + `release.yml` filename → unchanged. The separate per-package release redesign (prefixed tags / `changesets/action`) is **#138** — explicitly out of scope here. |
| `Dockerfile` | **stays at root** | Workspace-aware: copy each `packages/*/package.json` before `npm ci`, then `COPY . .`; `npm run build` builds the `keyboards-mcp` workspace (the app resolves `keyboards-mcp/shared/*` from its built `dist`). |
| `docker-compose.test.yml` | **stays at root** | Repoint service `command:`s — `src/sounds-and-recreation-app/cli.ts` → `packages/sounds-and-recreation-app/src/cli.ts`, `src/mcb/index.ts` → `packages/keyboards-mcp/src/mcb/index.ts`; run `test:ci`/`test:coverage` scoped to keyboards-mcp; fix the `coverage.lcov` `cp` source path (now under `packages/keyboards-mcp/`). |
| `.gitignore` | stays at root | **`src/sounds-and-recreation-app/shell/vendor/` → `packages/sounds-and-recreation-app/src/shell/vendor/`** (else the build-time vendored bundles stop being ignored). `dist/`, `dist-app/`, `node_modules/`, `coverage.lcov` are non-anchored → still match nested; confirm. |
| `.dockerignore` | stays at root | Patterns (`node_modules`, `dist`, `*.md`) are non-anchored → still apply under the root build context; confirm no workspace `package.json` is excluded. |
| `.run/mcb.run.xml`, `.run/sar.run.xml` | stay at root | JetBrains run configs point `package-json` at `$PROJECT_DIR$/package.json` (the umbrella, which won't have `mcb`/`sar`). Repoint: `mcb` → `packages/keyboards-mcp/package.json`, `sar` → `packages/sounds-and-recreation-app/package.json`. (DX only.) |
| `tsconfig.json` / `tsconfig.test.json` | move to keyboards-mcp | Move with the server (`rootDir: src`, `include: src/**`); already has `declaration: true`. The **app gets its own** `tsconfig` (Node16 resolution so `keyboards-mcp/shared/*` + its `.d.ts` resolve) and, for its moved-in tests, a test tsconfig. |
| `eslint.config.js` | per-package | References `src/`, `tests/`, `./tsconfig.test.json` (relative). Moves into keyboards-mcp; the **app gets its own** flat config. Root `lint` delegates (`--workspaces --if-present`). |
| `CLAUDE.md` (repo) | root, updated | Build/test/run command docs change to the workspace form (`npm run … -w …`). The **parent-dir** `CLAUDE.md` (out-of-repo) is covered under External references. |
| `package.json` `build` (electron-builder) | moves to app | Rebase `files` / `extraMetadata` / `directories.output: dist-app` onto the app's own `dist` + the model `web/` assets pulled from the `keyboards-mcp` dependency. |
| `@sounds-and-recreation/agent-client` `file:` dep, `build:sdk --prefix`, `copy:agent-vendor` | move to app | **Re-depth the relative path to the sibling repo:** `../sound-recreation-agent` → `../../../sound-recreation-agent`. Vendor-copy src/dest paths update with the app move. |
| `prebuild` / `copy:peaks-vendor` | move to app | Server `build` becomes plain `tsc` (no vendoring). Vendoring runs under the app's build / `presar*` hooks. No consumer `postinstall` exists (and none is added) — consumer `npm i` stays clean. |
| `.claude/`, `.mcp.json` (gitignored) | n/a | Local/untracked dev config, not coupled to the package location. |

## Marketplace submission constraints (registration under review)

`keyboards-mcp` is mid-review for the Anthropic / Claude Code plugin marketplace. The
submitted form references repo-level artifacts and the published npm package; the
restructure must not disturb any of them. Verified against `.claude-plugin/plugin.json`
and the live Pages config (`gh api repos/uribrecher/keyboards-mcp/pages` →
`source: { branch: main, path: /docs }`):

| Form / manifest reference | Value | Restructure impact |
|---|---|---|
| GitHub repo URL | `github.com/uribrecher/keyboards-mcp` | none — repo unchanged |
| GitHub Pages URL | `uribrecher.github.io/keyboards-mcp/` | none — derived from repo name; Pages serves `main:/docs`, and `docs/` stays at root |
| Privacy policy | `PRIVACY.md` (repo root) | **must stay at root** to preserve the URL |
| License | `GPL-3.0-or-later` | none — a type value, not a moved file; `LICENSE` also stays at root |
| Plugin manifest | `.claude-plugin/plugin.json` (repo root) | **must stay at root** (Claude Code marketplace discovery) |
| MCP server launch | `npx -y keyboards-mcp@2.0.0` | none — resolves the **published npm package**, not a repo path |

**Hard constraints added by this finding:**
- `.claude-plugin/plugin.json`, `PRIVACY.md`, `LICENSE`, `README.md`, and `docs/` **stay at the
  repo root, unchanged** — they are the GitHub/marketplace face. This **revises** the earlier
  "move README/LICENSE into the package" idea: the **package keeps its own copies** of `README.md`
  + `LICENSE` for the npm tarball (LICENSE duplicates the root GPL-3.0 text), while the
  authoritative root copies are left untouched. `CHANGELOG.md` moves into the package (it is the
  server changelog and is not marketplace-referenced).
- The published package name (`keyboards-mcp`) and the `2.0.x` version line are preserved, so the
  manifest's `npx keyboards-mcp@2.0.0` keeps resolving. The root umbrella `package.json` is
  `private` and is **not** the published package, so it never affects `npx keyboards-mcp`.

**Timing — author's call:** because the form is under review, decide whether to (a) land this
restructure now (safe per the table above, but the repo visibly reshapes mid-review), or (b) hold
the PR merge until the marketplace registration is approved, keeping the branch ready. Either way
the restructure is internal and preserves every referenced value.

## Scope

**In #135:**
- Root umbrella `package.json` + `packages/*` workspaces config + single root lockfile +
  thin delegator scripts.
- Move the server into `packages/keyboards-mcp/` (`src`, `tests`, `tsconfig.json`,
  `tsconfig.test.json`, `eslint.config.js`, package `README`/`LICENSE` copies + `CHANGELOG`).
- Move the app into `packages/sounds-and-recreation-app/` with its own `package.json`,
  `tsconfig`, `eslint.config.js`; move in `audio-analysis-client/` + `mockrack-format.ts`
  (+ openapi codegen), the app scripts (`sar*`, `presar*`, vendor copies, `build:sdk`), the
  electron-builder `build` block, and the ~5 app-only unit tests.
- Add the `exports` map to `keyboards-mcp` (`tsconfig` already emits `.d.ts`).
- Rewrite the app's cross-package imports to `keyboards-mcp/shared/*`; **re-depth** the sibling
  `file:` agent-client dep + `build:sdk --prefix` (`../` → `../../../sound-recreation-agent`).
- **Fix every global/repo-root artifact** per the inventory: `ci.yml` (workspace-scoped lint +
  audit), `release.yml` (**only** enough to keep the current single-package publish working from
  the new location), `Dockerfile` / `docker-compose.test.yml` (workspace-aware build + command
  paths), `.gitignore` (vendor-dir path), `.run/*` (workspace package.json), root `CLAUDE.md`.
- Retarget the two test spawn helpers.
- Result: the app builds and imports shared logic via the dependency; CI (lint / audit / test /
  coverage) and the local suites stay green; the existing `keyboards-mcp` npm release still works.

**Out (other sub-issues / separate concerns):**
- **#136** — making the app version *authoritative*: electron-builder `extraMetadata.version`
  → `CFBundleShortVersionString`. (This spec sets `0.1.0` as the initial value but does
  **not** wire the bundle-stamping.)
- **#137** — adopting Changesets (per-package versions + changelogs).
- **#138** — release-automation *redesign*: per-package releases via prefixed tags /
  `changesets/action`, publishing only `keyboards-mcp` and skipping the private app. #135 makes
  **no** release redesign — it only keeps the existing single-package `v*` publish working from
  the package's new location.
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
  emitted `.d.ts`. Already mitigated — `tsconfig` has `declaration: true`; verify the app's
  `test:check` resolves the types.
- **Build-order coupling.** The app needs `keyboards-mcp`'s `dist` present. Mitigate by
  ordering the root delegators (server build → app build) and documenting it.
- **Global-artifact drift.** Root-level files that assume the package sits at the root
  (`ci.yml`, `release.yml`, `Dockerfile`, `docker-compose.test.yml`, `.gitignore`, `.run/*`,
  `eslint`/`tsconfig`, the sibling `file:` dep) silently break if missed — this is the gap that
  prompted the inventory. Mitigate by treating the **Global breakage inventory** as a checklist
  plus a green CI run on the PR.
- **Audit-scope regression.** The `audit` CI job must stay scoped to the *published* package's
  prod deps; an unscoped workspace audit folds in the app's Electron deps and changes the signal.
  Mitigate with `--workspace keyboards-mcp`.
- **Coverage-gate surface shift.** App code leaves `keyboards-mcp/src` and the app-only unit tests
  move out, so the 90%-line gate is measured over a different surface. Re-validate it passes
  (coverage CI is already a sore spot — it must not regress).
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
- **CI is green end-to-end** (`lint`, `audit`, `test`, `coverage` — the Docker harness + the
  90% gate), and every artifact in the Global breakage inventory is updated.
- The **existing `keyboards-mcp` npm release still works**: `release.yml`'s version-check reads
  `packages/keyboards-mcp/package.json` and `npm publish` targets that workspace (no release
  *redesign* — that's #138).
