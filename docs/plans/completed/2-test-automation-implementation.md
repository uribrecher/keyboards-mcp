# Test Automation Framework — Implementation Plan

## Context

No automated tests exist. Regressions keep slipping through — recently a new model was added without a mock handler, and when fixed, the handler returned the wrong state shape for the UI. This plan builds a three-layer test pyramid (unit → integration → E2E) to catch these classes of bugs automatically.

Based on the existing decisions in `docs/plans/pending/2-test-automation-framework.md`.

---

## Task 1: Test Infrastructure Setup

**Goal**: Directory structure, TypeScript config, package scripts, trivial smoke test.

- 1a. Create directories: `tests/unit/`, `tests/integration/`, `tests/e2e/`, `tests/helpers/`
- 1b. Create `tsconfig.test.json` — extends base, overrides `rootDir` to `.`, `include` adds `tests/**/*`. Used only for type-checking (`tsc --noEmit`)
- 1c. Add package.json scripts:
  - `"test"` — runs all layers via tsx
  - `"test:unit"` — `tsx --test tests/unit/**/*.test.ts`
  - `"test:integration"` — `tsx --test tests/integration/**/*.test.ts`
  - `"test:e2e"` — `tsx --test tests/e2e/**/*.test.ts`
  - `"test:check"` — `tsc --noEmit -p tsconfig.test.json`
- 1d. Create `tests/unit/smoke.test.ts` — trivial `1+1=2` to verify the pipeline works

**Files**: `tsconfig.test.json`, `tests/unit/smoke.test.ts`, `package.json` (modify)

### CHECKPOINT 1
Run `npm run test:unit` and `npm run test:check`. Smoke test passes, type-checking succeeds.

---

## Task 2: Parameter Resolution Unit Tests

**Goal**: Test every encoding type in `src/shared/parameter-resolution.ts` with round-trip assertions.

- 2a. `discreteToMidi` / `midiToDiscrete` — boundary values, round-trip for max ∈ {1,2,3,4,5,7,12,13}
- 2b. `drawbarToMidi` / `midiToDrawbar` — 9-position round-trips, clamping
- 2c. `modelIndexToMidi` / `midiToModelIndex` — exact table values, intermediate MIDI values
- 2d. `resolveValue` — raw/drawbar/discrete/model-index/one-based/custom encodings, invalid label throws
- 2e. `formatValue` — each encoding kind returns expected format

**File**: `tests/unit/parameter-resolution.test.ts`

---

## Task 3: Per-Model Mock Handler Tests

**Goal**: Test each model's `MockHandler` in isolation — no MIDI ports, no processes. Instantiate directly, call `init()` → `onMIDI()` → `getFullState()`. Each model gets its own test folder since models have fundamentally different state shapes, MIDI routing, and features.

### 3a. Nord Electro 5D — `tests/unit/nord-electro-5d/`

- `mock-handler.test.ts`:
  - State shape: top-level keys are `["lower", "upper", "global", "preset1Drawbars", "preset2Drawbars", "presetOrganToggles"]`
  - Drawbar CC (e.g. CC 16) → `upper.drawbar_1.position` reflects value
  - Preset routing: switch to preset2, send drawbar CC → `preset2Drawbars` updates
  - Per-part params: CC on lower channel → `lower` state, CC on upper channel → `upper` state
  - Vibrato/percussion toggles route to active preset
  - Program change → state reflects bank/slot
  - Unmapped CC, sysex → no crash
- `parameter-map.test.ts`:
  - No duplicate CCs, all discrete params have valid labels
  - `findParam()` returns correct param for every key
  - `getSections()` non-empty, `getParamsBySection()` returns params for each section

### 3b. JUNO-X — `tests/unit/juno-x/`

- `mock-handler.test.ts`:
  - State shape: top-level keys are `["model", "scene", "sceneGlobal", "part1".."part5"]`
  - CC for analog synth param → routes to correct part based on channel
  - SysEx DT1 for a scene param → `sceneGlobal` or part `sceneParams` updates
  - Program change → scene bank/program update
  - Unmapped CC, invalid sysex → no crash
- `parameter-map.test.ts`:
  - Same consistency checks as Nord

### 3c. Prophet-6 — `tests/unit/prophet-6/`

- `mock-handler.test.ts`:
  - State shape: top-level keys are `["global"]` only
  - CC 67 (osc1_freq) with value 100 → `global.osc1_freq.value === 100`
  - Toggle param (e.g. arp_on_off) → label reflects on/off
  - Program change, sysex → no crash (both are no-ops)
- `parameter-map.test.ts`:
  - Same consistency checks as Nord

---

## Task 4: Model Registry Tests

**Goal**: Verify all models are discoverable and have required factories. This is the shared guard — per-model param map tests are in each model's folder (Task 3).

- 4a. `discoverModels()` returns all 3 models, no duplicate IDs
- 4b. `loadModelById()` works for each model, throws for unknown
- 4c. Every model has `createMockHandler` and `createDevice` defined (the exact regression guard)
- 4d. `autoDetectModel()` matches port names for each model

**File**: `tests/unit/model-registry.test.ts`

### CHECKPOINT 2
Run `npm run test:unit`. All unit tests pass (param resolution + handler contracts + registry + param maps). Every model passes the contract and state shape snapshot.

---

## Task 5: Headless Mock Runner (cli.ts)

**Goal**: Create the headless CLI entry point for spawning mocks without Electron.

- 5a. Make `MockEngine.start()` return `Promise<void>` (resolve after HTTP server listens) — backward compatible
- 5b. Create `src/mock-runner/cli.ts`:
  - `--model <id>` (required), `--ws-port` (default 3000), `--lower-channel`, `--upper-channel`
  - Loads model, creates handler, starts engine
  - Prints `MOCK_READY` after engine is ready
  - Clean shutdown on SIGTERM/SIGINT
- 5c. Add `"mock:headless"` package script

**Files**: `src/mock-runner/cli.ts` (new), `src/mock-runner/engine.ts` (modify start()), `package.json` (modify)

### CHECKPOINT 3
1. Run `npm run build` to compile the modified `engine.ts`
2. Reload the MCP server: user runs `/mcp` in Claude Code (required after modifying `src/` files)
3. Run `tsx src/mock-runner/cli.ts --model nord-electro-5d --ws-port 3456` manually. Verify it prints `MOCK_READY`, then Ctrl+C exits cleanly. Repeat for all 3 models.

---

## Task 6: Integration Tests (Headless Mock + WebSocket)

**Goal**: Spawn mock as child process, connect via WebSocket, verify state broadcasts.

- 6a. Create `tests/helpers/mock-process.ts` — `MockProcess.start(opts)` spawns headless mock, waits for `MOCK_READY`, connects WS client, caches latest state
- 6b. Integration tests:
  - Each model starts headless and sends initial state with correct shape
  - Invalid model → process exits with non-zero code
  - SIGTERM → clean shutdown

**Files**: `tests/helpers/mock-process.ts`, `tests/integration/mock-runner.test.ts`

### CHECKPOINT 4
Run `npm run test:integration`. All three models start headless, broadcast valid state over WebSocket, and shut down cleanly.

---

## Task 7: Test Harness & E2E Tests

**Goal**: Build `TestHarness` (mock + MCP client), write end-to-end tests calling MCP tools.

- 7a. Create `tests/helpers/test-harness.ts` — `TestHarness.start(opts)` spawns both mock and MCP server, provides `callTool()` and `getMockState()`
- 7b. `tests/e2e/connect.test.ts` — connect/disconnect via MCP, verify response text
- 7c. `tests/e2e/set-parameters.test.ts` — set params via MCP, verify mock state (Nord drawbar, Prophet-6 osc, JUNO-X analog synth)
- 7d. `tests/e2e/get-state.test.ts` — get state, get state by section, verify contents
- 7e. `tests/e2e/list-parameters.test.ts` — list all, list by section, verify param names
- 7f. `tests/e2e/multi-model.test.ts` — for each model: start → connect → list_parameters → get_state → stop. This is the multi-model regression guard.

**Files**: `tests/helpers/test-harness.ts`, `tests/e2e/*.test.ts`

### CHECKPOINT 5
Run `npm run test:e2e`. All E2E tests pass. The full pipeline works: MCP client → MCP server → MIDI → mock handler → WebSocket → state verified.

---

## Task 8: Full Suite & Documentation

**Goal**: Wire everything together, update pending plan status.

- 8a. Ensure `npm test` runs all layers in sequence (unit → integration → E2E)
- 8b. Move `docs/plans/pending/2-test-automation-framework.md` to `docs/plans/completed/`
- 8c. Add testing section to `CLAUDE.md` with commands and how to add tests for new models

**Files**: `package.json`, `CLAUDE.md` (modify), move plan file

### CHECKPOINT 6 (Final)
Run `npm test`. All unit, integration, and E2E tests pass. Run `npm run test:check` for type safety. Full suite completes in under 60 seconds.

---

## Key Files

| File | Role |
|------|------|
| `src/shared/parameter-resolution.ts` | Encoding functions tested in Task 2 |
| `src/shared/keyboard-model.ts` | MockHandler interface — contract tested in Task 3 |
| `src/shared/model-registry.ts` | Discovery functions tested in Task 4 |
| `src/mock-runner/engine.ts` | Needs `start()` → `Promise<void>` (Task 5) |
| `src/keyboard_models/*/mock-handler.ts` | Each model's handler under test |
| `src/keyboard_models/*/midi-map.ts` | Parameter maps validated in Task 4 |

## Test File Summary

| File | Layer |
|------|-------|
| `tests/unit/parameter-resolution.test.ts` | Unit — shared |
| `tests/unit/model-registry.test.ts` | Unit — shared |
| `tests/unit/nord-electro-5d/mock-handler.test.ts` | Unit — per-model |
| `tests/unit/nord-electro-5d/parameter-map.test.ts` | Unit — per-model |
| `tests/unit/juno-x/mock-handler.test.ts` | Unit — per-model |
| `tests/unit/juno-x/parameter-map.test.ts` | Unit — per-model |
| `tests/unit/prophet-6/mock-handler.test.ts` | Unit — per-model |
| `tests/unit/prophet-6/parameter-map.test.ts` | Unit — per-model |
| `tests/helpers/mock-process.ts` | Helper |
| `tests/integration/mock-runner.test.ts` | Integration |
| `tests/helpers/test-harness.ts` | Helper |
| `tests/e2e/connect.test.ts` | E2E |
| `tests/e2e/set-parameters.test.ts` | E2E |
| `tests/e2e/get-state.test.ts` | E2E |
| `tests/e2e/list-parameters.test.ts` | E2E |
| `tests/e2e/multi-model.test.ts` | E2E |
