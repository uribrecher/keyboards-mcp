# Rename Mock Runner → "Sounds and Recreation" + standalone `.app` build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface-rename the Electron app's product identity to "Sounds and Recreation", relocate its source directory, and add an `electron-builder` path that emits an unsigned, standalone `Sounds and Recreation.app`.

**Architecture:** A *surface* rename — the app/product identity and its directory move to "Sounds and Recreation" / `sounds-and-recreation-app`, but internal device-simulation vocabulary (`MockTransport`, `MockHandler`, `MidiCodec`, `mock-registry`, `.mockrack`, the `MOCK_WS_URL`/`MOCK_MODEL_ID`/`MOCK_READY` CI contract) is preserved because it is shared with the published MCP server. Packaging is a second, independent output: `npm publish` stays lean (app excluded via the `files` whitelist); `electron-builder` builds the fat app from devDependencies.

**Tech Stack:** TypeScript 5.5 (ESM, `tsc`), Electron 41, electron-builder (new dev dep), `node:test` + `node:assert` (zero-dep), `tsx`.

**Spec:** `docs/superpowers/specs/2026-06-15-sounds-and-recreation-app-rename-design.md`

---

## Preamble — environment & known constraints (read before Task 1)

- **Worktree deps:** this runs in a git worktree where `node_modules` may be absent. Install first: `npm ci` (if a `node_modules` symlink from the main checkout causes trouble, remove it and re-run `npm ci` against the committed lockfile).
- **MIDI test constraint (documented gotcha):** `test:integration` and `test:e2e:mcb` open virtual CoreMIDI ports and **fail headless** (exit 134) unless run in a GUI session or with `MIDI_TRANSPORT=ws`. The **primary regression gates for this plan are `npm run lint`, `npm run test:check`, and `npm run test:unit`**, plus a targeted headless `--no-midi` smoke of the renamed CLI. Run the MIDI integration/e2e suites in the proper environment (GUI/CI-Docker) as a final check; do not block task completion on them headlessly.
- **Out of scope (do not edit here):** the workspace-root `CLAUDE.md` at `~/test/sounds-and-recreation/CLAUDE.md` (different repo/location — track as a separate cross-repo doc follow-up); `.dmg`/`.pkg`/signing (owned by `macos-packager`).
- **Deliberately preserved internal identifiers (file/state compatibility — DO NOT rename):**
  - `.mockrack` extension + `src/shared/mockrack-format.ts` (incl. its `requires Mock Runner v…` version-mismatch string — left per the approved spec's "preserve `mockrack-format.ts`" decision).
  - `.mock-runner.json` per-job sidecar (`JOB_META_FILE`) — renaming would orphan existing job metadata.
  - localStorage keys `mock-runner.chat-history.v1`, `mock-runner:console-w`, `mock-runner:rack-view` — renaming would reset users' saved UI state.
  - `MockTransport`, `MockHandler`, `MockHandlerResult`, `MidiCodec`; `src/shared/mock-registry.ts`; `MOCK_WS_URL`, `MOCK_MODEL_ID`, `MOCK_READY`; the `/v1/mocks/:instanceId` MCB route.
  - Descriptive "mock-runner" comments in `src/shared/*` (they describe the mock subsystem, not the product).

---

## Task 1: Relocate the source directory and repoint every path reference

Moving the directory and fixing all path references is one cohesive change — the tree only compiles and the tests only resolve once every reference points at the new path.

**Files:**
- Move: `src/mock-runner/` → `src/sounds-and-recreation-app/`
- Modify: `src/sounds-and-recreation-app/main.ts:41-42` (was `src/mock-runner/main.ts`)
- Modify: `package.json:23` (`copy:peaks-vendor` — runs on every build via `prebuild`)
- Modify: `.gitignore:17` (the gitignored vendor path)
- Modify: `tests/helpers/mock-process.ts:53` and `:95`
- Modify: `tests/unit/transport-state-changed.test.ts:3`
- Modify: `tests/unit/mock-runner-ui-emit.test.ts:18`
- Modify: `tests/unit/mock-runner/unread-state.test.ts:3`
- Modify: `tests/unit/mock-runner/event-log-ipc.test.ts:9`
- Modify: `docker-compose.test.yml:8`

- [ ] **Step 1: Move the directory with git**

```bash
git mv src/mock-runner src/sounds-and-recreation-app
```

- [ ] **Step 2: Fix the runtime src-path resolver in main.ts**

In `src/sounds-and-recreation-app/main.ts`, lines 41-42, replace:

```ts
// Resolve paths back to src/ (from dist/mock-runner/)
const srcDir = join(__dirname, "..", "..", "src", "mock-runner");
```

with:

```ts
// Resolve paths back to src/ (from dist/sounds-and-recreation-app/)
const srcDir = join(__dirname, "..", "..", "src", "sounds-and-recreation-app");
```

- [ ] **Step 3: Fix the headless-CLI spawn path in the test helper (two spots)**

In `tests/helpers/mock-process.ts`, replace **both** occurrences (line 53 and line 95) of:

```ts
      "src/mock-runner/cli.ts",
```

with:

```ts
      "src/sounds-and-recreation-app/cli.ts",
```

- [ ] **Step 4: Fix the four test import paths**

`tests/unit/transport-state-changed.test.ts:3` and `tests/unit/mock-runner-ui-emit.test.ts:18` — replace:

```ts
import { MockTransport } from "../../src/mock-runner/transport.js";
```

with:

```ts
import { MockTransport } from "../../src/sounds-and-recreation-app/transport.js";
```

`tests/unit/mock-runner/unread-state.test.ts:3` — replace:

```ts
import { nextUnread } from "../../../src/mock-runner/shell/unread-state.js";
```

with:

```ts
import { nextUnread } from "../../../src/sounds-and-recreation-app/shell/unread-state.js";
```

`tests/unit/mock-runner/event-log-ipc.test.ts:9` — replace:

```ts
} from "../../../src/mock-runner/event-log-ipc.js";
```

with:

```ts
} from "../../../src/sounds-and-recreation-app/event-log-ipc.js";
```

*(Note: test file/dir names keep "mock-runner" — they test `MockTransport`/mock behavior, which is preserved vocabulary. Only the import paths change. Test discovery uses `find … -name '*.test.ts'`, so names don't affect discovery.)*

- [ ] **Step 5: Fix the headless-CLI path in docker-compose.test.yml**

In `docker-compose.test.yml`, line 8, replace:

```yaml
    command: npx tsx src/mock-runner/cli.ts --model nord-electro-5d --no-midi --ws-port 3000
```

with:

```yaml
    command: npx tsx src/sounds-and-recreation-app/cli.ts --model nord-electro-5d --no-midi --ws-port 3000
```

- [ ] **Step 6: Fix the `copy:peaks-vendor` vendor path (runs on every build via `prebuild`)**

In `package.json`, line 23, replace every `src/mock-runner/shell/vendor` with `src/sounds-and-recreation-app/shell/vendor`:

```json
    "copy:peaks-vendor": "mkdir -p src/sounds-and-recreation-app/shell/vendor && cp node_modules/peaks.js/dist/peaks.ext.min.js src/sounds-and-recreation-app/shell/vendor/peaks.min.js && cp node_modules/konva/konva.min.js src/sounds-and-recreation-app/shell/vendor/konva.min.js && cp node_modules/waveform-data/dist/waveform-data.min.js src/sounds-and-recreation-app/shell/vendor/waveform-data.min.js",
```

*(Critical: `prebuild` → `copy:peaks-vendor` fires on every `npm run build`. If left at the old path it recreates a stray `src/mock-runner/shell/vendor` and the renamed app's vendored libs go missing. The already-vendored files moved with the `git mv` in Step 1, so this just keeps the refresh script pointed at the new location.)*

Then, in `.gitignore`, line 17, replace:

```gitignore
src/mock-runner/shell/vendor/
```

with:

```gitignore
src/sounds-and-recreation-app/shell/vendor/
```

*(Critical: the vendored `peaks/konva/waveform-data` bundles are gitignored by this rule. Without updating it, the rebuilt bundles at the new path stop being ignored and would get committed as source.)*

- [ ] **Step 7: Verify there are no remaining live `src/mock-runner` / `dist/mock-runner` path references**

Run:

```bash
grep -rnE "src/mock-runner|dist/mock-runner" --include='*.ts' --include='*.js' --include='*.json' --include='*.cjs' --include='*.yml' --include='*.xml' . | grep -vE "node_modules|/dist/|/docs/plans/completed/"
```

Expected: only `package.json` lines 32-34 (the `mock:runner` / `mock:runner:debug` / `mock:headless` script *values*, whose `dist/mock-runner` and `src/mock-runner` paths are renamed in Task 3). No `src/`, `tests/`, `docker-compose`, or `copy:peaks-vendor` hits. (`.run/mock_runner.run.xml` holds the script *name* `mock:runner`, not a slash-path, so it won't appear here — it's renamed in Task 3.)

- [ ] **Step 8: Build and type-check**

Run:

```bash
npm run build && npm run test:check
```

Expected: both succeed (tsc compiles `src/sounds-and-recreation-app/` → `dist/sounds-and-recreation-app/`; test files resolve their imports).

- [ ] **Step 9: Run the unit suite and a headless `--no-midi` smoke**

Run:

```bash
npm run test:unit
npx tsx src/sounds-and-recreation-app/cli.ts --model nord-electro-5d --no-midi --ws-port 3399 & \
  SMOKE_PID=$!; sleep 3; kill $SMOKE_PID 2>/dev/null
```

Expected: `test:unit` passes; the CLI prints `MOCK_READY` before it is killed (proves the relocated headless entry point works without MIDI).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: relocate src/mock-runner -> src/sounds-and-recreation-app + repoint paths"
```

---

## Task 2: Rename the app's user-visible identity strings (main.ts + shell + css)

**Files:**
- Modify: `src/sounds-and-recreation-app/main.ts` (lines 36-39, 193, 351, 452, 466, 468, 496-498)
- Modify: `src/sounds-and-recreation-app/shell/index.html` (lines 6, 24, 36)
- Modify: `src/sounds-and-recreation-app/shell/app.js` (line 1230)
- Modify: `src/sounds-and-recreation-app/shell/style.css` (line 2)

- [ ] **Step 1: Rename the app name + its comment in main.ts (lines 36-39)**

Replace:

```ts
// Set the app name early so the macOS app menu (the leftmost item in the
// menu bar — which Electron auto-generates from app.name when no app menu
// is in the template) reads "Mock Runner" rather than "Electron".
app.setName("Mock Runner");
```

with:

```ts
// Set the app name early so the macOS app menu (the leftmost item in the
// menu bar — which Electron auto-generates from app.name when no app menu
// is in the template) reads "Sounds and Recreation" rather than "Electron".
app.setName("Sounds and Recreation");
```

- [ ] **Step 2: Rename the two save/open dialog file-type labels (lines 193 and 351)**

Replace **both** occurrences of:

```ts
    filters: [{ name: "Mock Runner Setup", extensions: ["mockrack"] }],
```

with:

```ts
    filters: [{ name: "Sounds and Recreation Setup", extensions: ["mockrack"] }],
```

*(Extension stays `mockrack` — preserved format.)*

- [ ] **Step 3: Rename the BrowserWindow title (line 452)**

Replace:

```ts
    title: "Mock Runner",
```

with:

```ts
    title: "Sounds and Recreation",
```

- [ ] **Step 4: Rename the devtools env var + its comment (lines 466-468)**

Replace:

```ts
  // Open renderer DevTools in detached mode when launched via
  // `npm run mock:runner:debug`. Detached so the DevTools window keeps
  // working even if the main window freezes.
  if (process.env.MOCK_RUNNER_DEVTOOLS === "1") {
```

with:

```ts
  // Open renderer DevTools in detached mode when launched via
  // `npm run sar:debug`. Detached so the DevTools window keeps
  // working even if the main window freezes.
  if (process.env.SAR_DEVTOOLS === "1") {
```

*(The `SAR_DEVTOOLS` env var is also set in the `sar:debug` script in Task 3 — keep the names in sync.)*

- [ ] **Step 5: Update the macOS app-menu comment (lines 496-498)**

Replace:

```ts
    // macOS: explicit app menu so the SUBMENU items read "About / Hide
    // / Quit Mock Runner". The BOLD menu-bar label still reads
    // "Electron" in dev because that's the running binary's
    // CFBundleName — it'll switch to "Mock Runner" once the app is
    // packaged via electron-builder (plan: macos-packager).
```

with:

```ts
    // macOS: explicit app menu so the SUBMENU items read "About / Hide
    // / Quit Sounds and Recreation". The BOLD menu-bar label still reads
    // "Electron" in dev because that's the running binary's
    // CFBundleName — it'll switch to "Sounds and Recreation" once the app
    // is packaged via electron-builder (sar:dist).
```

- [ ] **Step 6: Rename the shell `<title>` and chassis brand (index.html lines 6, 24, 36)**

Line 6 — replace `<title>MOCK RUNNER</title>` with `<title>SOUNDS AND RECREATION</title>`.

Line 24 (comment) — replace `The MOCK RUNNER chassis lives inside .panel--midi` with `The SOUNDS AND RECREATION chassis lives inside .panel--midi`.

Line 36 — replace:

```html
              <span class="brand__name">MOCK&nbsp;RUNNER</span>
```

with:

```html
              <span class="brand__name">SOUNDS&nbsp;AND&nbsp;RECREATION</span>
```

*(Leave the `brand__sub` "MULTI-DEVICE TEST RACK" subtitle — it accurately labels the MIDI view's mock-rack purpose.)*

- [ ] **Step 7: Rename the document-title base in app.js (line 1230)**

Replace:

```js
  const base = "Mock Runner";
```

with:

```js
  const base = "Sounds and Recreation";
```

*(Leave the `CHAT_HISTORY_KEY` / `SPLITTER_STORAGE_KEY` / `RACK_VIEW_STORAGE_KEY` localStorage keys unchanged — preserved for user-state compatibility.)*

- [ ] **Step 8: Update the style.css header comment (line 2)**

Replace:

```css
 * MOCK RUNNER — Studio rack chassis hosting per-tab keyboard mock UIs.
```

with:

```css
 * SOUNDS AND RECREATION — Studio rack chassis hosting per-tab keyboard mock UIs.
```

- [ ] **Step 9: Verify no stray visible product-name remains in the app source**

Run:

```bash
grep -rniE "mock[ &]?(nbsp;)?runner|Mock Runner" src/sounds-and-recreation-app | grep -vE "\.mock-runner\.json|mock-runner\.chat-history|mock-runner:console-w|mock-runner:rack-view|incoming MIDI|previous crashed|MCB down"
```

Expected: no matches for the product name (only the preserved `.mock-runner.json` / localStorage-key / descriptive-comment lines are filtered out). Then `npm run build` — expected: success.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: rename app identity strings to 'Sounds and Recreation'"
```

---

## Task 3: Rename npm scripts, Electron build metadata, run-config, and the docs-site card

**Files:**
- Modify: `package.json` (scripts lines 30-34; `build` block lines 70-80)
- Move + modify: `.run/mock_runner.run.xml` → `.run/sar.run.xml`
- Modify: `docs/index.html:67`

- [ ] **Step 1: Rename the script keys and fix their `dist` paths (package.json lines 30-34)**

Replace:

```json
    "premock:runner": "npm run build:sdk",
    "premock:runner:debug": "npm run build:sdk",
    "mock:runner": "electron dist/mock-runner/main.js",
    "mock:runner:debug": "ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 MOCK_RUNNER_DEVTOOLS=1 electron --inspect=5858 dist/mock-runner/main.js 2>&1 | tee /tmp/mock-runner.log",
    "mock:headless": "tsx src/mock-runner/cli.ts",
```

with:

```json
    "presar": "npm run build:sdk",
    "presar:debug": "npm run build:sdk",
    "sar": "electron dist/sounds-and-recreation-app/main.js",
    "sar:debug": "ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 SAR_DEVTOOLS=1 electron --inspect=5858 dist/sounds-and-recreation-app/main.js 2>&1 | tee /tmp/sounds-and-recreation.log",
    "sar:headless": "tsx src/sounds-and-recreation-app/cli.ts",
    "presar:dist": "npm run build:sdk && npm run copy:peaks-vendor",
    "sar:dist": "tsc && electron-builder --dir",
```

*(`sar:dist` is wired here but only works after Task 4 adds `electron-builder`. `presar:dist` re-uses the existing `copy:peaks-vendor` + `build:sdk` steps so the vendored libs and the agent-client SDK are present before packaging.)*

- [ ] **Step 2: Rewrite the Electron `build` block (package.json lines 70-80) into a full electron-builder config**

Replace:

```json
  "build": {
    "appId": "io.mock-runner",
    "productName": "Mock Runner",
    "fileAssociations": [
      {
        "ext": "mockrack",
        "name": "Mock Runner Setup",
        "role": "Editor"
      }
    ]
  }
```

with:

```json
  "build": {
    "appId": "io.sounds-and-recreation",
    "productName": "Sounds and Recreation",
    "asar": false,
    "directories": { "output": "dist-app" },
    "extraMetadata": { "main": "dist/sounds-and-recreation-app/main.js" },
    "files": [
      "dist/sounds-and-recreation-app/**",
      "dist/shared/**",
      "dist/midi/**",
      "dist/keyboard_models/**",
      "dist/audio-analysis-client/**",
      "src/sounds-and-recreation-app/shell/**",
      "src/sounds-and-recreation-app/preload.cjs",
      "src/keyboard_models/**/web/**",
      "package.json"
    ],
    "mac": { "target": "dir" },
    "fileAssociations": [
      {
        "ext": "mockrack",
        "name": "Sounds and Recreation Setup",
        "role": "Editor"
      }
    ]
  }
```

*(Rationale for each setting: `extraMetadata.main` overrides the package's `main: dist/index.js` (the MCP server) → the Electron entry, **only inside the packaged app**; the published npm package keeps `main: dist/index.js`. `asar: false` keeps files plain on disk so main.js's `join(__dirname,"..","..","src",…)` shell-asset resolution and `file://` loads of the vendored `peaks/konva/waveform-data` work without asar-unpack juggling — acceptable for an unsigned `dir` artifact. Both `dist/**` and `src/**` trees are included because the compiled main.js resolves shell + model `web/` assets back into `src/` at runtime. `mac.target: dir` = unpacked `.app`, no `.dmg`/signing.)*

- [ ] **Step 3: Rename the IntelliJ run config**

```bash
git mv .run/mock_runner.run.xml .run/sar.run.xml
```

Then in `.run/sar.run.xml` replace the two `mock:runner` occurrences:

```xml
  <configuration default="false" name="mock:runner" type="js.build_tools.npm" nameIsGenerated="true">
```
→
```xml
  <configuration default="false" name="sar" type="js.build_tools.npm" nameIsGenerated="true">
```

and

```xml
      <script value="mock:runner" />
```
→
```xml
      <script value="sar" />
```

- [ ] **Step 4: Update the docs-site capability card (docs/index.html line 67)**

Replace:

```html
      <div class="item"><strong>Mock runner + broker</strong><p>An Electron mock device with a model-specific web UI; an MCB broker shares MIDI ports across sessions.</p></div>
```

with:

```html
      <div class="item"><strong>Sounds and Recreation app + broker</strong><p>An Electron desktop app (UI facade over the MCPs and agent) with model-specific web UIs and in-process mock devices; an MCB broker shares MIDI ports across sessions.</p></div>
```

- [ ] **Step 5: Verify the renamed headless script runs and emits `MOCK_READY`**

Run:

```bash
npm run build
npm run sar:headless -- --model nord-electro-5d --no-midi --ws-port 3399 & \
  SMOKE_PID=$!; sleep 3; (kill $SMOKE_PID 2>/dev/null)
```

Expected: prints `MOCK_READY` (proves the `sar:headless` script + new path work end-to-end). `--no-midi` avoids CoreMIDI so this works headless.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: rename npm scripts to sar*, update electron build metadata + run config"
```

---

## Task 4: Add `electron-builder` and produce the unsigned `Sounds and Recreation.app`

**Files:**
- Modify: `package.json` (`devDependencies`) — via `npm i -D`
- Create: `tests/unit/packaging-config.test.ts`
- Create: `tests/integration/packaging-artifact.test.ts`
- Modify: `.gitignore` (add `dist-app/`)

- [ ] **Step 1: Write the always-on config-shape unit test (failing first)**

Create `tests/unit/packaging-config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  build?: { appId?: string; productName?: string; extraMetadata?: { main?: string }; mac?: { target?: string } };
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("electron-builder config carries the Sounds and Recreation identity", () => {
  assert.equal(pkg.build?.appId, "io.sounds-and-recreation");
  assert.equal(pkg.build?.productName, "Sounds and Recreation");
  assert.equal(pkg.build?.extraMetadata?.main, "dist/sounds-and-recreation-app/main.js");
  assert.equal(pkg.build?.mac?.target, "dir");
});

test("sar:dist script and electron-builder dev dep are present", () => {
  assert.match(pkg.scripts?.["sar:dist"] ?? "", /electron-builder/);
  assert.ok(pkg.devDependencies?.["electron-builder"], "electron-builder must be a devDependency");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/unit/packaging-config.test.ts`
Expected: FAIL on the second test — `electron-builder must be a devDependency` (not installed yet).

- [ ] **Step 3: Install electron-builder as a dev dependency**

```bash
npm i -D electron-builder
```

- [ ] **Step 4: Run the config-shape test to verify it passes**

Run: `npx tsx --test tests/unit/packaging-config.test.ts`
Expected: PASS (both tests). If the first test fails, the Task 3 `build` block was not applied correctly — fix it.

- [ ] **Step 5: Write the gated artifact-existence integration test**

Create `tests/integration/packaging-artifact.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Heavy electron-builder runs are NOT executed inside the test suite. CI (or a
// developer) runs `npm run sar:dist` first, then sets SAR_CHECK_DIST=1 so this
// test asserts the produced bundle exists. Mirrors the KBMCP_INSTALL_REAL gate
// used by the installer integration tests.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("sar:dist produced Sounds and Recreation.app", { skip: process.env.SAR_CHECK_DIST !== "1" }, () => {
  const distApp = join(repoRoot, "dist-app");
  assert.ok(existsSync(distApp), "dist-app/ missing — run `npm run sar:dist` first");
  // electron-builder emits to dist-app/mac/ or dist-app/mac-arm64/ depending on arch.
  const macDirs = readdirSync(distApp).filter((d) => d.startsWith("mac"));
  assert.ok(macDirs.length > 0, "no dist-app/mac* output dir found");
  const appPath = join(distApp, macDirs[0], "Sounds and Recreation.app", "Contents", "MacOS", "Sounds and Recreation");
  assert.ok(existsSync(appPath), `expected app executable at ${appPath}`);
});
```

- [ ] **Step 6: Verify the gated test skips by default**

Run: `npx tsx --test tests/integration/packaging-artifact.test.ts`
Expected: the test reports as skipped (no `SAR_CHECK_DIST`).

- [ ] **Step 7: Ignore the build output dir**

Add `dist-app/` to `.gitignore`:

```bash
printf 'dist-app/\n' >> .gitignore
```

- [ ] **Step 8: Build the app and verify the artifact (the real packaging run)**

Run:

```bash
npm run sar:dist
SAR_CHECK_DIST=1 npx tsx --test tests/integration/packaging-artifact.test.ts
```

Expected: `electron-builder` produces `dist-app/mac*/Sounds and Recreation.app`; the gated test now PASSES. **If `electron-builder` reports missing renderer assets at launch (next step), adjust the `build.files` globs in package.json and re-run** — the `src/sounds-and-recreation-app/shell/**`, `src/keyboard_models/**/web/**`, and vendored `peaks/konva/waveform-data` under `shell/vendor/` are the likely culprits.

- [ ] **Step 9: Launch the `.app` and confirm the standalone runtime guarantee (manual)**

```bash
open "dist-app/$(ls dist-app | grep ^mac | head -1)/Sounds and Recreation.app"
```

Manually confirm, with **no agent, no audio service, and no other process running**:
- The window opens titled "Sounds and Recreation" with the "SOUNDS AND RECREATION" chassis brand.
- Picking a model loads its web UI; the in-process mock device responds (drawbars/knobs move; MIDI monitor shows traffic).
- The **CHAT** console and **Song Analysis** view show "service unavailable" via the existing service-health chip rather than crashing.
- `.mockrack` save/open still works (File menu → Save/Open Studio Setup).

If the CHAT or Song-Analysis panels throw instead of degrading, that is a real bug to fix in `src/sounds-and-recreation-app/main.ts` / `shell/app.js` (guard the agent/audio client calls) before completing the task.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add electron-builder + sar:dist producing unsigned Sounds and Recreation.app"
```

---

## Task 5: Update docs and verify the published tarball stays lean

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/mock_runner.md`

- [ ] **Step 1: Update README.md**

Replace every user-facing "Mock Runner" product reference and the old script names. Run to locate them:

```bash
grep -nE "Mock Runner|mock:runner|mock:headless" README.md
```

For each hit: rename the product name "Mock Runner" → "Sounds and Recreation"; `npm run mock:runner` → `npm run sar`; `npm run mock:headless` → `npm run sar:headless`. Add a short "Standalone app build" subsection near the existing run instructions:

```markdown
### Standalone app build (no hardware)

Build the desktop app bundle (UI facade + in-process mock keyboards):

```bash
npm run sar:dist     # → dist-app/mac*/Sounds and Recreation.app (unsigned)
```

Launch the `.app` and pick a model to drive a mock keyboard with no hardware. The
CHAT and Song Analysis panels light up only when the agent / audio-analysis
services are running. Signed `.dmg`/`.pkg` installers are produced separately by
the `macos-packager` repo.
```

- [ ] **Step 2: Update CLAUDE.md (repo) Build & Run + architecture references**

Run to locate:

```bash
grep -nE "Mock Runner|mock:runner|mock:headless|mock-runner" CLAUDE.md
```

In the "Build & Run" block: `npm run mock:runner` → `npm run sar` (comment "Electron mock device with model picker UI" → "Electron desktop app — UI facade, model picker UI"); `npm run mock:headless` → `npm run sar:headless`. Add a line: `npm run sar:dist   # build unsigned Sounds and Recreation.app (dist-app/)`. In the "Mock Runner (`src/mock-runner/`)" architecture heading → "Sounds and Recreation app (`src/sounds-and-recreation-app/`)". **Keep** the `MockHandler`/`MidiCodec`/`MockTransport` collaborator names in that section (preserved vocabulary).

- [ ] **Step 3: Update docs/mock_runner.md (keep the filename)**

Keep the filename `docs/mock_runner.md` (it is published to the GitHub Pages docs site; renaming risks breaking inbound links). Update the H1 and body product references:

```bash
grep -nE "Mock Runner|mock:runner|mock:headless" docs/mock_runner.md
```

Line 1 `# Mock Runner` → `# Sounds and Recreation`. First paragraph "The Mock Runner is an Electron app that simulates one or more keyboards…" → "Sounds and Recreation is an Electron desktop app — the UI facade over the MCP servers and agent. It simulates one or more keyboards…". `npm run mock:runner` → `npm run sar`; `npm run mock:headless` → `npm run sar:headless`. **Keep** the `MockHandler`/`MidiCodec`/`MockTransport` and "MOCK RUNNER tab strip" → "SOUNDS AND RECREATION tab strip" where the chassis is described. Leave the historical diagrams' internal mechanics intact.

- [ ] **Step 4: Add a CHANGELOG.md entry for the rename (do not rewrite history)**

Prepend a new entry at the top of `CHANGELOG.md` describing this change (rename to "Sounds and Recreation" + `sar:dist` app build). **Do not** edit the existing entry that mentions "the Electron Mock Runner and its heavy dependencies" — that is an accurate historical record of PR #125. Match the file's existing heading/bullet style; example bullet:

```markdown
- Renamed the Electron desktop app from "Mock Runner" to **Sounds and Recreation**
  and added `npm run sar:dist` to build a standalone, unsigned `Sounds and Recreation.app`
  (UI facade + in-process mock keyboards). Internal mock/`.mockrack` formats unchanged. (#126)
```

- [ ] **Step 5: Verify the published npm tarball stays lean (Done-when check)**

Run:

```bash
npm run build
npm pack --dry-run 2>&1 | grep -E "sounds-and-recreation-app|mock-runner|dist/index|dist/cli" || true
```

Expected: the tarball lists `dist/index.*`, `dist/cli/**`, etc. (the MCP server) and **no** `dist/sounds-and-recreation-app/**` and **no** `dist/mock-runner/**` entries — the app stays excluded from the published package, exactly as before.

- [ ] **Step 6: Final repo-wide sweep for stray live product-name references**

Run:

```bash
grep -rniE "mock[ -]?runner" --include='*.ts' --include='*.js' --include='*.json' --include='*.cjs' --include='*.html' --include='*.css' --include='*.yml' --include='*.xml' --include='*.md' . \
  | grep -vE "node_modules|/dist/|/dist-app/|/vendor/|/docs/plans/completed/|docs/superpowers/" \
  | grep -vE "\.mock-runner\.json|mock-runner\.chat-history|mock-runner:console-w|mock-runner:rack-view|requires Mock Runner v|incoming MIDI|MockTransport|mock-registry|the mock-runner|mock-runner shell|mock-runner crash|mock-runner is not|crashed mock-runner"
```

Expected: no unexpected hits. Any remaining match is either a deliberately-preserved identifier (filter it) or a missed product-name reference (fix it). Document what (if anything) is intentionally left.

- [ ] **Step 7: Final gate — lint + type-check + unit**

Run:

```bash
npm run lint && npm run test:check && npm run test:unit
```

Expected: all green. *(Run `test:integration` / `test:e2e:mcb` in a GUI/CI-Docker session per the Preamble; they are not headless-runnable here.)*

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: rename Mock Runner -> Sounds and Recreation; document sar:dist app build"
```

---

## Done-when checklist (verify before opening the PR)

- [ ] App's user-visible identity is "Sounds and Recreation" everywhere (window title, menu, chassis brand, `productName`, README, CLAUDE.md, docs/mock_runner.md); internal "mock" device vocabulary preserved.
- [ ] `npm run sar:dist` produces an unsigned `dist-app/mac*/Sounds and Recreation.app` that launches standalone, drives a mock keyboard with no other process, and degrades gracefully on the CHAT / Song-Analysis panels.
- [ ] `npm pack --dry-run` confirms the published tarball stays lean (app excluded).
- [ ] `npm run lint`, `npm run test:check`, `npm run test:unit` are green; MIDI integration/e2e suites pass in a GUI/CI session.
- [ ] No stray live "mock-runner"/"Mock Runner" product references (Task 5 Step 5 sweep clean).
