# MCB → MCP Integration (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing MCP server to consume MCB-managed leases for connection establishment. The MCP keeps its existing internal machinery (`MidiManager`, `StateManager`, `KeyboardDevice`, validation, all per-tool state). Only the **connection-establishment path** changes: `connect_to_keyboard` claims a lease via MCB before opening MIDI/WS, and `MidiManager` reads the WS port from the manifest instead of guessing. The original mock-UI WS bug fix lands in this PR.

**Architecture:** New `src/mcp-client/mcb-client.ts` module wraps HTTP-over-UDS calls to MCB. `connect_to_keyboard` drops `forward_port` / `auto_forward` / `auto_input` / `mock_ws_port`; adds `with_shadow`; requires `model`. `MidiManager.connect()` and `connectForward()` take an explicit `wsPort` parameter. Other tools (`set_parameters`, `get_current_state`, etc.) and other MCP code paths are untouched.

**Tech Stack:** Existing — TypeScript, node:test, Zod schemas, MCP SDK. No new deps.

**Source backlog item:** Phase 2 entry in `docs/superpowers/specs/2026-05-05-midi-connections-broker-backlog.md`.

---

## Pragmatic deviations from the backlog

The backlog Phase 2 description is broad. Trims for this MVP cut, **deferred to follow-ups**:

- **Session attach (`POST /v1/sessions/:id/attach`)** — MCB MVP doesn't implement attach yet. We just create a fresh session per MCP startup; if the MCP restarts, it gets a new session id. Reattach is a separate item.
- **`is_connected` and `list_midi_devices` reading from MCB** — they keep using MCP-internal state today. MCB cross-session visibility is a follow-up. The MCP's own pool is still the source of truth for devices the local agent has connected.
- **`auto_input` removal** — kept. The arg was about pairing input/output MIDI ports inside MCP; not related to the MCB integration. Dropping it later if it becomes a real maintenance burden.
- **WS transport mode (`MOCK_WS_URL`)** — preserved. The CI docker-compose path doesn't use MCB; it short-circuits to `WsMidiConnection`. Phase 2 leaves this branch alone.

What **is** in scope:
- Drop `forward_port` / `auto_forward` / `mock_ws_port` from `connect_to_keyboard`.
- Add `with_shadow`. Require `model`.
- Lease claim/release through MCB on connect/disconnect.
- `MidiManager` gets explicit `wsPort` parameters.
- Remove `setMockWsPort`, `attachMockStatusWs`, the implicit `connectMockWs` from `connectForward`.
- Update existing E2E tests for the new arg surface.
- Update sibling repo's system prompt.

---

## File map

```
src/
  mcp-client/                    # NEW
    mcb-client.ts                # HTTP-over-UDS client + session caching
  midi/
    midi-manager.ts              # MODIFY — wsPort becomes explicit parameter
  tools/
    connect.ts                   # REWRITE — claim lease via MCB, drop legacy args
    disconnect.ts                # MODIFY — release lease via MCB
tests/
  e2e/
    connect.test.ts              # MODIFY — new arg surface
    set-parameters.test.ts       # MODIFY — new arg surface
    multi-model.test.ts          # MODIFY — new arg surface
../sound-recreation-agent/       # SIBLING REPO
  src/system-prompt.ts (or wherever)  # MODIFY — describe new connect args
```

`src/shared/mock-registry.ts`, `src/midi/ws-midi-connection.ts`, model implementations, `src/index.ts`, all other tools — **unchanged**.

---

## Operational requirement

After this lands, MCB must be running for `connect_to_keyboard` to succeed (in non-WS-transport mode). The MCP fails fast with a clear error if MCB is unreachable. CI's WS-transport mode (`MOCK_WS_URL` set) bypasses MCB and stays unchanged.

---

## Task 1: MCB client module

**Files:**
- Create: `src/mcp-client/mcb-client.ts`
- Create: `tests/unit/mcp-client/mcb-client.test.ts`

- [ ] **Step 1: Implement `src/mcp-client/mcb-client.ts`**

```ts
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Manifest {
  deviceId: string;
  ownerSessionId: string;
  model: string;
  primary: { portName: string; wsPort: number | null };
  input?: { portName: string };
  shadow?: { portName: string; wsPort: number | null };
  label: string;
  channel: number;
  lowerChannel?: number;
  upperChannel?: number;
}

export interface ClaimRequest {
  port: string;
  model: string;
  with_shadow?: string;
  input_port?: string;
  label?: string;
  channel?: number;
  lower_channel?: number;
  upper_channel?: number;
}

export class MCBError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const SOCKET_PATH = process.env.MCB_SOCKET ?? join(homedir(), ".mcb", "sock");

let cachedSessionId: string | null = null;

async function ensureSession(): Promise<string> {
  if (cachedSessionId) return cachedSessionId;
  const body = await call("POST", "/v1/sessions", { pid: process.pid, processName: "keyboards-mcp" });
  cachedSessionId = (body as { sessionId: string }).sessionId;
  return cachedSessionId;
}

export async function claimLease(req: ClaimRequest): Promise<Manifest> {
  const sessionId = await ensureSession();
  return await call("POST", "/v1/devices", req, { "x-session-id": sessionId }) as Manifest;
}

export async function releaseLease(deviceId: string): Promise<void> {
  if (!cachedSessionId) return; // no session → no leases
  await call("DELETE", `/v1/devices/${deviceId}`, undefined, { "x-session-id": cachedSessionId });
}

/** Reset the cached session — used on fatal errors so the next call re-bootstraps. */
export function resetSession(): void { cachedSessionId = null; }

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: SOCKET_PATH, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 204) { resolve(undefined); return; }
          const text = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          if (res.statusCode! >= 400) {
            const err = parsed as { error?: string; message?: string; details?: unknown };
            reject(new MCBError(res.statusCode!, err?.error ?? "unknown", err?.message ?? `MCB ${method} ${path} failed: ${res.statusCode}`, err?.details));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", (err) => reject(new MCBError(0, "mcb-unreachable", `MCB unreachable at ${SOCKET_PATH}: ${err.message}. Is MCB running? (npm run mcb)`)));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
```

- [ ] **Step 2: Write a basic test**

Create `tests/unit/mcp-client/mcb-client.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../../../src/mcb/http/server.js";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";
import { SessionManager } from "../../../src/mcb/session-manager.js";

let server: StartedServer;
let socketDir: string;
let socketPath: string;
let prevSocket: string | undefined;

beforeEach(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "mcp-mcb-"));
  socketPath = join(socketDir, "sock");
  prevSocket = process.env.MCB_SOCKET;
  process.env.MCB_SOCKET = socketPath;
  // The mcb-client reads the env var at module top-level — re-import via cache invalidation:
  // for this test we clear the module cache via a fresh dynamic import.
  server = await startServer({
    socketPath,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager(),
    portList: { listOutputs: () => ["Port A"], listInputs: () => [] },
    mockRegistry: { findByLabel: () => undefined, findByMidiPort: () => undefined, list: () => [] },
  });
});

afterEach(async () => {
  await server.stop();
  rmSync(socketDir, { recursive: true, force: true });
  if (prevSocket === undefined) delete process.env.MCB_SOCKET; else process.env.MCB_SOCKET = prevSocket;
});

describe("mcb-client", () => {
  it("claims and releases a lease end-to-end", async () => {
    // Re-import to pick up the MCB_SOCKET env var.
    const { claimLease, releaseLease, resetSession } = await import(`../../../src/mcp-client/mcb-client.js?t=${Date.now()}`);
    resetSession();
    const manifest = await claimLease({ port: "Port A", model: "test-model" });
    assert.equal(manifest.primary.portName, "Port A");
    assert.match(manifest.deviceId, /^[a-f0-9-]{36}$/i);
    await releaseLease(manifest.deviceId);
  });
});
```

> Note: the cache-busting dynamic import (`?t=${Date.now()}`) is needed because `cachedSessionId` is module-scoped. If `tsx` doesn't honor query strings, switch to `resetSession()` + ensure tests don't share state. The cleaner alternative is to refactor `mcb-client.ts` to expose a class — defer if tests pass.

- [ ] **Step 3: Run the test**

Run: `npx tsx --test tests/unit/mcp-client/mcb-client.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-client/mcb-client.ts tests/unit/mcp-client/mcb-client.test.ts
git commit -m "feat(mcp): MCB HTTP/UDS client with session caching"
```

---

## Task 2: MidiManager — explicit wsPort parameter

**Files:**
- Modify: `src/midi/midi-manager.ts`

- [ ] **Step 1: Read the current `connect()` and `connectForward()` signatures and the `connectMockWs` / `setMockWsPort` / `attachMockStatusWs` machinery**

Run: `grep -n "connect\|mockWs\|attachMockStatusWs\|setMockWsPort\|connectMockWs" src/midi/midi-manager.ts`

Note the current shape so the changes are surgical.

- [ ] **Step 2: Update `MidiManager` API**

The change in concept:
- Today: `connect(portName)` and `connectForward(portName)` — both internally consult `this.mockWsPort` (set via `setMockWsPort` or `MOCK_WS_PORT` env) and try to open a status WS. Buggy because the WS port isn't reliably knowable without the mock registry.
- Tomorrow: `connect(portName, wsPort: number | null)` and `connectForward(portName, wsPort: number | null)` — the caller (MCB-aware) hands in the wsPort it received from the lease manifest. WS opens iff wsPort is non-null. No env fallback.

Concretely:
- Add `wsPort: number | null` parameter to both `connect` and `connectForward`.
- Inside both, if `wsPort != null`, open the status WS using exactly that port. Otherwise, no WS.
- Delete `setMockWsPort` (the field stays only if internally needed — likely can also be removed).
- Delete `attachMockStatusWs` if it's no longer called from anywhere.
- The `connectMockWs` private helper can stay as-is or be inlined; just have it take an explicit port arg now.

Sketch (final shape — adjust to current code):

```ts
connect(portNameOrIndex: string | number, wsPort: number | null): { success: boolean; portName: string } {
  // ...existing port resolution...
  this.output = new midi.Output(targetPort.name);
  this.connectedPortName = targetPort.name;
  if (wsPort !== null) this.connectMockWs(wsPort);
  return { success: true, portName: targetPort.name };
}

connectForward(portNameOrIndex: string | number, wsPort: number | null): { success: boolean; portName: string } {
  // ...existing forward port resolution...
  this.forwardOutput = new midi.Output(targetPort.name);
  this.connectedForwardPortName = targetPort.name;
  if (wsPort !== null) this.connectMockWs(wsPort);  // status WS belongs to the mock the MCP is talking to
  return { success: true, portName: targetPort.name };
}

private connectMockWs(wsPort: number): void {
  this.disconnectMockWs();
  // ...existing WS-open logic, but using `wsPort` directly instead of this.mockWsPort fallback...
}
```

Drop `setMockWsPort`, drop `attachMockStatusWs`, drop the `mockWsPort` field. Also drop `MOCK_WS_PORT` env-var fallback inside `connectMockWs`.

- [ ] **Step 3: Verify the type-check still passes**

Run: `npm run test:check`

This will fail at every callsite of `connect`/`connectForward` — which is the next task. Don't fix yet; just confirm the failures are at the expected callsites (`src/tools/connect.ts`, possibly tests).

- [ ] **Step 4: Commit (intentionally with broken callers — fixed in next task)**

```bash
git add src/midi/midi-manager.ts
git commit -m "refactor(midi): MidiManager.connect/connectForward take explicit wsPort"
```

---

## Task 3: Refactor `connect_to_keyboard`

**Files:**
- Rewrite: `src/tools/connect.ts`

- [ ] **Step 1: Strip the implicit-resolution machinery and add MCB lease claim**

Replace the body of `connect_to_keyboard` (the non-WS-transport path) with:

1. Read new args from Zod: `port: string`, `model: string`, `with_shadow?: string`, `input_port?: string`, `label?: string`, `channel?: number`, `lower_channel?: number`, `upper_channel?: number`.
2. **Drop**: `forward_port`, `auto_forward`, `mock_ws_port`. **Keep**: `auto_input` for now (note in plan as deferred).
3. Branch: if `MOCK_WS_URL` is set → existing WS-transport path (unchanged).
4. Else: call `claimLease({ port, model, with_shadow, input_port, label, channel, lower_channel, upper_channel })` from `mcb-client`.
5. Use the returned `Manifest` to drive `MidiManager`:
   - `midi.connect(manifest.primary.portName, manifest.primary.wsPort)`
   - If `manifest.shadow`: `midi.connectForward(manifest.shadow.portName, manifest.shadow.wsPort)`
   - If `manifest.input`: `midi.connectInput(manifest.input.portName)` (existing, unchanged)
6. `device.attach(midi)`. Add to pool.
7. Stash `manifest.deviceId` somewhere `disconnect` can read it (extend the pool entry's metadata, or attach onto the device instance — see plan in Task 4).
8. Return success message including the manifest's resolved port name and shadow if any.

Sketch of the post-refactor non-WS path:

```ts
import { claimLease, MCBError } from "../mcp-client/mcb-client.js";

// inside the handler, after the WS-transport short-circuit:
let manifest;
try {
  manifest = await claimLease({
    port: String(port),
    model,
    with_shadow,
    input_port,
    label,
    channel,
    lower_channel,
    upper_channel,
  });
} catch (err) {
  if (err instanceof MCBError) {
    return { content: [{ type: "text", text: `Connection failed: ${err.code}: ${err.message}` }], isError: true };
  }
  throw err;
}

const model = await loadModelById(manifest.model);
const device = createDeviceForModel(model, manifest.label);
const midi = new MidiManager();

midi.connect(manifest.primary.portName, manifest.primary.wsPort);
if (manifest.input) midi.connectInput(manifest.input.portName);
if (manifest.shadow) midi.connectForward(manifest.shadow.portName, manifest.shadow.wsPort);

device.attach(midi);
const index = pool.connect(device, () => { midi.disconnect(); }, {
  output: manifest.primary.portName,
  input: manifest.input?.portName,
  forward: manifest.shadow?.portName,
  // NEW — store deviceId so disconnect can release the lease:
  mcbDeviceId: manifest.deviceId,
});

return { content: [{ type: "text", text: `Connected via MCB. device ${index}: ${model.info.displayName} ${manifest.label ? `"${manifest.label}"` : ""}` }] };
```

The exact existing function signature has `port: string | number | undefined` — **change to `port: string` (required)**. No more index-based or auto-detect.

- [ ] **Step 2: Update the Zod schema to match**

Strip the deprecated args. Add `with_shadow`. Make `model` required. Make `port` required. Keep `auto_input`, `input_port`, `label`, channels.

- [ ] **Step 3: Confirm type-check now passes**

Run: `npm run test:check`

Expected: the previously-broken callsites in `connect.ts` now compile against the new MidiManager signatures.

- [ ] **Step 4: Don't run e2e yet** (those still use old args — next tasks update them).

- [ ] **Step 5: Commit**

```bash
git add src/tools/connect.ts
git commit -m "refactor(mcp): connect_to_keyboard claims lease via MCB"
```

---

## Task 4: Refactor `disconnect_from_keyboard`

**Files:**
- Modify: `src/tools/disconnect.ts`
- Modify: `src/shared/device-pool.ts` (extend metadata to carry `mcbDeviceId`)

- [ ] **Step 1: Extend the pool entry's metadata**

In `src/shared/device-pool.ts`, the connect call already takes a third arg with `output`/`input`/`forward` strings. Add an optional `mcbDeviceId?: string` to that metadata shape. Persist it on the pool entry. Expose it via the existing entry getter.

- [ ] **Step 2: Update `disconnect_from_keyboard`**

After the local `pool.disconnect(index)` call (which closes MIDI/WS), call `releaseLease(mcbDeviceId)` from `mcb-client` if `mcbDeviceId` was set. Swallow MCB errors as warnings — the local disconnect already happened, and MCB will GC the lease eventually anyway.

```ts
import { releaseLease, MCBError } from "../mcp-client/mcb-client.js";

// inside handler, after pool.disconnect(...)
const mcbDeviceId = entry?.metadata?.mcbDeviceId;
if (mcbDeviceId) {
  try {
    await releaseLease(mcbDeviceId);
  } catch (err) {
    if (err instanceof MCBError) {
      console.warn(`[mcp] MCB release failed (non-fatal): ${err.code}: ${err.message}`);
    } else {
      throw err;
    }
  }
}
```

- [ ] **Step 3: Type-check + lint**

Run: `npm run test:check && npm run lint`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/tools/disconnect.ts src/shared/device-pool.ts
git commit -m "refactor(mcp): disconnect_from_keyboard releases lease via MCB"
```

---

## Task 5: Update existing E2E tests for the new arg surface

**Files:**
- Modify: `tests/e2e/connect.test.ts`
- Modify: `tests/e2e/set-parameters.test.ts`
- Modify: `tests/e2e/multi-model.test.ts`

These tests today use `forward_port` / `auto_forward` / `mock_ws_port` / no `model`. Each needs:
- Replace `forward_port: "..."` with `with_shadow: "..."` (mock label or exact port name).
- Drop `auto_forward`, `mock_ws_port`.
- Add `model: "<model-id>"` to every connect call.
- Test setup must run MCB. Either:
  - **Option A (recommended for MVP):** spawn MCB as a child process in a global e2e test fixture (similar to the MCB integration smoke test) — one MCB instance for the e2e suite. Shared socket path under `os.tmpdir()`.
  - **Option B:** rely on MCB running externally. Brittle for CI.

Choose **Option A**. Add a small helper `tests/helpers/mcb-fixture.ts` with `spawnMcbForTests()` and `stopMcb()` callable from `before()` / `after()` hooks per e2e file. (Or a global fixture if test runner supports it — node:test does.)

- [ ] **Step 1: Create the e2e MCB fixture helper**

`tests/helpers/mcb-fixture.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

let proc: ChildProcess | undefined;
let dir: string | undefined;

export async function spawnMcbForTests(): Promise<{ socketPath: string }> {
  if (proc) throw new Error("MCB fixture already running");
  dir = mkdtempSync(join(tmpdir(), "mcp-e2e-mcb-"));
  const socketPath = join(dir, "sock");
  proc = spawn("npx", ["tsx", "src/mcb/index.ts"], {
    env: { ...process.env, MCB_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.env.MCB_SOCKET = socketPath;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath) && (await ping(socketPath))) return { socketPath };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("MCB fixture failed to start");
}

export async function stopMcb(): Promise<void> {
  if (!proc) return;
  proc.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((r) => proc!.once("exit", () => r())),
    new Promise<void>((r) => setTimeout(r, 2000)),
  ]);
  proc.kill("SIGKILL");
  proc = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
}

function ping(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath, method: "GET", path: "/v1/health", timeout: 200 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
```

- [ ] **Step 2: Wire up the fixture in each e2e test**

Add to the top of each e2e file:

```ts
import { before, after } from "node:test";
import { spawnMcbForTests, stopMcb } from "../helpers/mcb-fixture.js";

before(async () => { await spawnMcbForTests(); });
after(async () => { await stopMcb(); });
```

Note: `MOCK_WS_URL` short-circuits MCB. If a given e2e file uses WS-transport mode (`MOCK_WS_URL` set), no MCB is needed. Skip the fixture in those cases.

- [ ] **Step 3: Update each test's `connect_to_keyboard` calls**

For every place that calls the connect tool:
- Replace `forward_port: "Nord ... Mock"` with `with_shadow: "<mock-label-or-port>"`.
- Drop `auto_forward`, `mock_ws_port`.
- Add `model: "<model-id>"`.

Specifically (current names → new):
- `nord-electro-5d` (Nord)
- `roland/juno-x` (check existing model id)
- `prophet-6`

Use the model-registry's exported model-id strings; don't hardcode mismatched names.

- [ ] **Step 4: Run e2e tests**

Run: `npm run test:e2e`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/mcb-fixture.ts tests/e2e/
git commit -m "test(e2e): use new connect args + spawn MCB fixture"
```

---

## Task 6: Update sibling repo's system prompt

**Files:**
- Modify: `../sound-recreation-agent/<system-prompt-file>` (path TBD — grep for the description of `connect_to_keyboard` in that repo)

- [ ] **Step 1: Find the prompt file**

Run: `grep -rln "forward_port\|auto_forward\|mock_ws_port" ../sound-recreation-agent/src/`

That's the file (or files) describing the connect tool.

- [ ] **Step 2: Update wording**

Edit so the prompt:
- Removes mentions of `forward_port` / `auto_forward` / `mock_ws_port`.
- Adds `with_shadow: <mock label or OS port>` with a short description.
- Mentions that `model` is now required and lists known model ids.
- Notes that MCB must be running (`npm run mcb`) before connect_to_keyboard works.

- [ ] **Step 3: Commit in the sibling repo**

```bash
cd ../sound-recreation-agent
git checkout -b spec/mcb-tool-surface
git add <file>
git commit -m "docs(prompt): update connect tool args for MCB integration"
```

> Per the saved memory "Stay within repo boundaries", this commit happens in the sibling repo. Don't `git add` it from the keyboards-mcp repo.

- [ ] **Step 4: PR the sibling repo separately**

Run: `git push -u origin spec/mcb-tool-surface && gh pr create ...`

(Skip this step if you'd rather wait for keyboards-mcp PR to land first, then make sibling PR — sequencing is up to the user.)

- [ ] **Step 5: Return to keyboards-mcp repo**

```bash
cd ../keyboards-mcp
```

---

## Task 7: Final sweep + manual smoke

**Files:** none

- [ ] **Step 1: Run all tests in keyboards-mcp**

Run: `npm test`

Expected: all green. If e2e fails because of timing (MCB cold start), bump the fixture's deadline.

- [ ] **Step 2: Lint**

Run: `npm run lint` — clean.

- [ ] **Step 3: Build**

Run: `npm run build` — clean.

- [ ] **Step 4: Manual smoke (synced-pair via MCB)**

Steps:
1. `rm -f ~/.mcb/sock; npm run mcb` (in one terminal).
2. `npm run mock:runner` (start a Nord mock with label `nordi`).
3. In Claude Code, reload the MCP (`/mcp`).
4. Call `connect_to_keyboard` with: `port="Nord Electro 5 MIDI Input"`, `with_shadow="nordi"`, `model="nord-electro-5d"`, `input_port="Nord Electro 5 MIDI Output"`.
5. Verify the mock-runner UI shows "MCP CONNECTED".
6. Run `set_parameters` with a drawbar value; verify it lands on both the real Nord and the nordi mock UI.
7. `disconnect_from_keyboard`. Verify MCB's lease is released (`curl --unix-socket ~/.mcb/sock http://localhost/v1/devices` returns `[]`).

Document any deviations as backlog items; don't try to fix here.

- [ ] **Step 5: Final commit (only if anything got touched)**

```bash
git add -p
git commit -m "fix(mcp): final-sweep cleanups"
```

---

## Self-review notes

- **Spec coverage**: every Phase 2 backlog bullet that survived the user's "MVP, not full plan" trim has a task. Trimmed (deferred): `is_connected`/`list_midi_devices` reading from MCB, session attach, `auto_input` removal — all explicitly called out in the deviations section.
- **MCB-not-running failure mode**: surfaces as a clear MCBError → user-facing tool error. Acceptable for MVP. Auto-spawn / lockfile-gate is a follow-up.
- **Sibling repo PR**: separate from the keyboards-mcp PR. Land them in the order that minimizes broken-state — typically keyboards-mcp first, then sibling repo's prompt update.
- **WS-transport (CI) path**: deliberately untouched so CI keeps passing. MCB integration only affects the real-MIDI path.
- **Backlog items implicitly created**:
  - "MCP auto-spawn or lockfile-gate when MCB unreachable" — recovery UX.
  - "Session attach on transient drops" — already in MCB backlog; needs MCP-side wiring once MCB ships it.
  - "MCP `is_connected` / `list_midi_devices` reading from MCB" — already in MCB backlog.
