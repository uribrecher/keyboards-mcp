# Monorepo Workspaces Split (#135) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the single `keyboards-mcp` package into a `packages/*` npm-workspaces monorepo — the published `keyboards-mcp` server and a private `sounds-and-recreation-app` — where the app depends on `keyboards-mcp` and imports its shared logic by package name, with every global/CI/Docker/release artifact surviving the move and the existing tests + npm release still green.

**Architecture:** Private root umbrella (`workspaces: ["packages/*"]`). `packages/keyboards-mcp/` keeps the whole server (incl. `shared/`, `keyboard_models/`, `midi/`, `mcb/`) and exposes a `shared/*` subpath `exports` map. `packages/sounds-and-recreation-app/` (the Electron app) declares `"keyboards-mcp": "^2"`, owns the app-only modules (`audio-analysis-client/`, `mockrack-format.ts`) and the app-only unit tests. Spawn-based integration/e2e tests stay in keyboards-mcp.

**Tech Stack:** Node 20+/22 (CI), npm workspaces, TypeScript 5.5 (`Node16` resolution, `declaration: true`), ESLint 9 flat config, `node:test` via `tsx`, electron-builder (app, deferred validation to #136), Docker Compose CI harness, OIDC trusted publishing.

**Design spec:** `docs/superpowers/specs/2026-06-16-monorepo-workspaces-split-design.md`

---

## Pre-flight (read once before Task 1)

- **Branch / worktree:** Work happens on branch `worktree-135-monorepo-workspaces-split` (already created off `origin/main`). All commits stay on this branch — never push to `main`.
- **Commits are signed.** The repo signs via SSH/1Password. In a sandboxed runner, signing silently no-ops — run `git commit`/`git push` with the sandbox disabled and verify each commit with `git cat-file commit HEAD | grep -c gpgsig` (expect `1`).
- **Install, not ci.** The restructure changes `package.json` topology, so regenerate the lockfile with `npm install` at the repo root (not `npm ci`). In a worktree, if `node_modules` is a stale symlink, remove it first (`rm -rf node_modules`) before `npm install`.
- **Build order:** the app imports the server's compiled `dist/` via the `exports` map, so **always build `keyboards-mcp` before the app**. The root `build` script encodes this.
- **Green bar for #135** (per spec): `lint`, `test:check`, `test:unit` across both workspaces, the app's `tsc` build resolving `keyboards-mcp/shared/*`, the Docker `test`/`coverage` jobs, a lean `npm pack --dry-run`, and the existing `keyboards-mcp` release path. A fully-working `sar:dist` `.app` bundle is **NOT** in scope — see "Deferred to #136" at the end.
- **Verification verbs used below:**
  - `npm run build -w keyboards-mcp` / `-w sounds-and-recreation-app`
  - `npm run lint -w <pkg>` / `npm run test:check -w <pkg>` / `npm run test:unit -w <pkg>`
  - `npm pack --dry-run -w keyboards-mcp`
  - `docker compose -f docker-compose.test.yml run --rm test`

---

## Task 1: Stand up the workspace skeleton (relocate the server into `packages/keyboards-mcp/`)

End state: a single-workspace monorepo. The whole current package (still including the app code) lives under `packages/keyboards-mcp/`; the marketplace-facing root files stay at the root. Builds + unit tests are green from the new location.

**Files:**
- Create dir: `packages/keyboards-mcp/`
- Move: `src/`, `tests/`, `tsconfig.json`, `tsconfig.test.json`, `eslint.config.js`, `CHANGELOG.md`, `package.json` → `packages/keyboards-mcp/`
- Copy (root keeps authoritative): `README.md`, `LICENSE` → `packages/keyboards-mcp/`
- Create: `package.json` (root umbrella)
- Modify: `.gitignore`
- Delete: `package-lock.json` (regenerated)
- Stay at root untouched: `.claude-plugin/`, `PRIVACY.md`, `README.md`, `LICENSE`, `docs/`, `.github/`, `.run/`, `Dockerfile`, `docker-compose.test.yml`, `.dockerignore`, `CLAUDE.md`

- [ ] **Step 1: Create the package dir and move the server package into it**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p packages/keyboards-mcp
git mv src tests tsconfig.json tsconfig.test.json eslint.config.js CHANGELOG.md packages/keyboards-mcp/
git mv package.json packages/keyboards-mcp/package.json
```

- [ ] **Step 2: Copy README + LICENSE into the package (root keeps the originals for GitHub/marketplace)**

```bash
cp README.md LICENSE packages/keyboards-mcp/
git add packages/keyboards-mcp/README.md packages/keyboards-mcp/LICENSE
```

- [ ] **Step 3: Create the root umbrella `package.json`**

Create `package.json` at the repo root:

```json
{
  "name": "keyboards-mcp-monorepo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/keyboards-mcp",
    "packages/sounds-and-recreation-app"
  ],
  "scripts": {
    "build": "npm run build -w keyboards-mcp && npm run build -w sounds-and-recreation-app",
    "lint": "npm run lint --workspaces --if-present",
    "test:check": "npm run test:check --workspaces --if-present",
    "test:unit": "npm run test:unit --workspaces --if-present",
    "test": "npm run test -w keyboards-mcp"
  }
}
```

> The `sounds-and-recreation-app` workspace dir does not exist yet (created in Task 2); `npm install` tolerates a not-yet-present workspace glob entry because the glob simply matches nothing until then. (If your npm version errors on a missing explicit path, temporarily set `"workspaces": ["packages/*"]` and switch to the explicit list once Task 2 creates the app.)

- [ ] **Step 4: Update `.gitignore` so the vendored-bundle ignore survives the move**

In `.gitignore`, replace the line:

```
src/sounds-and-recreation-app/shell/vendor/
```

with a location-independent pattern:

```
**/shell/vendor/
```

(Leave all other patterns — `dist/`, `dist-app/`, `node_modules/`, `coverage.lcov`, `.coverage-out/` — as-is; they are non-anchored and still match under `packages/*`.)

- [ ] **Step 5: Regenerate the lockfile and link the workspace**

```bash
cd "$(git rev-parse --show-toplevel)"
git rm --quiet package-lock.json
rm -rf node_modules
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
git add package.json package-lock.json .gitignore
```

Expected: `npm install` completes; a new root `package-lock.json` is written; `node_modules/keyboards-mcp` is a symlink to `packages/keyboards-mcp`.

- [ ] **Step 6: Verify the relocated package builds + lints + unit-tests green**

```bash
npm run build -w keyboards-mcp
npm run lint -w keyboards-mcp
npm run test:check -w keyboards-mcp
npm run test:unit -w keyboards-mcp
```

Expected: all PASS. (The app code still lives inside this package at this point, so its compile/lint is included and must also pass.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(#135): relocate keyboards-mcp into packages/ workspaces skeleton"
git cat-file commit HEAD | grep -c gpgsig   # expect 1
```

---

## Task 2: Extract the app into `packages/sounds-and-recreation-app/` and wire the dependency edge

End state: two workspaces. The app owns its code, the app-only modules, the app-only unit tests, its own `package.json`/`tsconfig`/`eslint`; it imports server logic via `keyboards-mcp/shared/*`; the server exposes the `exports` map and sheds app-only scripts/deps. Both packages build, lint, type-check, and unit-test green.

**Files:**
- Move (within repo): `packages/keyboards-mcp/src/sounds-and-recreation-app/` → `packages/sounds-and-recreation-app/src/`
- Move: `packages/keyboards-mcp/src/audio-analysis-client/` → `packages/sounds-and-recreation-app/src/audio-analysis-client/`
- Move: `packages/keyboards-mcp/src/shared/mockrack-format.ts` → `packages/sounds-and-recreation-app/src/mockrack-format.ts`
- Move (app-only unit tests): `packages/keyboards-mcp/tests/unit/transport-state-changed.test.ts`, `mock-runner-ui-emit.test.ts`, `mock-runner/` (dir), and `packaging-config.test.ts` → `packages/sounds-and-recreation-app/tests/unit/`; `packages/keyboards-mcp/tests/integration/packaging-artifact.test.ts` → `packages/sounds-and-recreation-app/tests/integration/`
- Create: `packages/sounds-and-recreation-app/package.json`, `tsconfig.json`, `tsconfig.test.json`, `eslint.config.js`
- Modify: `packages/keyboards-mcp/package.json` (add `exports`; drop app scripts/deps; drop `build` block)
- Modify (import rewrites): `packages/sounds-and-recreation-app/src/{cli,main,transport}.ts` + moved test files

- [ ] **Step 1: Move the app code, app-only modules, and app-only tests**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p packages/sounds-and-recreation-app/tests/unit packages/sounds-and-recreation-app/tests/integration

# App source -> app package src/ (flatten out the sounds-and-recreation-app/ level)
git mv packages/keyboards-mcp/src/sounds-and-recreation-app packages/sounds-and-recreation-app/src

# App-only modules (audio-analysis-client was a sibling of sounds-and-recreation-app, not inside it)
git mv packages/keyboards-mcp/src/audio-analysis-client packages/sounds-and-recreation-app/src/audio-analysis-client
git mv packages/keyboards-mcp/src/shared/mockrack-format.ts packages/sounds-and-recreation-app/src/mockrack-format.ts

# App-only unit/integration tests
git mv packages/keyboards-mcp/tests/unit/transport-state-changed.test.ts packages/sounds-and-recreation-app/tests/unit/
git mv packages/keyboards-mcp/tests/unit/mock-runner-ui-emit.test.ts   packages/sounds-and-recreation-app/tests/unit/
git mv packages/keyboards-mcp/tests/unit/mock-runner                    packages/sounds-and-recreation-app/tests/unit/mock-runner
git mv packages/keyboards-mcp/tests/unit/packaging-config.test.ts       packages/sounds-and-recreation-app/tests/unit/
git mv packages/keyboards-mcp/tests/integration/packaging-artifact.test.ts packages/sounds-and-recreation-app/tests/integration/
```

- [ ] **Step 2: Add the `exports` map to keyboards-mcp and shed app-only scripts/deps**

Edit `packages/keyboards-mcp/package.json`:

1. Add an `exports` block right after `"main"`:

```json
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./shared/*": { "types": "./dist/shared/*.d.ts", "default": "./dist/shared/*.js" }
  },
```

2. Replace the `scripts` block with the server-only subset (drops `sar*`, `presar*`, `copy:*-vendor`, `build:sdk`, `generate:audio-analysis-types`, `prebuild`):

```json
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "mcb": "tsx src/mcb/index.ts",
    "lint": "eslint src/ tests/",
    "test": "npm run test:unit && npm run test:integration && npm run test:e2e:mcb && npm run test:e2e",
    "test:unit": "find tests/unit -name '*.test.ts' | xargs npx tsx --test",
    "test:integration": "find tests/integration -name '*.test.ts' | xargs npx tsx --test",
    "test:e2e": "find tests/e2e -maxdepth 1 -name '*.test.ts' | xargs npx tsx --test --test-concurrency=1",
    "test:e2e:mcb": "find tests/e2e/mcb -name '*.test.ts' | xargs npx tsx --test --test-concurrency=1",
    "test:coverage": "find tests -name '*.test.ts' | xargs npx tsx --test --test-concurrency=1 --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-lines=90 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage.lcov",
    "test:check": "tsc --noEmit -p tsconfig.test.json",
    "test:ci": "npm run lint && npm run test:check && npm run test:unit && npm run test:integration && npm run test:e2e:mcb && npm run test:e2e"
  },
```

3. Delete the entire top-level `"build": { ... }` (electron-builder) block — it moves to the app.

4. Replace `devDependencies` with the trimmed server set (keep `dependencies` exactly as-is):

```json
  "devDependencies": {
    "@eslint/js": "^9.39.4",
    "@types/adm-zip": "^0.5.8",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.18.1",
    "eslint": "^9.39.4",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "typescript-eslint": "^8.58.2"
  }
```

- [ ] **Step 3: Create the app `package.json`**

Create `packages/sounds-and-recreation-app/package.json`:

```json
{
  "name": "sounds-and-recreation-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "copy:peaks-vendor": "mkdir -p src/shell/vendor && cp ../../node_modules/peaks.js/dist/peaks.ext.min.js src/shell/vendor/peaks.min.js && cp ../../node_modules/konva/konva.min.js src/shell/vendor/konva.min.js && cp ../../node_modules/waveform-data/dist/waveform-data.min.js src/shell/vendor/waveform-data.min.js && cp ../../node_modules/marked/lib/marked.esm.js src/shell/vendor/marked.esm.js",
    "copy:agent-vendor": "mkdir -p src/shell/vendor/agent-client && cp -R ../../node_modules/@sounds-and-recreation/agent-client/dist/. src/shell/vendor/agent-client/",
    "build:sdk": "npm --prefix ../../../sound-recreation-agent/client-sdk run build",
    "prebuild": "npm run copy:peaks-vendor",
    "build": "tsc",
    "generate:audio-analysis-types": "openapi-typescript src/audio-analysis-client/openapi.json -o src/audio-analysis-client/generated/openapi-types.ts",
    "presar": "npm run build:sdk && npm run copy:agent-vendor",
    "presar:debug": "npm run build:sdk && npm run copy:agent-vendor",
    "sar": "electron dist/main.js",
    "sar:debug": "ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 SAR_DEVTOOLS=1 electron --inspect=5858 dist/main.js 2>&1 | tee /tmp/sounds-and-recreation.log",
    "sar:headless": "tsx src/cli.ts",
    "presar:dist": "npm run build:sdk && npm run copy:peaks-vendor && npm run copy:agent-vendor",
    "sar:dist": "tsc && electron-builder --dir",
    "lint": "eslint src/ tests/",
    "test:unit": "find tests/unit -name '*.test.ts' | xargs npx tsx --test",
    "test:check": "tsc --noEmit -p tsconfig.test.json"
  },
  "dependencies": {
    "@sounds-and-recreation/agent-client": "file:../../../sound-recreation-agent/client-sdk",
    "keyboards-mcp": "^2",
    "marked": "^18.0.3",
    "ws": "^8.20.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.4",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.18.1",
    "electron": "^41.1.1",
    "electron-builder": "^26.15.3",
    "eslint": "^9.39.4",
    "konva": "^9.3.22",
    "openapi-typescript": "^7.13.0",
    "peaks.js": "^4.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "typescript-eslint": "^8.58.2",
    "waveform-data": "^4.5.2"
  },
  "build": {
    "appId": "io.sounds-and-recreation",
    "productName": "Sounds and Recreation",
    "asar": false,
    "directories": { "output": "dist-app" },
    "extraMetadata": { "main": "dist/main.js" },
    "files": [
      "dist/**",
      "src/shell/**",
      "src/preload.cjs",
      "node_modules/keyboards-mcp/dist/shared/**",
      "node_modules/keyboards-mcp/dist/midi/**",
      "node_modules/keyboards-mcp/dist/keyboard_models/**",
      "package.json"
    ],
    "mac": { "target": "dir" },
    "fileAssociations": [
      { "ext": "mockrack", "name": "Sounds and Recreation Setup", "role": "Editor" }
    ]
  }
}
```

> The electron-builder `build` block is moved here for completeness, but its full `.app` correctness (incl. how model `web/` UI assets are sourced from the dependency) is validated under **#136** — see "Deferred to #136". `dist/**` now covers the app's own compiled output, including the moved-in `audio-analysis-client/`.

- [ ] **Step 4: Create the app `tsconfig.json` and `tsconfig.test.json`**

Create `packages/sounds-and-recreation-app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Create `packages/sounds-and-recreation-app/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 5: Create the app `eslint.config.js`**

Create `packages/sounds-and-recreation-app/eslint.config.js` (same shape as the server's, with the app's typed-lint project):

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "**/*.js", "**/*.cjs"],
  }
);
```

- [ ] **Step 6: Rewrite the app's cross-package imports to `keyboards-mcp/shared/*` and fix the moved-module paths**

Run these substitutions across the app package's TypeScript (covers `src/cli.ts`, `src/main.ts`, `src/transport.ts`, and the moved test files):

```bash
cd "$(git rev-parse --show-toplevel)/packages/sounds-and-recreation-app"

# shared/* -> keyboards-mcp/shared/* (drop the .js extension; package subpath imports are extensionless)
grep -rlE "from \"(\.\.?/)+shared/(model-registry|mock-registry|mcb-client|keyboard-model|midi-codec)\.js\"" src tests \
  | xargs sed -i '' -E 's#from "(\.\.?/)+shared/(model-registry|mock-registry|mcb-client|keyboard-model|midi-codec)\.js"#from "keyboards-mcp/shared/\2"#g'

# mockrack-format moved to the app root src/ -> relative
grep -rlE "shared/mockrack-format\.js" src \
  | xargs sed -i '' -E 's#"(\.\.?/)+shared/mockrack-format\.js"#"./mockrack-format.js"#g'

# audio-analysis-client moved under the app src/ -> relative (from src/main.ts it is ./audio-analysis-client/…)
grep -rlE "(\.\.?/)+audio-analysis-client/" src \
  | xargs sed -i '' -E 's#"(\.\.?/)+audio-analysis-client/#"./audio-analysis-client/#g'
```

> Note: `sed -i ''` is the macOS/BSD form (empty backup suffix). On GNU/Linux use `sed -i` with no `''`. After running, also fix any **moved test** relative imports that point back into app code: in `packages/sounds-and-recreation-app/tests/**`, `../../src/sounds-and-recreation-app/<x>.js` becomes `../../src/<x>.js` — run:
> ```bash
> grep -rlE "src/sounds-and-recreation-app/" tests | xargs sed -i '' -E 's#src/sounds-and-recreation-app/#src/#g'
> ```

- [ ] **Step 7: Verify no stale cross-package relative imports remain**

```bash
cd "$(git rev-parse --show-toplevel)/packages/sounds-and-recreation-app"
! grep -rnE "from \"(\.\.?/)+shared/" src tests
! grep -rnE "(\.\.?/)+audio-analysis-client/" src
! grep -rnE "src/sounds-and-recreation-app/" tests src
```

Expected: each command prints nothing and exits 0 (the leading `!` inverts grep's exit). Any hit is a missed rewrite — fix it.

- [ ] **Step 8: Reinstall, then build the server and the app in order**

```bash
cd "$(git rev-parse --show-toplevel)"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run build -w keyboards-mcp        # emits dist/ + .d.ts that the exports map points at
npm run build -w sounds-and-recreation-app
```

Expected: server builds; the app's `tsc` resolves `keyboards-mcp/shared/*` against the emitted `.d.ts` and builds. A "Cannot find module 'keyboards-mcp/shared/...'" error means the server wasn't built first or the `exports` map is wrong.

- [ ] **Step 9: Lint + type-check + unit-test both workspaces**

```bash
npm run lint -w keyboards-mcp && npm run lint -w sounds-and-recreation-app
npm run test:check -w keyboards-mcp && npm run test:check -w sounds-and-recreation-app
npm run test:unit -w keyboards-mcp && npm run test:unit -w sounds-and-recreation-app
```

Expected: all PASS. keyboards-mcp's unit suite no longer references app code; the app's unit suite runs the moved-in tests.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(#135): extract sounds-and-recreation-app workspace + keyboards-mcp/shared exports edge"
git cat-file commit HEAD | grep -c gpgsig   # expect 1
```

---

## Task 3: Retarget the spawn-based test helpers to the app's new location

End state: the integration / e2e:mcb tests that launch the headless mock as a subprocess find it at the app workspace; the MCB spawn still points at keyboards-mcp's own source.

**Files:**
- Modify: `packages/keyboards-mcp/tests/helpers/mock-process.ts`
- Modify: `packages/keyboards-mcp/tests/helpers/multi-device-harness.ts`

- [ ] **Step 1: Point the mock spawn at the app workspace**

In `packages/keyboards-mcp/tests/helpers/mock-process.ts`, both `spawn` call sites currently pass `"src/sounds-and-recreation-app/cli.ts"` with `cwd: process.cwd()`. Replace the script path with the app's path **relative to the keyboards-mcp package root** and set the cwd to the app package so its `tsx`/deps resolve:

```ts
// was: "src/sounds-and-recreation-app/cli.ts"  with cwd: process.cwd()
const APP_DIR = new URL("../../../sounds-and-recreation-app", import.meta.url).pathname;
// spawn args:
//   "npx", ["tsx", "src/cli.ts", ...modelArgs]
// spawn options:
//   { cwd: APP_DIR, env: { ...process.env, ...extraEnv } }
```

Apply the same `APP_DIR` + `cwd: APP_DIR` + `"src/cli.ts"` change to **both** spawn sites in this file.

- [ ] **Step 2: Point the harness mock spawn at the app workspace; keep MCB at keyboards-mcp**

In `packages/keyboards-mcp/tests/helpers/multi-device-harness.ts`:
- Mock spawn: same change as Step 1 — `cwd: APP_DIR` (the `../../../sounds-and-recreation-app` URL relative to this helper) and script `"src/cli.ts"`.
- MCB spawn (`spawn(process.execPath, [tsxCli, "src/mcb/index.ts"], { cwd: process.cwd(), … })`): **leave pointing at keyboards-mcp** — `src/mcb/index.ts` is still in this package, and `process.cwd()` for these tests is the keyboards-mcp package. Confirm `tsxCli` resolves (`join(process.cwd(), "node_modules/tsx/dist/cli.mjs")`); with workspace hoisting `tsx` lives in the **root** `node_modules`, so change it to resolve from the hoisted location:

```ts
// was: const tsxCli = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const tsxCli = new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
```

- [ ] **Step 3: Verify the integration suite resolves the new paths**

```bash
cd "$(git rev-parse --show-toplevel)"
npm run build -w keyboards-mcp
# Integration spawns the app's headless mock; runs locally where CoreMIDI/WS allow.
npm run test:integration -w keyboards-mcp || echo "NOTE: requires the CI Docker/GUI MIDI session — defer to Task 4 if it cannot run here"
```

Expected: either the suite passes locally, or (per the known MIDI-session gating) it is exercised in Task 4's Docker run. The path change itself is verified by the spawn not erroring with "cannot find src/cli.ts".

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(#135): retarget mock spawn helpers to the app workspace; resolve hoisted tsx"
git cat-file commit HEAD | grep -c gpgsig   # expect 1
```

---

## Task 4: Make the Docker harness + CI workspace-aware

End state: `Dockerfile` + `docker-compose.test.yml` (kept at the repo root) build the workspaces and run both packages' services; `ci.yml` lints/audits with the right workspace scope.

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.test.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Make the `Dockerfile` workspace-aware**

Replace `Dockerfile` with a version that installs the workspaces and builds the server (the app's `cli.ts`/mock runs via `tsx` from source, but it imports `keyboards-mcp`'s built `dist`):

```dockerfile
FROM node:22-slim
WORKDIR /app
# Copy the workspace manifests first for cacheable installs.
COPY package.json package-lock.json ./
COPY packages/keyboards-mcp/package.json packages/keyboards-mcp/package.json
COPY packages/sounds-and-recreation-app/package.json packages/sounds-and-recreation-app/package.json
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
RUN npm run build -w keyboards-mcp
```

> The app's `@sounds-and-recreation/agent-client` `file:` dep points outside the build context (a sibling repo). It is a renderer-only concern not exercised by the Docker test/coverage suite; if `npm ci` fails resolving it inside the container, mark that dep `"optional"` for CI or stub it — but first confirm: the test/coverage services run `keyboards-mcp`'s suite, which does not import the agent client.

- [ ] **Step 2: Repoint the compose service commands + coverage output path**

In `docker-compose.test.yml`:
- `mock` service command: `npx tsx src/sounds-and-recreation-app/cli.ts …` → `npx tsx packages/sounds-and-recreation-app/src/cli.ts --model nord-electro-5d --no-midi --ws-port 3000`
- `mcb` service command: `npx tsx src/mcb/index.ts` → `npx tsx packages/keyboards-mcp/src/mcb/index.ts`
- `test` service command: `npm run test:ci` → `npm run test:ci -w keyboards-mcp`
- `coverage` service command: change `npm run test:coverage` → `npm run test:coverage -w keyboards-mcp`, and the copy source from `coverage.lcov` → `packages/keyboards-mcp/coverage.lcov`:

```yaml
    command: >
      sh -c "npm run test:coverage -w keyboards-mcp; rc=$$?;
             cp -f packages/keyboards-mcp/coverage.lcov /out/ 2>/dev/null || true;
             exit $$rc"
```

Leave `build: .`, networks, healthchecks, env, and the `./.coverage-out:/out` mount unchanged.

- [ ] **Step 3: Update `ci.yml` lint + audit scoping**

In `.github/workflows/ci.yml`:
- `lint` job: change `- run: npm run lint` → `- run: npm run lint` (root delegator already fans out via `--workspaces --if-present`) — keep `npm ci` as-is (installs all workspaces).
- `audit` job: change to audit only the published package's prod deps so the app's Electron deps don't pollute the signal:

```yaml
      - run: npm ci
      - run: npm audit --omit=dev --workspace keyboards-mcp --audit-level=high
```

(The `test` and `coverage` jobs are unchanged — they invoke `docker compose -f docker-compose.test.yml`, which stays at the root, and the `.coverage-out` artifact path is unchanged.)

- [ ] **Step 4: Verify the Docker test + coverage runs**

```bash
cd "$(git rev-parse --show-toplevel)"
docker compose -f docker-compose.test.yml run --rm test
docker compose -f docker-compose.test.yml down
docker compose -f docker-compose.test.yml run --rm coverage
docker compose -f docker-compose.test.yml down
```

Expected: `test` PASSES (full unit+integration+e2e:mcb+e2e under `MIDI_TRANSPORT=ws`); `coverage` runs and the **90% line gate** still passes (re-validate — the measured `src/**` surface shrank now that app code left keyboards-mcp). If coverage dropped below 90% purely from the surface change, record the new number and flag it (do not lower the gate without sign-off).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci(#135): workspace-aware Dockerfile, compose service paths, scoped lint/audit"
git cat-file commit HEAD | grep -c gpgsig   # expect 1
```

---

## Task 5: Keep the existing `keyboards-mcp` npm release working

End state: `release.yml` reads the version from and publishes the `keyboards-mcp` workspace (not the private root umbrella). No release *redesign* — that is #138.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Repoint the version check at the keyboards-mcp workspace**

In `release.yml`, in the "Verify tag matches package.json version" step, change the read path:

```bash
# was: PKG_VERSION="v$(node -p "require('./package.json').version")"
PKG_VERSION="v$(node -p "require('./packages/keyboards-mcp/package.json').version")"
```

- [ ] **Step 2: Publish the workspace, not the root**

In `release.yml`, change the publish step:

```yaml
      - name: Publish to npm
        run: npm publish -w keyboards-mcp --provenance --access public
```

(The `npm ci` install step and the Docker test-gate step are unchanged. Update the test-gate to scope if it runs the suite directly — here it uses `docker compose … run --rm test`, already handled in Task 4. OIDC trusted publishing binds to repo + `release.yml` filename, so it is unaffected.)

- [ ] **Step 3: Verify the publish would target the right package + tarball is lean**

```bash
cd "$(git rev-parse --show-toplevel)"
node -p "require('./packages/keyboards-mcp/package.json').version"   # expect 2.0.0
npm pack --dry-run -w keyboards-mcp
```

Expected: version prints `2.0.0`; the dry-run file list contains `dist/index.*`, `dist/server.*`, `dist/cli/**`, `dist/mcb/**`, `dist/tools/**`, `dist/shared/**`, `dist/midi/**`, `dist/keyboard_models/**`, `README.md`, `CHANGELOG.md`, `LICENSE` — and **no** app code (`sounds-and-recreation-app`, `audio-analysis-client`, `mockrack-format`, `dist-app`, `shell/`).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ci(#135): release.yml reads + publishes the keyboards-mcp workspace"
git cat-file commit HEAD | grep -c gpgsig   # expect 1
```

---

## Task 6: Fix remaining global artifacts + final verification

End state: JetBrains run configs point at the right workspaces; the root `CLAUDE.md` documents the workspace commands; everything is green end-to-end.

**Files:**
- Modify: `.run/mcb.run.xml`, `.run/sar.run.xml`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Repoint the JetBrains run configs at their workspaces**

In `.run/mcb.run.xml`, change the package-json reference:

```xml
<package-json value="$PROJECT_DIR$/packages/keyboards-mcp/package.json" />
```

In `.run/sar.run.xml`:

```xml
<package-json value="$PROJECT_DIR$/packages/sounds-and-recreation-app/package.json" />
```

(Leave the `<script value="mcb"/>` / `<script value="sar"/>` entries — those scripts now live in the referenced workspace package.json.)

- [ ] **Step 2: Update the root `CLAUDE.md` build/run/test commands to the workspace form**

In `CLAUDE.md`, update the "Build & Run" / "Testing" command examples to the workspace form, e.g.:

```bash
npm run build -w keyboards-mcp          # tsc -> packages/keyboards-mcp/dist/
npm run start -w keyboards-mcp          # MCP server (stdio)
npm run mcb   -w keyboards-mcp          # MIDI Connections Broker
npm run sar   -w sounds-and-recreation-app        # Electron desktop app
npm run sar:headless -w sounds-and-recreation-app # headless mock
npm run sar:dist     -w sounds-and-recreation-app # build the .app (dist-app/)
npm test      -w keyboards-mcp          # full server suite
npm run lint                            # root delegator -> both workspaces
```

Add one line noting the monorepo layout (`packages/keyboards-mcp`, `packages/sounds-and-recreation-app`) and that the app depends on `keyboards-mcp`.

- [ ] **Step 3: Full green sweep across the monorepo**

```bash
cd "$(git rev-parse --show-toplevel)"
rm -rf node_modules && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run build                                   # server then app (root delegator order)
npm run lint                                    # both workspaces
npm run test:check                              # both workspaces
npm run test:unit                               # both workspaces
npm pack --dry-run -w keyboards-mcp             # confirm lean tarball (no app code)
docker compose -f docker-compose.test.yml run --rm test && docker compose -f docker-compose.test.yml down
```

Expected: every command PASSES; the pack list is lean.

- [ ] **Step 4: Confirm the marketplace-facing root artifacts are untouched**

```bash
cd "$(git rev-parse --show-toplevel)"
test -f .claude-plugin/plugin.json && test -f PRIVACY.md && test -f LICENSE && test -f README.md && test -d docs && echo "root marketplace artifacts intact"
git log --oneline --name-only -1 -- .claude-plugin/plugin.json PRIVACY.md   # expect: NOT changed by this branch
```

Expected: all present; `.claude-plugin/plugin.json` + `PRIVACY.md` show no modifications on this branch (only relocations elsewhere).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(#135): repoint .run configs + update CLAUDE.md for the workspaces monorepo"
git cat-file commit HEAD | grep -c gpgsig   # expect 1
```

---

## Deferred to #136 (do NOT attempt here)

- **`sar:dist` `.app` bundle correctness.** The electron-builder `build` block is moved into the app, but a fully-working `.app` (incl. how the model `keyboard_models/**/web/**` UI assets are sourced from the `keyboards-mcp` dependency — the server's `files` whitelist is currently lean and does **not** ship `src/.../web/**`) is a packaging concern owned by #136 alongside `extraMetadata.version` → `CFBundleShortVersionString`. #135's green bar is `tsc` build + type-check + unit tests, not a launched bundle. **Open question for #136:** either add `keyboard_models/**/web/**` (and any `dist`-served assets) to keyboards-mcp's `files` whitelist, or have the packager copy them — decide there.
- **Independent app version stamping** (`extraMetadata.version`) — #136.
- **Changesets adoption** — #137.
- **Per-package release redesign** (prefixed tags / `changesets/action`) — #138.

## Out-of-repo coordination (flag in the PR; not edited here)

- Sibling `sound-recreation-agent`'s default `--keyboards-mcp ../keyboards-mcp/dist/index.js` → `…/packages/keyboards-mcp/dist/index.js`.
- Parent-dir `sounds-and-recreation/CLAUDE.md` references the same server path.
- `macos-packager` (scaffold) — note the path change for whenever it lands.

## Self-review checklist (run before handing off to execution)

- Spec sections mapped: layout (T1), exports edge + import rewrite + deps split (T2), MCB stays (unchanged, in keyboards-mcp), test placement (T2 move + T3 retarget), workflows/Docker/gitignore/.run/tsconfig/eslint/CLAUDE/file:dep (T1–T6), marketplace root artifacts untouched (T6 Step 4), release still works (T5), lean tarball (T5/T6).
- No placeholders; every file change shows exact content or exact substitution.
- Type/name consistency: `keyboards-mcp/shared/*` import specifier used identically in T2 (rewrite) and the exports map; app `main` entry `dist/main.js` consistent across the app `package.json` `extraMetadata` + `sar`/`sar:debug` scripts.
