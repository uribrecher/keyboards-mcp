# File Menu — Save / Open / Recents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `File` menu to the Electron mock-runner with Save / Save As / Open / Open Recent so the user can persist a complete studio rack and reload it across launches.

**Architecture:** A new `.mockrack` JSON file holds tab metadata (modelId, label) plus a per-tab opaque state snapshot from `MockHandler.getFullState(false)`. The main process owns the file pointer, dirty flag, and tab order. A new optional `MockHandler.setFullState(snapshot)` lets each model round-trip its state; models opt in incrementally (Nord first; JUNO-X and Prophet-6 ride along as identity-only until they implement it). Recents use macOS's built-in `recentDocuments` role and `app.getRecentDocuments()`; on launch the most-recent surviving file is auto-loaded.

**Tech Stack:** TypeScript, Electron, `node:fs`, `node:test` + `node:assert`, ESLint 9 flat config.

**Spec:** `docs/superpowers/specs/2026-05-04-file-menu-design.md`

---

## File map

### Created

- `src/shared/mockrack-format.ts` — `MockrackV1` types, `parseMockrack()`, `serializeMockrack()`, `writeMockrackAtomic()`. Pure functions; the tool-using layer (main process) imports it.
- `tests/unit/mockrack-format.test.ts` — schema validation + atomic-write tests.
- `tests/unit/nord-set-full-state.test.ts` — Nord round-trip.
- `tests/integration/save-load-roundtrip.test.ts` — two `MockProcess` instances, save → restore.

### Modified

- `src/shared/keyboard-model.ts` — add optional `setFullState(snapshot)` to `MockHandler`.
- `src/mock-runner/engine.ts` — extend `EventEmitter`; add `getFullState(includeInventory)`, `restoreSnapshot(snapshot)`; emit `'state-changed'` from `broadcast()`.
- `src/mock-runner/main.ts` — `currentFilePath`, `isDirty`, `restoring`, `lastActiveTabId`; new IPC: `set-active-tab`. Menu: New Tab / Open / Open Recent / Save / Save As / Extract Backup / Quit. Save/Open/Recents/before-quit handlers. Subscribe to each engine's `state-changed`. Launch auto-load via `app.getRecentDocuments()`.
- `src/mock-runner/preload.cjs` — expose `setActiveTab`, `onDirtyChanged`, `onCloseTab`, `onMountTab`.
- `src/mock-runner/shell/app.js` — push `setActiveTab` on every tab activation; listen for `file:dirty-changed` (title bar) / `file:close-tab` / `file:mount-tab` (Open flow); render the dirty `•`.
- `src/keyboard_models/nord/electro_5d/mock-handler.ts` — implement `setFullState(snapshot)` mirroring `getFullState`.
- `package.json` — `build.fileAssociations` for `.mockrack`.

---

## Task 1: Add `setFullState` to the `MockHandler` interface

**Files:**
- Modify: `src/shared/keyboard-model.ts:144-152`

- [ ] **Step 1: Edit the interface**

In `src/shared/keyboard-model.ts`, update the `MockHandler` interface block (currently at the lines documenting `init`, `onMIDI`, `getFullState`, `onCacheReload`):

```ts
export interface MockHandler {
  /**
   * Called once when the mock engine starts.
   * `label` (optional) selects which per-instance backup cache to load —
   * see `BackupCacheCapability`. Defaults to `"_default"`.
   */
  init(lowerChannel: number, upperChannel: number, label?: string): void;
  /** Process any MIDI message. Returns state to broadcast and/or a log line. */
  onMIDI(msg: MidiMessage): MockHandlerResult;
  /** Return the complete current state (for new WebSocket clients) */
  getFullState(includeInventory: boolean): Record<string, any>;
  /** Reload cached data (e.g., backup cache) */
  onCacheReload?(): void;
  /**
   * Restore the handler's internal state from a snapshot previously
   * produced by `getFullState(false)`.
   *
   * Implementers MUST treat the input as best-effort:
   *   - missing fields → keep current defaults (don't throw)
   *   - unknown extra fields → ignore
   *   - malformed shapes → log and partially recover, never throw
   *
   * Implementers MUST NOT broadcast — the engine emits a single
   * `getFullState(true)` broadcast after this call returns, so the UI
   * sees one consistent transition.
   */
  setFullState?(snapshot: Record<string, any>): void;
}
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `npm run build`
Expected: clean exit (the new method is optional, no implementer needs to change yet).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/shared/keyboard-model.ts
git commit -m "feat(plan9): MockHandler.setFullState? optional contract"
```

---

## Task 2: Extend `MockEngine` with `EventEmitter`, snapshot helpers, and a `state-changed` event

**Files:**
- Modify: `src/mock-runner/engine.ts`
- Test: `tests/unit/engine-state-changed.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/engine-state-changed.test.ts`:

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MockEngine } from "../../src/mock-runner/engine.js";
import type { MockHandler } from "../../src/shared/keyboard-model.js";

function makeStubHandler(): MockHandler {
  let label: string | undefined;
  let lower = 0, upper = 1;
  const state: Record<string, any> = { foo: 0 };
  return {
    init(l, u, lab) { lower = l; upper = u; label = lab; },
    onMIDI: () => ({}),
    getFullState: () => ({ ...state, _meta: { lower, upper, label } }),
    setFullState(snap) { Object.assign(state, snap); },
  };
}

describe("MockEngine snapshot + state-changed", () => {
  it("getFullState(false) delegates to the handler with includeInventory=false", async () => {
    const handler = makeStubHandler();
    let captured: boolean | undefined;
    handler.getFullState = (includeInventory) => {
      captured = includeInventory;
      return { ok: true };
    };
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    const snap = engine.getFullState(false);
    assert.equal(captured, false);
    assert.deepEqual(snap, { ok: true });
  });

  it("restoreSnapshot returns false when handler lacks setFullState", () => {
    const handler = makeStubHandler();
    delete (handler as any).setFullState;
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    assert.equal(engine.restoreSnapshot({ any: "thing" }), false);
  });

  it("restoreSnapshot returns true and calls setFullState when supported", () => {
    const handler = makeStubHandler();
    let received: any = null;
    handler.setFullState = (snap) => { received = snap; };
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    assert.equal(engine.restoreSnapshot({ a: 1 }), true);
    assert.deepEqual(received, { a: 1 });
  });

  it("restoreSnapshot returns false (and does not throw) when snapshot is null", () => {
    const handler = makeStubHandler();
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    assert.equal(engine.restoreSnapshot(null), false);
  });
});
```

- [ ] **Step 2: Run the test — it should fail**

Run: `npx tsx --test tests/unit/engine-state-changed.test.ts`
Expected: failures referencing `engine.getFullState`, `engine.restoreSnapshot` not being functions.

- [ ] **Step 3: Edit `src/mock-runner/engine.ts`**

At the top of the file, alongside the existing imports:

```ts
import { EventEmitter } from "node:events";
```

Change the class header from `export class MockEngine {` to:

```ts
export class MockEngine extends EventEmitter {
```

Add `super()` to the constructor's first line:

```ts
constructor(handler: MockHandler, opts: EngineOptions) {
  super();
  this.handler = handler;
  this.opts = opts;
  this.actualPortName = opts.portName;
}
```

Inside the existing `private broadcast(msg: Record<string, any>): void { ... }` method, append a single line at the end of the method body:

```ts
this.emit("state-changed");
```

Add two new public methods just after the existing `relabel(...)` method:

```ts
/** Snapshot of the handler's current state. Used by Save. */
getFullState(includeInventory: boolean): Record<string, any> {
  return this.handler.getFullState(includeInventory);
}

/**
 * Restore the handler's internal state from a snapshot. Returns false
 * when the snapshot is missing or the handler doesn't implement
 * `setFullState` (graceful-degradation path — caller logs).
 *
 * On success, broadcasts a single fresh full-state snapshot so UI
 * clients (and the MCP status WS) see one consistent transition.
 */
restoreSnapshot(snapshot: Record<string, any> | null): boolean {
  if (!snapshot) return false;
  if (!this.handler.setFullState) return false;
  try { this.handler.setFullState(snapshot); }
  catch (err) { console.error("setFullState failed:", err); return false; }
  this.broadcast(this.handler.getFullState(true));
  return true;
}
```

- [ ] **Step 4: Run the tests — should pass**

Run: `npx tsx --test tests/unit/engine-state-changed.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/mock-runner/engine.ts tests/unit/engine-state-changed.test.ts
git commit -m "feat(plan9): MockEngine.getFullState + restoreSnapshot + state-changed event"
```

---

## Task 3: New `mockrack-format.ts` — types, parser, serializer, atomic write

**Files:**
- Create: `src/shared/mockrack-format.ts`
- Test: `tests/unit/mockrack-format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mockrack-format.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOCKRACK_VERSION,
  parseMockrack,
  serializeMockrack,
  writeMockrackAtomic,
  type MockrackV1,
  type MockrackTab,
} from "../../src/shared/mockrack-format.js";

function makeTab(over: Partial<MockrackTab> = {}): MockrackTab {
  return { modelId: "nord-electro-5d", label: "studio-nord", state: null, ...over };
}

function makeFile(over: Partial<MockrackV1> = {}): MockrackV1 {
  return {
    $schema: "mockrack/v1",
    version: MOCKRACK_VERSION,
    savedAt: "2026-05-04T18:00:00Z",
    appVersion: "2.0.0",
    activeTabIndex: 0,
    tabs: [makeTab()],
    ...over,
  };
}

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "mockrack-test-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe("parseMockrack", () => {
  it("accepts a minimal valid file", () => {
    const file = makeFile();
    const parsed = parseMockrack(JSON.stringify(file));
    assert.deepEqual(parsed, file);
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => parseMockrack("not json"), /Failed to parse/);
  });

  it("rejects a higher schema version", () => {
    const file = makeFile({ version: 99 as any });
    assert.throws(() => parseMockrack(JSON.stringify(file)),
      /requires Mock Runner v99; you're on v1/);
  });

  it("rejects when tabs is not an array", () => {
    const bad = { ...makeFile(), tabs: "nope" } as any;
    assert.throws(() => parseMockrack(JSON.stringify(bad)), /tabs/);
  });

  it("rejects a tab missing modelId", () => {
    const bad = makeFile({ tabs: [{ label: "x", state: null } as any] });
    assert.throws(() => parseMockrack(JSON.stringify(bad)), /modelId/);
  });

  it("rejects a tab missing label", () => {
    const bad = makeFile({ tabs: [{ modelId: "x", state: null } as any] });
    assert.throws(() => parseMockrack(JSON.stringify(bad)), /label/);
  });

  it("accepts state: null and state: object", () => {
    const file = makeFile({ tabs: [
      makeTab({ state: null }),
      makeTab({ label: "two", state: { foo: 1 } }),
    ]});
    const parsed = parseMockrack(JSON.stringify(file));
    assert.equal(parsed.tabs.length, 2);
    assert.equal(parsed.tabs[0].state, null);
    assert.deepEqual(parsed.tabs[1].state, { foo: 1 });
  });

  it("clamps activeTabIndex into [0, tabs.length-1]", () => {
    const tooBig = parseMockrack(JSON.stringify(makeFile({ activeTabIndex: 99 })));
    assert.equal(tooBig.activeTabIndex, 0);
    const negative = parseMockrack(JSON.stringify(makeFile({ activeTabIndex: -3 })));
    assert.equal(negative.activeTabIndex, 0);
    const empty = parseMockrack(JSON.stringify(makeFile({ activeTabIndex: 5, tabs: [] })));
    assert.equal(empty.activeTabIndex, 0);
  });
});

describe("serializeMockrack", () => {
  it("produces a parseable JSON string with stable shape", () => {
    const file = makeFile();
    const json = serializeMockrack(file);
    const round = parseMockrack(json);
    assert.deepEqual(round, file);
  });
});

describe("writeMockrackAtomic", () => {
  it("writes via per-process tmp file then renames", () => {
    const path = join(dataDir, "rig.mockrack");
    writeMockrackAtomic(path, makeFile());
    assert.ok(existsSync(path));
    // No leftover .tmp
    const leftover = readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));
    assert.equal(leftover.length, 0);
    // Round-trip
    const parsed = parseMockrack(readFileSync(path, "utf-8"));
    assert.equal(parsed.tabs[0].label, "studio-nord");
  });

  it("creates the parent directory if missing", () => {
    const path = join(dataDir, "nested", "deeper", "rig.mockrack");
    writeMockrackAtomic(path, makeFile());
    assert.ok(existsSync(path));
  });
});
```

- [ ] **Step 2: Run the test — should fail (module missing)**

Run: `npx tsx --test tests/unit/mockrack-format.test.ts`
Expected: failure resolving `../../src/shared/mockrack-format.js`.

- [ ] **Step 3: Create `src/shared/mockrack-format.ts`**

```ts
/**
 * `.mockrack` v1 JSON schema — used by File → Save / Open in the
 * Electron mock-runner to round-trip a complete studio rack.
 *
 * Spec: docs/superpowers/specs/2026-05-04-file-menu-design.md
 */

import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

export const MOCKRACK_VERSION = 1;

export interface MockrackTab {
  /** Keyboard model id (e.g. "nord-electro-5d"). */
  modelId: string;
  /** Per-instance backup-cache key. */
  label: string;
  /** Per-model getFullState(false) snapshot, or null for graceful degradation. */
  state: Record<string, any> | null;
}

export interface MockrackV1 {
  $schema: "mockrack/v1";
  version: 1;
  /** Informational. */
  savedAt: string;
  /** Informational. */
  appVersion: string;
  /** Foregrounded tab on restore. Clamped on parse. */
  activeTabIndex: number;
  tabs: MockrackTab[];
}

/** Parse + validate a `.mockrack` JSON string. Throws with a user-friendly error. */
export function parseMockrack(text: string): MockrackV1 {
  let raw: any;
  try { raw = JSON.parse(text); }
  catch (err) {
    throw new Error(`Failed to parse .mockrack JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid .mockrack: top-level value must be an object.");
  }
  if (typeof raw.version !== "number") {
    throw new Error("Invalid .mockrack: missing or non-numeric `version` field.");
  }
  if (raw.version !== MOCKRACK_VERSION) {
    throw new Error(`This setup requires Mock Runner v${raw.version}; you're on v${MOCKRACK_VERSION}.`);
  }
  if (!Array.isArray(raw.tabs)) {
    throw new Error("Invalid .mockrack: `tabs` must be an array.");
  }
  const tabs: MockrackTab[] = raw.tabs.map((t: any, i: number) => {
    if (!t || typeof t !== "object") {
      throw new Error(`Invalid .mockrack: tabs[${i}] must be an object.`);
    }
    if (typeof t.modelId !== "string" || t.modelId.length === 0) {
      throw new Error(`Invalid .mockrack: tabs[${i}].modelId must be a non-empty string.`);
    }
    if (typeof t.label !== "string" || t.label.length === 0) {
      throw new Error(`Invalid .mockrack: tabs[${i}].label must be a non-empty string.`);
    }
    if (t.state !== null && (typeof t.state !== "object")) {
      throw new Error(`Invalid .mockrack: tabs[${i}].state must be an object or null.`);
    }
    return { modelId: t.modelId, label: t.label, state: t.state ?? null };
  });

  // Clamp activeTabIndex
  let active = typeof raw.activeTabIndex === "number" ? Math.floor(raw.activeTabIndex) : 0;
  if (tabs.length === 0 || active < 0 || active >= tabs.length) active = 0;

  return {
    $schema: "mockrack/v1",
    version: MOCKRACK_VERSION,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : new Date(0).toISOString(),
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "unknown",
    activeTabIndex: active,
    tabs,
  };
}

/** Serialize a `MockrackV1` to a deterministic, pretty JSON string. */
export function serializeMockrack(file: MockrackV1): string {
  return JSON.stringify(file, null, 2);
}

/**
 * Atomically write a `.mockrack` file. Uses a per-process tmp file +
 * rename so two writers (e.g., a quick double-save) never collide on
 * `<path>.tmp`.
 */
export function writeMockrackAtomic(path: string, file: MockrackV1): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, serializeMockrack(file), "utf-8");
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run the test — should pass**

Run: `npx tsx --test tests/unit/mockrack-format.test.ts`
Expected: 11 passing.

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/mockrack-format.ts tests/unit/mockrack-format.test.ts
git commit -m "feat(plan9): mockrack JSON format — parse, serialize, atomic write"
```

---

## Task 4: Implement `setFullState` on the Nord mock-handler

**Files:**
- Modify: `src/keyboard_models/nord/electro_5d/mock-handler.ts`
- Test: `tests/unit/nord-set-full-state.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/nord-set-full-state.test.ts`:

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DMockHandler } from "../../src/keyboard_models/nord/electro_5d/mock-handler.js";

describe("Nord setFullState round-trip", () => {
  it("setFullState(getFullState(false)) restores the same state", () => {
    const a = createNordElectro5DMockHandler();
    a.init(1, 2);
    // Drive some MIDI to mutate state
    a.onMIDI({ type: "cc", controller: 70, value: 100, channel: 2 }); // upper drawbar
    a.onMIDI({ type: "cc", controller: 71, value: 50,  channel: 1 }); // lower drawbar
    a.onMIDI({ type: "cc", controller: 96, value: 4,   channel: 0 }); // global reverb type
    const before = a.getFullState(false);

    const b = createNordElectro5DMockHandler();
    b.init(1, 2);
    assert.ok(b.setFullState, "Nord handler should implement setFullState");
    b.setFullState!(JSON.parse(JSON.stringify(before)));
    const after = b.getFullState(false);

    // Compare the fields setFullState is responsible for round-tripping.
    // The full snapshot may include lastChange / volatile fields that
    // are intentionally not restored — only the persistent state
    // matters.
    assert.deepEqual(after.lower,  before.lower);
    assert.deepEqual(after.upper,  before.upper);
    assert.deepEqual(after.global, before.global);
    assert.deepEqual(after.preset1Drawbars, before.preset1Drawbars);
    assert.deepEqual(after.preset2Drawbars, before.preset2Drawbars);
  });

  it("does not broadcast (caller is responsible)", () => {
    // setFullState should be pure on the handler — engine.restoreSnapshot
    // wraps it with a single broadcast. No way to assert "no broadcast"
    // directly here, but we can assert the handler returns void and does
    // not throw on a minimal snapshot.
    const a = createNordElectro5DMockHandler();
    a.init(1, 2);
    assert.doesNotThrow(() => a.setFullState!({}));
  });

  it("ignores unknown extra fields and does not throw", () => {
    const a = createNordElectro5DMockHandler();
    a.init(1, 2);
    assert.doesNotThrow(() => a.setFullState!({ rubbish: 123, mystery: "x" }));
  });
});
```

- [ ] **Step 2: Run the test — should fail**

Run: `npx tsx --test tests/unit/nord-set-full-state.test.ts`
Expected: `Nord handler should implement setFullState` assertion fails.

- [ ] **Step 3: Implement `setFullState` in the Nord handler**

In `src/keyboard_models/nord/electro_5d/mock-handler.ts`, locate the returned `MockHandler` object (the block starting `return {`). Add a new method right after `onCacheReload(): void { ... }`:

```ts
    setFullState(snapshot: Record<string, any>): void {
      // Best-effort tolerant restore. Missing fields keep current
      // defaults; unknown fields are ignored. Never broadcast — engine
      // emits a single getFullState(true) after this returns.
      try {
        // Per-channel CC maps: rebuild from snapshot.lower / .upper /
        // .global. Each section is a Record<paramKey, ParamState>.
        const restoreChannel = (ch: number, section: any) => {
          if (!section || typeof section !== "object") return;
          if (!channelState.has(ch)) initChannel(ch);
          const chState = channelState.get(ch)!;
          for (const [, ps] of Object.entries<any>(section)) {
            if (ps && typeof ps === "object" && typeof ps.cc === "number" && typeof ps.value === "number") {
              chState.set(ps.cc, ps.value);
            }
          }
        };
        restoreChannel(lowerChannel, snapshot.lower);
        restoreChannel(upperChannel, snapshot.upper);
        // Global params live on channel 0
        restoreChannel(0, snapshot.global);

        // Per-preset drawbars
        const restorePreset = (key: "preset1" | "preset2", arr: any) => {
          const map = presetDrawbarState.get(key);
          if (!map) return;
          map.clear();
          if (!Array.isArray(arr)) return;
          for (const entry of arr) {
            if (entry && typeof entry.cc === "number" && typeof entry.value === "number") {
              map.set(entry.cc, entry.value);
            }
          }
        };
        if (snapshot.preset1Drawbars !== undefined) restorePreset("preset1", snapshot.preset1Drawbars);
        if (snapshot.preset2Drawbars !== undefined) restorePreset("preset2", snapshot.preset2Drawbars);

        // Preset organ toggles
        if (snapshot.presetOrganToggles && typeof snapshot.presetOrganToggles === "object") {
          presetOrganToggles = {
            pst1Vib: !!snapshot.presetOrganToggles.pst1Vib,
            pst1Prc: !!snapshot.presetOrganToggles.pst1Prc,
            pst2Vib: !!snapshot.presetOrganToggles.pst2Vib,
            pst2Prc: !!snapshot.presetOrganToggles.pst2Prc,
          };
        }

        // Set-list / program state
        if (typeof snapshot.setListMode === "boolean") setListMode = snapshot.setListMode;
        if (typeof snapshot.currentSetList === "number") currentSetList = snapshot.currentSetList;
        if (typeof snapshot.currentSong === "number") currentSong = snapshot.currentSong;
        if (typeof snapshot.currentPart === "number") currentPart = snapshot.currentPart;
        if (typeof snapshot.currentBank === "number") currentBank = snapshot.currentBank;
        if (typeof snapshot.currentProgram === "number") currentProgram = snapshot.currentProgram;
        if (typeof snapshot.programLoaded === "boolean") programLoaded = snapshot.programLoaded;
      } catch (err) {
        console.error("Nord setFullState: partial recovery —", err);
      }
    },
```

> The exact field names (e.g. `snapshot.lower`, `snapshot.preset1Drawbars`) match what `getFullState(false)` already produces in this handler — confirm by skimming the existing `buildFullState()` function near the bottom of the same file.

- [ ] **Step 4: Run the test — should pass**

Run: `npx tsx --test tests/unit/nord-set-full-state.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Run the broader Nord tests to confirm no regression**

Run: `npx tsx --test tests/unit/nord-electro-5d/`
Expected: all green.

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/keyboard_models/nord/electro_5d/mock-handler.ts tests/unit/nord-set-full-state.test.ts
git commit -m "feat(plan9): Nord setFullState — round-trip channel state, presets, set-list"
```

---

## Task 5: Add dirty tracking + `set-active-tab` IPC in main

**Files:**
- Modify: `src/mock-runner/main.ts`
- Modify: `src/mock-runner/preload.cjs`

- [ ] **Step 1: Add module-level state to `main.ts`**

In `src/mock-runner/main.ts`, just below the `tabs` map declaration, add:

```ts
// ── File-menu session state (plan #9) ──
let currentFilePath: string | null = null;
let isDirty = false;
let restoring = false;
let lastActiveTabId: string | null = null;
let dirtyDebounceTimer: NodeJS.Timeout | null = null;

function markDirty(): void {
  if (restoring) return;
  if (isDirty) return;
  isDirty = true;
  pushDirtyChanged();
}

function clearDirty(): void {
  if (!isDirty) return;
  isDirty = false;
  pushDirtyChanged();
}

function pushDirtyChanged(): void {
  mainWindow?.webContents.send("file:dirty-changed", { isDirty, currentFilePath });
}

/** Debounced state-changed handler for engine broadcasts. */
function onEngineStateChanged(): void {
  if (restoring) return;
  if (dirtyDebounceTimer) return;
  dirtyDebounceTimer = setTimeout(() => {
    dirtyDebounceTimer = null;
    markDirty();
  }, 250);
}
```

- [ ] **Step 2: Wire `markDirty()` into existing IPC handlers**

In each of the existing handlers, add a `markDirty();` call at the end of the success path:

- `ipcMain.handle("create-tab", ...)` — after `tabs.set(...)`.
- `ipcMain.handle("close-tab", ...)` — after `tabs.delete(tabId)`.
- `ipcMain.handle("rename-tab", ...)` — after `entry.label = slug;` and the engine relabel.
- `ipcMain.handle("select-model-for-tab", ...)` — after `entry.model = model; entry.engine = engine; …`.
- `ipcMain.handle("extract-backup", ...)` — at the end of the success branch (just before the `ok: true` return).

Subscribe to engine state-changed inside `select-model-for-tab` right after `await engine.start();`:

```ts
engine.on("state-changed", onEngineStateChanged);
```

- [ ] **Step 3: Add `set-active-tab` IPC handler**

After the `list-tabs` handler in `main.ts`. Note: switching the active tab is **not** a dirty trigger — it's pure navigation. The new active index is captured at save time via `lastActiveTabId`.

```ts
ipcMain.handle("set-active-tab", (_event, tabId: string): void => {
  if (typeof tabId === "string") {
    lastActiveTabId = tabId;
  }
});
```

- [ ] **Step 4: Expose `setActiveTab` and listeners on the preload bridge**

In `src/mock-runner/preload.cjs`, add to the `mockRunnerAPI` object:

```js
  // Plan 9 — file menu plumbing
  setActiveTab: (tabId) => ipcRenderer.invoke("set-active-tab", tabId),
  onDirtyChanged: (cb) => ipcRenderer.on("file:dirty-changed", (_e, payload) => cb(payload)),
  onCloseTab: (cb) => ipcRenderer.on("file:close-tab", (_e, payload) => cb(payload)),
  onMountTab: (cb) => ipcRenderer.on("file:mount-tab", (_e, payload) => cb(payload)),
```

- [ ] **Step 5: Wire renderer to push `setActiveTab` and react to dirty-changed**

In `src/mock-runner/shell/app.js`, modify the `setActive(tabId)` function so that immediately after setting `activeTabId = tabId`, it pushes to main:

```js
function setActive(tabId) {
  activeTabId = tabId;
  for (const t of tabs) {
    const isActive = t.tabId === tabId;
    t.button.classList.toggle("is-active", isActive);
    if (t.iframe) t.iframe.hidden = !isActive;
  }
  slotEmpty.hidden = tabs.length > 0;
  if (tabId) void api.setActiveTab(tabId);
}
```

At the end of `app.js` (just before the chat-related code, or anywhere after `api` is declared), register the dirty listener:

```js
// Title-bar dirty indicator
api.onDirtyChanged?.(({ isDirty, currentFilePath }) => {
  const base = "Mock Runner";
  const file = currentFilePath ? currentFilePath.split("/").pop() : null;
  const title = file ? `${base} — ${file}${isDirty ? " •" : ""}` : base;
  document.title = title;
});
```

- [ ] **Step 6: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all green (no test changes; this task is plumbing only, no behavior change visible to existing tests).

- [ ] **Step 8: Commit**

```bash
git add src/mock-runner/main.ts src/mock-runner/preload.cjs src/mock-runner/shell/app.js
git commit -m "feat(plan9): dirty tracking + set-active-tab IPC + title-bar dirty indicator"
```

---

## Task 6: Save / Save As menu items + handlers

**Files:**
- Modify: `src/mock-runner/main.ts` (menu template + new save flow)

- [ ] **Step 1: Add the save flow helpers in `main.ts`**

Just below the helpers from Task 5 (`onEngineStateChanged`), add:

```ts
import { writeMockrackAtomic, type MockrackV1, type MockrackTab, MOCKRACK_VERSION } from "../shared/mockrack-format.js";

function buildSetupSnapshot(): MockrackV1 {
  const entries = [...tabs.values()].filter((t) => t.model && t.engine);
  const tabsOut: MockrackTab[] = entries.map((t) => ({
    modelId: t.model!.info.id,
    label:   t.label ?? "_default",
    state:   t.engine!.getFullState(false),
  }));
  let activeTabIndex = 0;
  if (lastActiveTabId) {
    const i = entries.findIndex((t) => t.tabId === lastActiveTabId);
    if (i >= 0) activeTabIndex = i;
  }
  return {
    $schema: "mockrack/v1",
    version: MOCKRACK_VERSION,
    savedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    activeTabIndex,
    tabs: tabsOut,
  };
}

async function saveCurrent(): Promise<void> {
  if (!currentFilePath) { await saveAs(); return; }
  try {
    writeMockrackAtomic(currentFilePath, buildSetupSnapshot());
    app.addRecentDocument(currentFilePath);
    clearDirty();
  } catch (err) {
    dialog.showErrorBox("Save failed", err instanceof Error ? err.message : String(err));
  }
}

async function saveAs(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  const result = await dialog.showSaveDialog(win, {
    title: "Save Studio Setup",
    defaultPath: currentFilePath ?? "untitled.mockrack",
    filters: [{ name: "Mock Runner Setup", extensions: ["mockrack"] }],
  });
  if (result.canceled || !result.filePath) return;
  try {
    writeMockrackAtomic(result.filePath, buildSetupSnapshot());
    currentFilePath = result.filePath;
    app.addRecentDocument(result.filePath);
    clearDirty();
    pushDirtyChanged();
  } catch (err) {
    dialog.showErrorBox("Save failed", err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 2: Add Save / Save As to the menu**

Replace the existing `submenu` in `buildMenu()` with the full plan-9 menu:

```ts
const template: Electron.MenuItemConstructorOptions[] = [
  {
    label: "File",
    submenu: [
      {
        label: "New Tab",
        accelerator: "CmdOrCtrl+T",
        click: () => mainWindow?.webContents.send("menu:new-tab"),
      },
      {
        label: "Open…",
        accelerator: "CmdOrCtrl+O",
        click: () => { void openDialog(); },
      },
      { role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] },
      { type: "separator" },
      {
        label: "Save",
        accelerator: "CmdOrCtrl+S",
        click: () => { void saveCurrent(); },
      },
      {
        label: "Save As…",
        accelerator: "CmdOrCtrl+Shift+S",
        click: () => { void saveAs(); },
      },
      { type: "separator" },
      {
        label: "Extract Backup…",
        accelerator: "CmdOrCtrl+E",
        click: () => mainWindow?.webContents.send("menu:extract-backup"),
      },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  { role: "editMenu" },
  { role: "viewMenu" },
  { role: "windowMenu" },
];
```

- [ ] **Step 3: Add a stub `openDialog` so the menu item compiles**

Add right after `saveAs`:

```ts
async function openDialog(): Promise<void> {
  // Real implementation lands in Task 7.
  console.log("openDialog: not yet implemented");
}
```

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 5: Manual smoke test**

Launch the runner: `npm run mock:runner`. Open a tab, tweak something, hit `⌘S` → expect a save dialog. Pick a path. Quit. Expected: the file appears at the chosen path, contains valid `.mockrack` JSON.

- [ ] **Step 6: Commit**

```bash
git add src/mock-runner/main.ts
git commit -m "feat(plan9): Save / Save As menu items + buildSetupSnapshot"
```

---

## Task 7: Open menu + dirty prompt + Open flow

**Files:**
- Modify: `src/mock-runner/main.ts`

- [ ] **Step 1: Add the Open flow**

Add the helpers below `saveAs()` in `main.ts`:

```ts
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { parseMockrack } from "../shared/mockrack-format.js";

/** Returns true if the user wants to proceed. False on Cancel. */
async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!isDirty) return true;
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return true;
  const fileLabel = currentFilePath
    ? currentFilePath.split("/").pop() ?? "current setup"
    : "current setup";
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: `Save changes to "${fileLabel}"?`,
    detail: "Your changes will be lost if you don't save them.",
  });
  if (result.response === 2) return false; // Cancel
  if (result.response === 0) {              // Save
    if (currentFilePath) await saveCurrent();
    else await saveAs();
    // If they cancelled the save dialog, currentFilePath stays null and isDirty stays true.
    if (isDirty) return false;
  }
  return true; // Don't Save (or Save succeeded)
}

async function tearDownAllTabs(): Promise<void> {
  for (const entry of [...tabs.values()]) {
    if (entry.engine) {
      try { await entry.engine.stop(); } catch { /* swallow */ }
    }
    mainWindow?.webContents.send("file:close-tab", { tabId: entry.tabId });
    tabs.delete(entry.tabId);
  }
}

async function loadSetupFromPath(path: string): Promise<void> {
  let text: string;
  try { text = readFileSync(path, "utf-8"); }
  catch (err) {
    dialog.showErrorBox("Open failed", err instanceof Error ? err.message : String(err));
    return;
  }
  let parsed;
  try { parsed = parseMockrack(text); }
  catch (err) {
    dialog.showErrorBox("Open failed", err instanceof Error ? err.message : String(err));
    return;
  }

  restoring = true;
  try {
    await tearDownAllTabs();

    let activeTabId: string | null = null;
    for (let i = 0; i < parsed.tabs.length; i++) {
      const t = parsed.tabs[i];
      let model;
      try { model = await loadModelById(t.modelId); }
      catch {
        mainWindow?.webContents.send("menu:console-note",
          { text: `Skipped tab "${t.label}": model "${t.modelId}" not registered.` });
        continue;
      }
      const handler = model.createMockHandler?.();
      if (!handler) continue;
      const wsPort = nextFreePort();
      const portName = `${model.info.displayName} Mock`;
      const engine = new MockEngine(handler, {
        lowerChannel: LOWER_CH,
        upperChannel: UPPER_CH,
        wsPort, portName,
        modelId: model.info.id,
        displayName: model.info.displayName,
        label: t.label,
      });
      try { await engine.start(); }
      catch (err) {
        console.error(`Engine start failed for ${t.label}:`, err);
        continue;
      }
      engine.on("state-changed", onEngineStateChanged);

      const tabId = nextTabId();
      tabs.set(tabId, { tabId, model, engine, wsPort, label: t.label });

      const restored = engine.restoreSnapshot(t.state);
      if (!restored && t.state !== null) {
        mainWindow?.webContents.send("menu:console-note",
          { text: `${model.info.displayName} ("${t.label}"): full state restore not yet implemented — knobs reset to defaults.` });
      }

      mainWindow?.webContents.send("file:mount-tab", {
        tabId, modelInfoId: model.info.id, displayName: model.info.displayName,
        label: t.label, wsPort, modelUiDir: model.mockUiDir ?? null,
      });
      if (i === parsed.activeTabIndex) activeTabId = tabId;
    }

    if (activeTabId) lastActiveTabId = activeTabId;
    currentFilePath = path;
    app.addRecentDocument(path);
  } finally {
    restoring = false;
    clearDirty();
  }
}

async function openDialog(): Promise<void> {
  if (!await confirmDiscardIfDirty()) return;
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    title: "Open Studio Setup",
    properties: ["openFile"],
    filters: [{ name: "Mock Runner Setup", extensions: ["mockrack"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await loadSetupFromPath(result.filePaths[0]);
}
```

- [ ] **Step 2: Remove the Task-6 stub `openDialog`**

Delete the placeholder added in Task 6 (the one that just `console.log`s) — the real implementation above replaces it.

- [ ] **Step 3: Wire the renderer to react to `file:mount-tab` and `file:close-tab`**

In `src/mock-runner/shell/app.js`, near where `api.onMenuNewTab?.` is registered, add:

```js
api.onCloseTab?.(({ tabId }) => {
  const tab = findTab(tabId);
  if (!tab) return;
  if (tab.iframe) tab.iframe.remove();
  tab.button.remove();
  const idx = tabs.indexOf(tab);
  if (idx >= 0) tabs.splice(idx, 1);
  if (activeTabId === tabId) {
    const next = tabs[0]?.tabId ?? null;
    activeTabId = next;
    slotEmpty.hidden = tabs.length > 0;
    for (const t of tabs) t.button.classList.toggle("is-active", t.tabId === next);
  }
});

api.onMountTab?.((info) => {
  // Mirror the local `selectModelForTab` post-IPC bookkeeping.
  const tabId = info.tabId;
  // Build a tab UI entry without going through createTab/IPC since main
  // already created the engine.
  const tab = {
    tabId,
    modelInfoId: info.modelInfoId,
    displayName: info.displayName,
    label: info.label,
    wsPort: info.wsPort,
    iframe: null,
    button: null,
  };
  tabs.push(tab);
  const btn = renderTabButton(tab);
  tab.button = btn;
  tabbarEl.insertBefore(btn, tabPlusEl);
  const iframe = document.createElement("iframe");
  iframe.dataset.tabId = tabId;
  iframe.src = info.modelUiDir
    ? `file://${info.modelUiDir}/index.html?wsPort=${info.wsPort}`
    : "chooser.html";
  slotEl.appendChild(iframe);
  tab.iframe = iframe;
  setActive(tabId);
});
```

- [ ] **Step 4: Manual smoke test**

Launch: `npm run mock:runner`. Spin up two tabs, save → quit. Relaunch, hit `⌘O`, pick the saved file. Expect both tabs to come back. Try with a dirty session: tweak a knob, hit `⌘O`, expect the Save / Don't Save / Cancel prompt.

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/mock-runner/main.ts src/mock-runner/shell/app.js
git commit -m "feat(plan9): Open menu + dirty prompt + tab-restore IPC"
```

---

## Task 8: macOS `'open-file'` event + launch auto-load

**Files:**
- Modify: `src/mock-runner/main.ts`

- [ ] **Step 1: Listen for `'open-file'`**

In `main.ts`, just before `void app.whenReady().then(...)`, add:

```ts
// macOS hands paths to the running app via this event — fired by the
// dock, by Open Recent, and by file-association double-click.
app.on("open-file", (event, path) => {
  event.preventDefault();
  void (async () => {
    if (!await confirmDiscardIfDirty()) return;
    if (!existsSync(path)) {
      mainWindow?.webContents.send("menu:console-note",
        { text: `File not found: ${path}` });
      return;
    }
    await loadSetupFromPath(path);
  })();
});
```

- [ ] **Step 2: Auto-load the most-recent surviving setup at launch**

Inside `app.whenReady().then(() => { ... })`, after `createWindow();`, add:

```ts
// Wait for the renderer to be ready before mounting tabs into it.
mainWindow?.webContents.once("did-finish-load", () => {
  void (async () => {
    const recents = app.getRecentDocuments();
    for (const path of recents) {
      if (existsSync(path)) {
        await loadSetupFromPath(path);
        return;
      }
    }
    // No surviving recents → empty rack (today's behavior).
  })();
});
```

- [ ] **Step 3: Manual smoke test**

Save a setup. Quit. Relaunch — expect the saved setup to come back automatically. Delete the file off disk, relaunch — expect an empty rack.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/mock-runner/main.ts
git commit -m "feat(plan9): open-file event + launch auto-load from macOS recents"
```

---

## Task 9: Quit dirty prompt

**Files:**
- Modify: `src/mock-runner/main.ts`

- [ ] **Step 1: Intercept `before-quit`**

Replace the existing `app.on("window-all-closed", …)` block, and add a `before-quit` handler. The combined block:

```ts
let pendingQuit = false;

app.on("before-quit", (event) => {
  if (pendingQuit) return; // we already confirmed; let the quit proceed
  if (!isDirty) return;
  event.preventDefault();
  void (async () => {
    if (await confirmDiscardIfDirty()) {
      pendingQuit = true;
      app.quit();
    }
  })();
});

app.on("window-all-closed", async () => {
  console.log("\nShutting down all tab engines...");
  for (const t of tabs.values()) {
    if (t.engine) {
      try { await t.engine.stop(); } catch { /* swallow */ }
    }
  }
  tabs.clear();
  app.quit();
});
```

- [ ] **Step 2: Manual smoke test**

Make the rack dirty (tweak a knob). `⌘Q` → expect Save / Don't Save / Cancel. Cancel → app stays open. Save → file written, then quit. Don't Save → quit immediately discarding changes.

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/mock-runner/main.ts
git commit -m "feat(plan9): dirty prompt on Quit"
```

---

## Task 10: Add a `console-note` channel for in-shell user messages

**Files:**
- Modify: `src/mock-runner/preload.cjs`
- Modify: `src/mock-runner/shell/app.js`

The Open flow, launch fallback, and graceful-degradation paths all `webContents.send("menu:console-note", { text })`. The renderer needs to handle that.

- [ ] **Step 1: Expose the listener on the preload bridge**

Add inside `mockRunnerAPI`:

```js
  onConsoleNote: (cb) => ipcRenderer.on("menu:console-note", (_e, payload) => cb(payload)),
```

- [ ] **Step 2: Render the note in the chat console**

In `src/mock-runner/shell/app.js`, after the existing dirty-changed listener, add:

```js
api.onConsoleNote?.(({ text }) => {
  appendRow("system", text);
});
```

- [ ] **Step 3: Manual smoke test**

Trigger by: opening a setup whose `tabs[0].state` is non-null but the matching model lacks `setFullState` (e.g., a saved JUNO-X tab restored on this build). Expected: a one-line note appears in the chat panel.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/mock-runner/preload.cjs src/mock-runner/shell/app.js
git commit -m "feat(plan9): in-shell console-note channel for restore/load events"
```

---

## Task 11: Register `.mockrack` file association

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add fileAssociations**

The repo currently has no `electron-builder` config — the runner is launched via `npm run mock:runner` which uses `tsx` directly (see `keyboards-mcp/package.json`). For now, the file association only matters when the app is packaged for distribution. Since packaging is in a separate planned `macos-packager` repo, this task is reduced to:

In `package.json`, under a new `"build"` key, add:

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

This is read by `electron-builder` when packaging happens (or by anyone who picks it up later). It does not affect `npm run mock:runner` in dev.

- [ ] **Step 2: Build + lint to confirm package.json parses**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(plan9): register .mockrack file association for future packaging"
```

---

## Task 12: Integration test — save/load round-trip on two MockProcess instances

**Files:**
- Create: `tests/integration/save-load-roundtrip.test.ts`

- [ ] **Step 1: Write the test**

```ts
/**
 * Plan 9: save → restore round-trip via the data layer (no Electron).
 *
 * Spawns two MockProcess instances, mutates state on each via WS,
 * captures their getFullState(false), serializes a synthetic .mockrack
 * payload, and exercises parseMockrack + the engine's restoreSnapshot
 * path locally to assert the snapshot round-trips cleanly.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProcess } from "../helpers/mock-process.js";
import {
  parseMockrack,
  serializeMockrack,
  writeMockrackAtomic,
  MOCKRACK_VERSION,
  type MockrackV1,
} from "../../src/shared/mockrack-format.js";

let nextPort = 4400;

const isDocker = !!process.env.MOCK_WS_URL;

describe("plan #9 save/load round-trip", { concurrency: 1, skip: isDocker }, () => {
  it("two mocks → snapshot → write → re-read → identity preserved", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "save-load-"));
    const a = await MockProcess.start({ model: "nord-electro-5d", wsPort: nextPort++ });
    const b = await MockProcess.start({ model: "sequential-prophet-6", wsPort: nextPort++ });
    try {
      const stateA = await a.waitForState();
      const stateB = await b.waitForState();
      assert.ok(stateA);
      assert.ok(stateB);

      const file: MockrackV1 = {
        $schema: "mockrack/v1",
        version: MOCKRACK_VERSION,
        savedAt: new Date().toISOString(),
        appVersion: "test",
        activeTabIndex: 0,
        tabs: [
          { modelId: "nord-electro-5d", label: "studio", state: stateA },
          { modelId: "sequential-prophet-6", label: "stage",  state: stateB },
        ],
      };

      const path = join(tmp, "rig.mockrack");
      writeMockrackAtomic(path, file);
      const text = readFileSync(path, "utf-8");
      const round = parseMockrack(text);
      assert.equal(round.version, MOCKRACK_VERSION);
      assert.equal(round.tabs.length, 2);
      assert.equal(round.tabs[0].label, "studio");
      assert.equal(round.tabs[1].label, "stage");
      assert.deepEqual(round.tabs[0].state, stateA);
      assert.deepEqual(round.tabs[1].state, stateB);
    } finally {
      try { await a.stop(); } catch { /* ignore */ }
      try { await b.stop(); } catch { /* ignore */ }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a malformed file at .mockrack path surfaces a useful error", () => {
    const tmp = mkdtempSync(join(tmpdir(), "save-load-bad-"));
    try {
      const path = join(tmp, "bad.mockrack");
      writeFileSync(path, "this is not json", "utf-8");
      assert.throws(() => parseMockrack(readFileSync(path, "utf-8")),
        /Failed to parse \.mockrack/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx tsx --test tests/integration/save-load-roundtrip.test.ts`
Expected: 2 passing.

- [ ] **Step 3: Run the full integration suite**

Run: `npm run test:integration`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/save-load-roundtrip.test.ts
git commit -m "test(plan9): save/load round-trip integration"
```

---

## Task 13: Verify, move plan to completed, ship PR

- [ ] **Step 1: Full verification**

Run: `npm run build && npm run lint && npm test`
Expected: all green.

- [ ] **Step 2: Manual checklist**

- [ ] Save then *Save* (no dialog) overwrites the file.
- [ ] Save As to a new path; macOS recents updates.
- [ ] Quit dirty: prompt appears; Cancel aborts; Save → file saved + quit; Don't Save → quit immediately.
- [ ] Open a `.mockrack` containing a JUNO-X tab → graceful-degradation note in chat console.
- [ ] Launch with empty recents → empty rack.
- [ ] Delete the most-recent file off disk, then launch → falls through to next or empty.
- [ ] Tweak a knob → title bar shows `•`.
- [ ] After Save → `•` clears; tweak again → `•` returns.

- [ ] **Step 3: Move plan to completed**

```bash
git mv docs/plans/pending/9-file-menu.md docs/plans/completed/9-file-menu.md
git add -A
git commit -m "docs(plan9): mark complete"
```

- [ ] **Step 4: Push, open PR, address Copilot**

```bash
git push -u origin HEAD
gh pr create --title "feat: File menu — Save / Open / Recents (plan #9)" --body "$(cat <<'EOF'
## Summary

Adds a `File` menu to the Electron mock-runner with Save / Save As / Open / Open Recent. Studio rack state (every tab + label + per-tab handler snapshot) round-trips through a `.mockrack` JSON file. Launch auto-loads the most-recent surviving setup.

Spec: [2026-05-04-file-menu-design](docs/superpowers/specs/2026-05-04-file-menu-design.md)
Plan: [9-file-menu](docs/plans/completed/9-file-menu.md)

## What changed

- New optional `MockHandler.setFullState(snapshot)` contract — Nord ships with it; JUNO-X / Prophet-6 land in follow-ups (graceful degradation).
- `MockEngine` extends `EventEmitter`, exposes `getFullState(false)` + `restoreSnapshot(snap)`, fires `state-changed` from `broadcast()`.
- New `src/shared/mockrack-format.ts` — typed parse / serialize / atomic write for `.mockrack` JSON v1.
- Main process owns `currentFilePath` / `isDirty` / `restoring` / `lastActiveTabId`. Renderer pushes `set-active-tab`; main pushes `file:dirty-changed`, `file:close-tab`, `file:mount-tab`, and `menu:console-note`.
- File menu wired up. macOS recents via `{ role: 'recentDocuments' }` + `'open-file'` event. Quit dirty prompt via `before-quit`.
- `package.json` `build.fileAssociations` for future packaging.

## Test plan

- [x] `npm run lint` clean
- [x] `npm run build` clean
- [x] `npm run test:unit` — added `mockrack-format.test.ts`, `nord-set-full-state.test.ts`, `engine-state-changed.test.ts`.
- [x] `npm run test:integration` — added `save-load-roundtrip.test.ts`.
- [ ] Manual checklist (per the plan's Task 13).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After CI passes, address Copilot review comments and squash-merge.
