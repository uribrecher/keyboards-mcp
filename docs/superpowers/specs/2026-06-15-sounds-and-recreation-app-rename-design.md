---
topic: sounds-and-recreation-app-rename
issue: https://github.com/uribrecher/keyboards-mcp/issues/126
status: design
related:
  - ./2026-06-14-installable-mcp-broker-daemon-design.md   # #124/#125 — the lean hardware-owner package this builds on
  - ../../../../macos-packager/8d-macos-packager.md         # sibling repo — the cross-component installer that consumes this app's .app
---

# Rename Mock Runner → "Sounds and Recreation" + standalone `.app` build

## Problem

The Electron "Mock Runner" has outgrown its name. It is no longer a bare hardware
simulator — it is the product's **desktop UI facade** over all the underlying
processes: the two MCP servers (`keyboards-mcp`, `audio-analysis-mcp`) and the
agent (`sound-recreation-agent`). It hosts in-process mock keyboard devices, a
**Song Analysis** workbench (jobs / stems / structure, wired to
`audio-analysis-mcp`), a **CHAT** console (talk to the agent), and waveform panes.

Two gaps follow from that:

1. **Identity.** The app still calls itself "Mock Runner" everywhere a user can see
   (`app.setName`, the chassis strip, `productName`, README, docs), which
   undersells and mislabels it.
2. **Distribution.** PR #125 deliberately excluded the app from the published npm
   tarball (Electron + `peaks.js` + `konva` + `waveform-data` and the `file:`
   `@sounds-and-recreation/agent-client` dep moved to `devDependencies`;
   `dist/mock-runner/**` dropped from the `files` whitelist) to keep the
   hardware-owner package lean. As a result there is **no build path that emits a
   distributable app bundle** for a hardware-less user.

This is the follow-up split out of #124 (see the
[installable-broker design](./2026-06-14-installable-mcp-broker-daemon-design.md),
"Scope → Out") and issue #126.

## Goal

Rename the app's **product identity** to **"Sounds and Recreation"** and add a
build path that produces an unsigned **`Sounds and Recreation.app`** bundle — a
**standalone UI facade** that launches and runs the mock-device path with no other
process, while its agent- and audio-backed panels degrade gracefully when those
services are absent.

## Scope

**In:**
- Surface rename of the app's identity and its directory/entry points to
  "Sounds and Recreation" (see "Rename boundary" below).
- An `electron-builder` config + npm script (`sar:dist`) that produces an
  **unsigned, unpacked `Sounds and Recreation.app`** (mac `target: dir`).
- Confirming (and fixing if needed) the **standalone runtime guarantee**: the app
  launches and the mock-device + MIDI-monitor path works with zero other
  processes; CHAT and Song Analysis degrade gracefully via the existing
  service-health chip.
- Updating user-facing docs (README, `CLAUDE.md`, `docs/mock_runner.md`).

**Out (owned elsewhere, tracked as follow-ups):**
- `.dmg` / `.pkg`, code-signing, and notarization — owned by **`macos-packager`**,
  which consumes this `.app`.
- Embedding or spawning the MCPs / agent inside the app. The app stays a facade;
  the cross-component **installer** (app + both MCPs + agent launched together) is
  `macos-packager`'s job.
- Extracting the app into its own repo. It is tightly coupled to `keyboards-mcp`
  internals (`MockTransport`, `model-registry`, `mcb-client`, `mockrack-format`,
  `AudioAnalysisClient`); extraction is a separate, larger effort and is not
  attempted here.

## How this maps to issue #126

#126 asks for a hardware-less end-to-end path. This issue delivers the **app half**:
the distributable `Sounds and Recreation.app` provides a **mock keyboard to drive**,
and combined with the existing #125 global install (the `keyboards-mcp` MCP server +
the MCB launchd daemon) that *is* the genuine "exercise `keyboards-mcp` end-to-end
with no hardware" path. The CHAT and Song-Analysis features are bonus that light up
only when the agent / audio services are running. The full **one-double-click whole
system** experience is `macos-packager`'s job. The spec states this plainly so
#126's "Done when" stays honest.

## Decisions (settled with the issue author)

1. **Approach:** rename the app **in place** in `keyboards-mcp` (not extracted to a
   new repo) **and** add a standalone app build. One shippable PR.
2. **Name:** display/product name **"Sounds and Recreation"**; in-repo
   directory + npm-script identifier **`sounds-and-recreation-app`** (the `-app`
   suffix disambiguates from the umbrella *website* repo, which is already named
   `sounds-and-recreation`); Electron `appId: io.sounds-and-recreation`.
3. **Standalone:** the app does **not** embed/spawn the MCPs or agent. Mock devices
   run in-process; agent/audio panels are external clients that degrade gracefully.
4. **Artifact boundary:** this issue produces an **unsigned, unpacked `.app`** only.
   `macos-packager` owns `.dmg`/`.pkg`, signing, and notarization. No signing logic
   is duplicated.
5. **Rename depth:** **surface rename** — rename the app/product identity and its
   directory, but **preserve internal device-simulation vocabulary** (see below).
6. **Save format:** keep the `.mockrack` extension and `mockrack-format.ts`
   unchanged (file compatibility; the format is internal).

## Rename boundary (surface rename)

Rename the **app/product identity and its directory**; keep internal
device-simulation terms. "Sounds and Recreation" is the *app/product*; "mock" stays
the correct term for *simulated devices* inside it.

**Rationale:** "mock" genuinely describes simulated devices — one feature of the app,
not the app itself. The mock symbols are **shared with the published MCP server**
(`mock-registry` is imported by `src/tools/connect.ts`; `mockrack-format` by the app;
the `MOCK_WS_URL` / `MOCK_MODEL_ID` / `MOCK_READY` env contract drives CI). Renaming
them would ripple destructively through every keyboard model, the codec contract,
the broker, and the tests, for zero user-facing benefit.

### Renamed

| What | From | To |
|------|------|----|
| Source directory | `src/mock-runner/` | `src/sounds-and-recreation-app/` |
| App display name | `app.setName("Mock Runner")` | `app.setName("Sounds and Recreation")` |
| Electron build metadata (package.json `build`) | `appId: io.mock-runner`, `productName: "Mock Runner"` | `appId: io.sounds-and-recreation`, `productName: "Sounds and Recreation"` |
| npm scripts | `mock:runner`, `mock:runner:debug`, `mock:headless`, `premock:runner*` | `sar`, `sar:debug`, `sar:headless`, `sar:dist`, `presar*` |
| UI strings / chassis | "MOCK RUNNER" tab strip + window/menu labels | "SOUNDS AND RECREATION" |
| Docs | `README.md`, `CLAUDE.md`, `docs/mock_runner.md` (title + body) | "Sounds and Recreation" |

### Preserved (NOT renamed)

- Internal symbols: `MockTransport`, `MockHandler`, `MockHandlerResult`, the
  `MidiCodec` contract.
- `mock-registry.ts` and its API (imported by `src/tools/connect.ts`).
- `.mockrack` save format and `mockrack-format.ts`.
- CI/test contract: `MOCK_WS_URL`, `MOCK_MODEL_ID`, the `MOCK_READY` stdout token,
  headless-mock semantics (`sar:headless` keeps emitting `MOCK_READY`).
- `src/mcb/http/mocks.ts` route semantics.
- `docs/plans/completed/**` and historical specs — immutable record of past work;
  not rewritten.

## Architecture

The app keeps its current three-collaborator runtime (`MockHandler` / `MidiCodec` /
`MockTransport`) and its shell layout (MIDI view + Song Analysis view + console
drawer). Nothing about the runtime wiring changes — only identity strings, the
directory name, paths/imports that reference it, and a new packaging path.

```
Sounds and Recreation.app  (unsigned, electron-builder target: dir)
  └─ Electron shell  =  src/sounds-and-recreation-app/  (was src/mock-runner/)
       ├─ in-process mock devices  (MockTransport per tab — works with NO other process)
       ├─ CHAT console            → sound-recreation-agent   (external; degrades gracefully)
       └─ Song Analysis workbench → audio-analysis-mcp       (external; degrades gracefully)

npm publish  → lean keyboards-mcp MCP server   (files whitelist unchanged; app excluded)
sar:dist     → Sounds and Recreation.app        (electron-builder; pulls Electron stack from devDeps)
```

### Two outputs from one package (coexistence with #125)

The standalone app build is **fully independent of `npm publish`**:

- `npm publish` continues to use the top-level `files` whitelist → **lean MCP
  server tarball** (app still excluded; #125 behavior untouched).
- `electron-builder` has its **own `files` / `extraResources` globs** and pulls the
  Electron stack (`electron`, `peaks.js`, `konva`, `waveform-data`, the `file:`
  agent-client) from `devDependencies` — legal because this is a build, not a
  publish.

These two paths never interact: `files` whitelist governs the tarball; the
`electron-builder` config governs the `.app`.

## Implementation outline

1. **Directory move:** `git mv src/mock-runner src/sounds-and-recreation-app`;
   update imports/paths in `main.ts`, `transport.ts`, `cli.ts`, `shell/*`,
   `tests/helpers/mock-process.ts`, `tests/helpers/multi-device-harness.ts`, and any
   `dist/mock-runner` reference in scripts/docs. Internal symbol names unchanged.
2. **Identity:** `app.setName(...)`; package.json `build` block (`appId`,
   `productName`); UI chassis/menu strings; doc titles/body.
3. **Scripts:** rename `mock:*` → `sar*`; keep the `build:sdk` + vendor-copy
   pre-steps under the new `presar*` hooks (must NOT run on consumer `npm i`).
4. **electron-builder:** add `electron-builder` to `devDependencies`; rewrite the
   stale `build` key (or move to `electron-builder.yml`) with mac `target: dir`, its
   own `files`/`extraResources` covering `dist/sounds-and-recreation-app/**`, the
   model `web/` UIs, and the vendored `peaks`/`konva`/`waveform-data`. `sar:dist` =
   `build:sdk` + vendor copy + `tsc` + `electron-builder --dir`.
5. **Standalone guarantee:** verify the app launches and the mock path works with no
   agent / no audio service; confirm CHAT + Song Analysis show "service unavailable"
   via the existing service-health chip rather than erroring (fix if not).

## Open sub-question (default chosen, recorded for transparency)

The `.mockrack` save-file extension is **kept as-is** (file compatibility; internal
format). Rebranding the extension was considered and rejected.

## Testing strategy

- **Regression:** the full `node:test` suite (`test:unit` / `test:integration` /
  `test:e2e:mcb` / `test:e2e`) stays green after the dir/symbol-preserving rename —
  only paths change, no behavior. `npm run lint` and `test:check` stay green.
- **Test-helper update:** `tests/helpers/mock-process.ts` and
  `multi-device-harness.ts` point at the new path; assert the headless mock
  (`sar:headless`) still emits the `MOCK_READY` token and serves WS state.
- **Packaging smoke:** a check that `sar:dist` produces `Sounds and Recreation.app`,
  guarded so a CI host without the electron-builder deps skips gracefully (mirrors
  the `KBMCP_INSTALL_REAL`-style gating used by the installer integration tests).
- **Manual acceptance** (recorded in the plan): build the `.app`; launch it with no
  other processes; confirm a mock device connects and drives MIDI; confirm CHAT and
  Song Analysis degrade gracefully; confirm `.mockrack` save/load still works.

## Risks & open items

- **`electron-builder` introduction:** new dev dependency + macOS-only build tooling.
  Mitigate by targeting `dir` (no signing/notarization here) and gating the
  packaging smoke test.
- **Path drift after the move:** stale `src/mock-runner` / `dist/mock-runner`
  references in scripts, `.run/` configs, docker-compose, or docs. Mitigate with a
  repo-wide grep for `mock-runner` (live source/config only — not
  `docs/plans/completed/**`) as a post-move checklist item.
- **Docs-site links:** `docs/mock_runner.md` is published to the GitHub Pages docs
  site (`docs/index.html`, `site-assets/`, `.nojekyll`). Renaming the file could
  break inbound links — keep the filename or add a redirect; decided at
  implementation time.
- **`files` whitelist accidentally broadened:** the rename must not pull
  `dist/sounds-and-recreation-app/**` into the npm `files` whitelist — verify with
  `npm pack --dry-run` that the published tarball stays lean (app absent).

## Done when

- The app's user-visible identity is "Sounds and Recreation" everywhere (window,
  menu, chassis, `productName`, README, docs); internal "mock" device vocabulary
  preserved.
- `sar:dist` produces an unsigned `Sounds and Recreation.app` that launches
  standalone, runs the mock-device path with no other process, and degrades
  gracefully on the agent/audio panels.
- The published npm tarball is unchanged/lean (`npm pack --dry-run` confirms the app
  is still excluded).
- The full test suite, lint, and type-check are green.
