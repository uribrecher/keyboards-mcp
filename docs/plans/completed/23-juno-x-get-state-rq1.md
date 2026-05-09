# 23 — JUNO-X `get_current_state` via Roland RQ1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JUNO-X `get_current_state` stub (added in PR #65) with a real RQ1-based query. Foundations from #21 (mock RQ1→DT1 protocol) and #22 (MCP-side receive + `requestRolandValue`) make this a focused PR: wire the helper into the JUNO-X device's `getState`, decode + render, and update prompts to reflect that RQ1 actually works.

**Scope:** Scene-effect sections only — `scene-chorus` (3 params), `scene-delay` (2), `scene-reverb` (2), `scene-drive` (1). Eight params total. No-section calls read all four. Other sections (`scene-common`, `scene-part`, `scene-modify`, partials, etc.) return a "not yet supported for this section" tool result with the supported list.

**Out of scope:** per-part RQ1 reads (separate todo), ZCore / RD-piano partials, scene-modify section, scene-common/part. Those extend the read list later without touching transport.

**Architecture:** `JunoXDevice.getState` becomes async and uses `requestRolandValue` (from #22) per-param. Reads run in parallel via `Promise.allSettled` so one param's timeout doesn't block the others. Response text formats each param via the existing `parameterMap.formatValue` helper.

**Tech Stack:** TypeScript 5.5+, `node:test` + `node:assert`. No new dependencies.

**Source:** `docs/plans/pending/todo-list.md` item #23.
**Branch:** `feat/plan-23/juno-x-get-state` (create from `main`).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/shared/keyboard-model.ts` | modify | Widen `KeyboardDevice.getState` return type to `ToolResult \| Promise<ToolResult>` (matching the existing `loadProgram` / `loadSong` pattern). |
| `src/keyboard_models/roland/juno_x/device.ts` | modify | Replace the `getState` stub with the real RQ1 query: select scene-effect params by section filter, issue parallel `requestRolandValue` calls, decode + render. |
| `src/keyboard_models/roland/juno_x/index.ts` | modify | Update `agentSystemPrompt` — replace "not yet implemented (planned in todo #21)" with actual usage guidance. |
| `CLAUDE.md` | modify | Update the "MCP is stateless" Architecture section to reflect that JUNO-X `get_current_state` actually queries the device live (was "todo #21"). |
| `tests/unit/juno-x/get-state.test.ts` | modify | Replace the stub-message tests with the real-behavior tests using a fake `MidiConnection`: queries the right RQ1s, decodes responses, handles per-param timeouts, returns "not supported for section X" for unsupported sections. |
| `tests/integration/juno-x-get-state.test.ts` | new | Local-only integration test (skip in WS-mode CI): spawn JUNO-X mock, set chorus_switch/level via DT1, call MCP `get_current_state`, assert the rendered text contains the live values. |

---

## Task 1: Widen `KeyboardDevice.getState` return type

**Files:**
- Modify: `src/shared/keyboard-model.ts`

`getState` becomes async on JUNO-X (it awaits `requestRolandValue`). The interface needs to accept either sync or async returns, matching the existing `loadProgram` / `loadSong` pattern (line 191–192).

- [ ] **Step 1: Widen the signature**

In `src/shared/keyboard-model.ts`, find:

```ts
getState(section?: string): ToolResult;
```

Replace with:

```ts
getState(section?: string): ToolResult | Promise<ToolResult>;
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: clean. The tool handler in `src/tools/get-state.ts` already returns `kdev.getState(section)` directly inside an `async` function — TypeScript flattens `Promise<ToolResult>` correctly without code changes.

- [ ] **Step 3: Commit**

```bash
git add src/shared/keyboard-model.ts
git commit -m "refactor(KeyboardDevice): widen getState return to allow Promise (todo #23)"
```

---

## Task 2: JUNO-X `getState` — single-section RQ1 read

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/device.ts`
- Test: `tests/unit/juno-x/get-state.test.ts`

Replace the stub with a real implementation that reads all params in the requested section via parallel `requestRolandValue` calls, then renders the result.

- [ ] **Step 1: Rewrite the `get-state.test.ts` to assert the new behavior**

Replace the file contents:

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import junoModel from "../../../src/keyboard_models/roland/juno_x/index.js";
import type { MidiConnection } from "../../../src/shared/midi-connection.js";
import { buildDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };
const SCENE_BASE = [0x01, 0x00, 0x00, 0x00];
const DEVICE_ID = 0x10;

interface FakeConn extends MidiConnection {
  /** Fire a sysex into all currently-registered listeners. */
  _fireSysEx(bytes: number[]): void;
  /** Every sysex this connection has been asked to send (in order). */
  readonly _sent: number[][];
}

function makeFakeConn(): FakeConn {
  const listeners: Array<(bytes: number[]) => void> = [];
  const sent: number[][] = [];
  return {
    sendCC() {}, sendProgramChange() {}, sendNRPN() {},
    async sendCCBatch() {}, onCC() {},
    sendSysEx(bytes: number[]) { sent.push([...bytes]); },
    onSysEx(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    _fireSysEx(bytes: number[]) { for (const cb of [...listeners]) cb([...bytes]); },
    get _sent() { return sent; },
  } as FakeConn;
}

/** Wire a fake connection into a freshly-created JUNO-X device. */
function attachFake(device: ReturnType<typeof junoModel.createDevice & ((arg?: never) => never)>, conn: FakeConn) {
  // attach() is the only public entry-point the device exposes for binding a connection.
  device.attach(conn);
}

describe("JUNO-X get_current_state via RQ1", () => {
  it("returns 'not supported for this section' for unsupported sections", async () => {
    const device = junoModel.createDevice!();
    const conn = makeFakeConn();
    attachFake(device as any, conn);

    const result = await Promise.resolve(device.getState("scene-modify"));
    assert.match(result.content[0].text, /not (yet )?supported.*scene-modify/i);
  });

  it("issues an RQ1 per scene-chorus param and decodes the responses", async () => {
    const device = junoModel.createDevice!();
    const conn = makeFakeConn();
    attachFake(device as any, conn);

    // The scene-chorus section has 3 params: chorus_type @ 01:50:00:01,
    // chorus_switch @ 01:50:00:00, chorus_level @ 01:50:00:02.
    // Fire DT1 responses in any order — the helper correlates by address.
    setTimeout(() => {
      const switchAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
      const typeAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x01]);
      const levelAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x02]);
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, switchAddr, [0x01]));
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, typeAddr, [0x09]));
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, levelAddr, [0x40]));
    }, 5);

    const result = await Promise.resolve(device.getState("scene-chorus"));
    const text = result.content[0].text;
    assert.match(text, /Chorus Switch.*ON/i);
    assert.match(text, /Chorus Type.*JUNO Chorus/);
    assert.match(text, /Chorus Level.*64/);

    // Sanity: three RQ1s went out — one per param.
    assert.equal(conn._sent.length, 3, `expected 3 RQ1s, got ${conn._sent.length}`);
  });

  it("surfaces a per-param timeout without blocking the rest of the section", async () => {
    const device = junoModel.createDevice!();
    const conn = makeFakeConn();
    attachFake(device as any, conn);

    // Fire only chorus_switch — the other two will time out.
    setTimeout(() => {
      const switchAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, switchAddr, [0x01]));
    }, 5);

    const result = await Promise.resolve(device.getState("scene-chorus"));
    const text = result.content[0].text;
    assert.match(text, /Chorus Switch.*ON/i, "the responsive param resolves");
    assert.match(text, /timeout/i, "non-responsive params surface a timeout in the result text");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx tsx --test tests/unit/juno-x/get-state.test.ts 2>&1 | tail -10
```

Expected: FAIL — current implementation is the stub, returning "not yet implemented".

- [ ] **Step 3: Replace the stub in `JunoXDevice.getState`**

In `src/keyboard_models/roland/juno_x/device.ts`, find the imports and add what we need:

```ts
import { addAddresses, requestRolandValue } from "../../../shared/roland-dt1.js";
```

(`addAddresses` may already be imported — check first; only add `requestRolandValue`.)

Find:

```ts
override getState(_section?: string): ToolResult {
  return textResult(
    "JUNO-X get_current_state via Roland RQ1 is not yet implemented (planned in todo #21). " +
    "The agent owns its memory of what it set in the meantime.",
  );
}
```

Replace with:

```ts
/** Sections that #23 wired to live RQ1 reads. Other sections return a
 *  "not yet supported" tool result. */
private static readonly RQ1_SUPPORTED_SECTIONS: readonly string[] = [
  "scene-chorus", "scene-delay", "scene-reverb", "scene-drive",
];

override async getState(section?: string): Promise<ToolResult> {
  const conn = this.requireConnection();

  // Determine which sections to read.
  const supported = JunoXDevice.RQ1_SUPPORTED_SECTIONS;
  let sectionsToRead: string[];
  if (section === undefined) {
    sectionsToRead = [...supported];
  } else if (supported.includes(section)) {
    sectionsToRead = [section];
  } else {
    return textResult(
      `JUNO-X get_current_state is not yet supported for section "${section}". ` +
      `Currently supported: ${supported.join(", ")}. ` +
      `Other sections (scene-common, scene-part, scene-modify, partials, etc.) ` +
      `are tracked as follow-ups beyond this PR.`,
    );
  }

  // Look up every param in the requested sections that has a sysexAddress.
  // Drop params without an address — they can't be RQ1'd.
  const paramsToRead: Array<{ key: string; param: KeyboardParameter }> = [];
  for (const [key, param] of Object.entries(this.parameterMap.params)) {
    if (!sectionsToRead.includes(param.section)) continue;
    if (!param.sysexAddress) continue;
    paramsToRead.push({ key, param });
  }

  // Fire one RQ1 per param in parallel. Per-param timeouts surface in
  // the result text but don't fail the whole call.
  const PER_PARAM_TIMEOUT_MS = 500;
  const results = await Promise.all(paramsToRead.map(async ({ key, param }) => {
    const fullAddr = addAddresses(SCENE_BASE, param.sysexAddress!);
    try {
      const data = await requestRolandValue(
        conn, JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddr,
        param.sysexSize ?? 1, PER_PARAM_TIMEOUT_MS,
      );
      const value = data[0] ?? 0;
      const display = this.parameterMap.formatValue(param, value);
      return { key, line: `  ${param.name}: ${display}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { key, line: `  ${param.name}: ${/timeout/i.test(msg) ? "timeout" : `error (${msg})`}` };
    }
  }));

  if (results.length === 0) {
    return textResult(`No SysEx-addressed parameters in section "${section ?? "(all)"}".`);
  }

  // Group by section for readable output.
  const bySection = new Map<string, string[]>();
  for (const { key, line } of results) {
    const sec = this.parameterMap.params[key]!.section;
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec)!.push(line);
  }

  const lines: string[] = ["Current state (live from device):"];
  for (const sec of sectionsToRead) {
    const sectionLines = bySection.get(sec);
    if (!sectionLines) continue;
    lines.push("");
    lines.push(`## ${sec}`);
    lines.push(...sectionLines);
  }

  return textResult(lines.join("\n"));
}
```

You will also need to add the `JUNO_X_DEVICE_ID` constant import. Check whether it's already imported in this file (#21 introduced it). If not, add it to the existing engine-types import line.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsx --test tests/unit/juno-x/get-state.test.ts 2>&1 | tail -10
```

Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/roland/juno_x/device.ts tests/unit/juno-x/get-state.test.ts
git commit -m "feat(juno-x): get_current_state via Roland RQ1 (todo #23)"
```

---

## Task 3: Integration test — RQ1 round-trip via MCP

**Files:**
- Test: `tests/integration/juno-x-get-state.test.ts` (new)

End-to-end: spawn JUNO-X mock locally, set known scene-effect values via `set_parameters` (which sends DT1 to the mock), then call `get_current_state` and assert the rendered text contains the live values.

- [ ] **Step 1: Write the test**

Create `tests/integration/juno-x-get-state.test.ts`:

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

const IS_DOCKER_WS_MODE = !!process.env.MOCK_WS_URL;

describe("JUNO-X get_current_state — live RQ1 read", { concurrency: 1, skip: IS_DOCKER_WS_MODE }, () => {
  it("returns the live values for scene-chorus after a set_parameters", async () => {
    const h = await TestHarness.start({ model: "roland-juno-x", wsPort: 5700 });
    try {
      const conn = await h.callTool("connect_to_keyboard", {
        port: "Roland JUNO-X Mock",
        model: "roland-juno-x",
      });
      assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);

      // Set chorus_switch=ON, chorus_type=JUNO Chorus, chorus_level=80.
      const set = await h.callTool("set_parameters", {
        parameters: [
          { name: "chorus_switch", value: 1 },
          { name: "chorus_type", value: 9 },
          { name: "chorus_level", value: 80 },
        ],
      });
      assert.ok(!set.isError, `set_parameters failed: ${set.content[0].text}`);

      // Now read live via RQ1.
      const state = await h.callTool("get_current_state", { section: "scene-chorus" });
      assert.ok(!state.isError, `get_current_state failed: ${state.content[0].text}`);
      const text = state.content[0].text;
      assert.match(text, /Chorus Switch.*ON/i, `expected Chorus Switch ON in: ${text}`);
      assert.match(text, /Chorus Type.*JUNO Chorus/, `expected Chorus Type JUNO Chorus in: ${text}`);
      assert.match(text, /Chorus Level.*80/, `expected Chorus Level 80 in: ${text}`);
    } finally {
      await h.stop();
    }
  });

  it("returns 'not yet supported' for an unsupported section", async () => {
    const h = await TestHarness.start({ model: "roland-juno-x", wsPort: 5701 });
    try {
      const conn = await h.callTool("connect_to_keyboard", {
        port: "Roland JUNO-X Mock",
        model: "roland-juno-x",
      });
      assert.ok(!conn.isError);

      const state = await h.callTool("get_current_state", { section: "scene-modify" });
      assert.match(state.content[0].text, /not yet supported.*scene-modify/i);
    } finally {
      await h.stop();
    }
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
npx tsx --test tests/integration/juno-x-get-state.test.ts 2>&1 | tail -10
```

Expected: PASS — both cases.

If the first test fails because the mock doesn't have time to register / DT1 hasn't propagated, add a small `await new Promise(r => setTimeout(r, 100))` after `connect_to_keyboard` and before `set_parameters`, mirroring the pattern in other integration tests. Don't add a sleep before the `get_current_state` call — `requestRolandValue` already awaits the matching response.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/juno-x-get-state.test.ts
git commit -m "test(integration): JUNO-X get_current_state live RQ1 round-trip (todo #23)"
```

---

## Task 4: Update JUNO-X `agentSystemPrompt` and CLAUDE.md

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/index.ts`
- Modify: `CLAUDE.md`

Both currently say "RQ1 query path is not yet implemented." After this PR, it works.

- [ ] **Step 1: Update JUNO-X `agentSystemPrompt`**

In `src/keyboard_models/roland/juno_x/index.ts`, find the `STATE & MEMORY:` block. Replace:

```
The MCP is stateless on parameter values — it does not shadow what was sent. The JUNO-X is queryable in principle via Roland Data Request 1 (RQ1) sysex, but \`get_current_state\` is NOT yet implemented (planned in todo #21) — calling it today returns a stub message. Until then, you own the memory of what you sent across turns; the device itself is the ground truth — when in doubt, set the parameter explicitly rather than assuming it carried over.
```

with:

```
The MCP is stateless on parameter values — it does not shadow what was sent. The JUNO-X is queryable via Roland Data Request 1 (RQ1) sysex: \`get_current_state\` issues live RQ1s and renders the device's actual values. Currently supports the scene-effect sections — \`scene-chorus\`, \`scene-delay\`, \`scene-reverb\`, \`scene-drive\`. Other sections (scene-common, scene-part, scene-modify, partials, etc.) return a "not yet supported" message; those are explicit follow-ups. Treat the response as ground truth for "what is on the device right now" — including changes you didn't make (front-panel knob turns, scene loads). Use \`get_current_state\` to verify, not to remember; you still own intent across turns.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In `keyboards-mcp/CLAUDE.md`, find the Architecture section text:

```
JUNO-X uses Roland RQ1 to query the device live (currently scoped to scene-effects sections — see `docs/plans/completed/21-juno-x-rq1-get-state.md`).
```

(Or whichever wording is current — the PR #65 commit added something like this.)

Replace with:

```
JUNO-X uses Roland RQ1 to query the device live; `get_current_state` returns actual device values for scene-effect sections (`scene-chorus`, `scene-delay`, `scene-reverb`, `scene-drive`). See `docs/plans/completed/21-juno-x-rq1-get-state.md`, `22-mcp-sysex-receive.md`, and `23-juno-x-get-state-rq1.md` for the layered implementation across mock RQ1 protocol, MCP-side receive, and the live query.
```

- [ ] **Step 3: Verify build**

```bash
npm run build && npm run lint
```

Expected: clean (template-literal escaping in `agentSystemPrompt` is the main risk).

- [ ] **Step 4: Commit**

```bash
git add src/keyboard_models/roland/juno_x/index.ts CLAUDE.md
git commit -m "docs: JUNO-X RQ1 get_current_state is live (todo #23)"
```

---

## Task 5: Final sweep + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full local pyramid**

```bash
npm run lint
npm run test:check
npm run test:unit
npm run test:integration
npm run test:e2e:mcb
```

Expected: all green.

- [ ] **Step 2: Move plan to completed, strike #23 from todo-list**

```bash
mv docs/plans/pending/23-juno-x-get-state-rq1.md docs/plans/completed/
git add docs/plans/completed/23-juno-x-get-state-rq1.md
```

Edit `docs/plans/pending/todo-list.md` and delete the entire `### 23. JUNO-X get_current_state via Roland RQ1` block. Leave `### 24.` and `### 25.`.

```bash
git add docs/plans/pending/todo-list.md
git commit -m "docs(plans): #23 complete — JUNO-X get_current_state via RQ1"
```

- [ ] **Step 3: Push + create PR**

```bash
git push -u origin feat/plan-23/juno-x-get-state
gh pr create --title "feat(juno-x): get_current_state via live Roland RQ1 query (#23)" --body "$(cat <<'EOF'
## Summary

Replaces the JUNO-X \`get_current_state\` stub (added in PR #65) with a real RQ1-based query, completing the layered RQ1 implementation: #21 (mock protocol) + #22 (MCP-side receive) + this PR (JUNO-X consumer).

## What's new

- \`JunoXDevice.getState\` issues parallel RQ1s for every SysEx-addressed param in the requested section, awaits matching DT1 responses via \`requestRolandValue\`, and renders the live values.
- Per-param timeouts surface in the result text without blocking the rest.
- Unsupported sections return a clear "not yet supported" message with the supported list.
- JUNO-X \`agentSystemPrompt\` and \`CLAUDE.md\` updated to reflect that RQ1 actually works.

## Scope

Scene-effect sections only: \`scene-chorus\` (3 params), \`scene-delay\` (2), \`scene-reverb\` (2), \`scene-drive\` (1). No-section calls read all four. Other sections (scene-common, scene-part, scene-modify, partials, etc.) are explicit follow-ups beyond this PR.

## Test plan

- [x] \`npm run lint\`
- [x] \`npm run test:check\`
- [x] \`npm run test:unit\` — includes new JUNO-X getState tests with a fake MidiConnection (single-section read, unsupported section, per-param timeout).
- [x] \`npm run test:integration\` — includes new \`juno-x-get-state.test.ts\` (skipped in WS-mode CI).
- [x] \`npm run test:e2e:mcb\`
- [ ] CI

## Plan

\`docs/plans/completed/23-juno-x-get-state-rq1.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Monitor CI + Copilot review**

Use `superpowers:finishing-a-development-branch` to handle CI failures and Copilot comments. Coverage gate is pre-existing red on `main`.

---

## Self-Review

**Spec coverage** (against the goal: replace the JUNO-X getState stub with live RQ1):

| Goal element | Task |
|---|---|
| Widen `getState` to allow async return | Task 1 |
| Replace stub with RQ1 query for scene-effect sections | Task 2 |
| Decode DT1 responses + render | Task 2 |
| Per-param timeout, malformed handling | Task 2 (per-param try/catch surfaces in result text) |
| Unsupported-section message | Task 2 |
| Integration test (real-MIDI mock round-trip) | Task 3 |
| `agentSystemPrompt` + `CLAUDE.md` updates | Task 4 |
| Strike #23 from todo, move plan | Task 5 |

**Placeholder scan:** every step shows the actual code or command. No "TBD" markers.

**Type consistency:**
- `requestRolandValue` signature matches what #22 landed: `(conn, modelId, deviceId, address, size, timeoutMs) => Promise<number[]>`.
- `JUNO_X_MODEL_ID`, `JUNO_X_DEVICE_ID`, `SCENE_BASE` are existing exports from `engines/engine-types.js` — used the same way in #21's mock-handler RQ1 path.
- `parameterMap.formatValue` is the same helper used by `setParameters` to translate raw bytes to display values.

**Pre-flight verification:**
- `requestRolandValue` lives in `src/shared/roland-dt1.ts` (landed in #22) — confirmed.
- `KeyboardParameter.sysexAddress` and `sysexSize` are already typed in `src/shared/types.ts`.
- All 8 scene-effect params have `sysexAddress` set (chorus_type/switch/level, delay_switch/level, reverb_switch/level, drive_switch — verified by grep against scene-params.ts).
