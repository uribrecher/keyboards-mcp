# 22 — MCP-side SysEx Receive: Primary Listen + `requestRolandValue` + Bridge Cycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the MCP to receive SysEx (and incidentally, all other MIDI events) on a connected primary's MIDI-OUT port — closing the loop on the RQ1 protocol foundation laid in #21. Includes the `requestRolandValue` helper that turns "send RQ1, await matching DT1" into a single `await`-able call, and hardens the MCB bridge graph to refuse cycles that #21's bidirectional mocks make newly possible.

**Not in scope here:** End-to-end JUNO-X `get_current_state` rewrite — that's #23, which depends on this plan landing. WS-mode receive (mocks broadcasting outgoing SysEx over a second WebSocket lane) is also deferred — see #25 added at the end of this plan. This PR is real-MIDI-mode only.

**Architecture:** Three concentric layers.

1. **Transport** — `MidiManager.connectInput` already fans incoming MIDI events from the primary's MIDI-OUT to both the shadow (via `forwardOutput.send`) and the MCP (via per-type callbacks). Extending it to SysEx is a one-line addition to `messageTypes` plus a new `onSysExCallbacks` list. `MidiConnection.onSysEx` is promoted from optional to required.

2. **Protocol** — `requestRolandValue` lives next to the existing DT1/RQ1 helpers in `src/shared/roland-dt1.ts`. It builds an RQ1, sends it on a `MidiConnection`, registers a one-shot `onSysEx` listener that resolves on the first matching DT1, and times out otherwise. Pure-ish — testable with a fake `MidiConnection`.

3. **Lease + bridge graph** — #21 enabling mock-as-primary widens the bridge graph's cycle surface. `BridgeRegistry` learns about device-internal edges (lease's primary-out → input port) and treats them uniformly with explicit bridges in `wouldFormCycle`. `LeaseRegistry` registers the device edge on add. `connect_to_keyboard` auto-resolves `input_port` from the primary's port name when primary is a registered mock (mocks now expose both directions on the same name, per #21).

**Tech Stack:** TypeScript 5.5+, easymidi, `node:test` + `node:assert`. No new dependencies.

**Source:** `docs/plans/pending/todo-list.md` item #22.
**Branch:** `feat/plan-22/mcp-sysex-receive` (create from `main`).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/shared/midi-connection.ts` | modify | `onSysEx(callback)` becomes required (drop `?`). |
| `src/midi/midi-manager.ts` | modify | Add `onSysExCallbacks` list; add `"sysex"` to `connectInput`'s `messageTypes`; in the per-type handler, fire callbacks AND continue tee-ing to `forwardOutput` (existing fan-out). |
| `src/midi/ws-midi-connection.ts` | modify | Drop the optional marker on `onSysEx` to satisfy the now-required interface. Keep the no-op body for this PR. |
| `src/shared/roland-dt1.ts` | modify | Add `requestRolandValue(conn, modelId, deviceId, address, size, timeoutMs): Promise<number[]>`. Internally builds RQ1, subscribes one-shot to `onSysEx`, resolves on matching DT1, rejects on timeout, always cleans up the listener. |
| `src/mcb/bridge-registry.ts` | modify | Add `addDeviceEdge(deviceId, outPort, inPort)` and `removeDeviceEdge(deviceId)`. Extend `wouldFormCycle` to treat device edges uniformly with bridge edges. |
| `src/mcb/lease-registry.ts` | modify | When a lease has both primary and input ports, call `bridges.addDeviceEdge` on add and `bridges.removeDeviceEdge` on remove. (Lease registry now needs a reference to BridgeRegistry — pass in via constructor or method param.) |
| `src/mcb/http/devices.ts` | modify | Auto-resolve `input` from the primary's mock-registry entry when `body.input_port` is unset and primary resolves to a mock. Plumb the resolved input through `lease.input`. |
| `src/tools/connect.ts` | modify | No changes — `manifest.input` already piped through to `midi.connectInput`. The auto-resolution happens MCB-side (Task 6). |
| `tests/unit/shared/roland-dt1.test.ts` | modify | Add `requestRolandValue` tests using a fake `MidiConnection` (timeout, match, address mismatch ignored, listener cleanup). |
| `tests/unit/mcb/bridge-registry.test.ts` | modify | Add cycle-detection tests for device-edge scenarios opened up by #21 (mock-as-primary chained with shadow). |
| `tests/unit/mcb/lease-registry.test.ts` | modify | Verify `addDeviceEdge`/`removeDeviceEdge` are called when leases have both primary and input. |
| `tests/integration/mcp-sysex-receive.test.ts` | new | Local-only integration test (skip in WS-mode CI): spawn JUNO-X mock, connect MidiManager input + output to its virtual ports, send an RQ1 via `requestRolandValue`, assert the resolved DT1 carries the right bytes. |
| `docs/plans/pending/todo-list.md` | modify | Add #25 (WS-mode SysEx receive — defer for symmetry with current real-MIDI scope). Strike #22 once this plan completes. |

---

## Task 1: Promote `MidiConnection.onSysEx` to required

**Files:**
- Modify: `src/shared/midi-connection.ts`
- Modify: `src/midi/ws-midi-connection.ts`

`onSysEx` has been optional since the interface was created. Both transports already declare it; this just removes the `?`. The WS transport's body remains a no-op for now (real WS-mode receive is deferred to #25).

- [ ] **Step 1: Drop `?` on the interface**

In `src/shared/midi-connection.ts`, change:

```ts
onSysEx?(callback: (bytes: number[]) => void): void;
```

to:

```ts
onSysEx(callback: (bytes: number[]) => void): void;
```

- [ ] **Step 2: Verify `WsMidiConnection.onSysEx` no longer needs the optional marker**

In `src/midi/ws-midi-connection.ts`, check the existing method:

```ts
onSysEx(_callback: (bytes: number[]) => void): void {
  // No-op: mock doesn't send SysEx back over WS
}
```

Update the comment to reference #25:

```ts
onSysEx(_callback: (bytes: number[]) => void): void {
  // No-op in WS mode — see todo #25 for the planned mock-out WS lane.
}
```

- [ ] **Step 3: Verify build + lint**

```bash
npm run build && npm run lint
```

Expected: clean. (`MidiManager.onSysEx` already exists — Task 2 wires it up; no compile error from the interface change.)

- [ ] **Step 4: Commit**

```bash
git add src/shared/midi-connection.ts src/midi/ws-midi-connection.ts
git commit -m "refactor(midi): promote onSysEx to required (todo #22)"
```

---

## Task 2: Wire `input.on("sysex")` in `MidiManager.connectInput`

**Files:**
- Modify: `src/midi/midi-manager.ts`

Add `"sysex"` to `messageTypes` and a sysex branch to the per-type handler. The existing `forwardOutput.send` tee continues to work uniformly because it's keyed on the type string.

- [ ] **Step 1: Add `onSysExCallbacks` field and replace the `onSysEx` stub**

In `src/midi/midi-manager.ts`:

a) Find the listener fields near `onCCCallback`. Add:

```ts
private onSysExCallbacks: Array<(bytes: number[]) => void> = [];
```

b) Replace the existing `onSysEx` stub:

```ts
/** MidiConnection interface: register a SysEx listener (stub — requires input port) */
onSysEx(_callback: (bytes: number[]) => void): void {
  // SysEx input listening not yet implemented — requires input port handling
}
```

with:

```ts
/** MidiConnection interface: register a SysEx listener.
 *  Fires for every SysEx received on the connected input port. */
onSysEx(callback: (bytes: number[]) => void): void {
  this.onSysExCallbacks.push(callback);
}
```

- [ ] **Step 2: Add `"sysex"` to `messageTypes` and a handler branch**

Find this block in `connectInput`:

```ts
const messageTypes = ["noteon", "noteoff", "poly aftertouch", "cc", "program", "channel aftertouch", "pitch"] as const;

for (const type of messageTypes) {
  this.input.on(type as any, (msg: any) => {
    // Forward to mock device if connected
    if (this.forwardOutput) {
      try { this.forwardOutput.send(type as any, msg); } catch {}
    }

    // Fire callbacks
    if (type === "cc" && this.onCCCallback) {
      this.onCCCallback(msg);
    } else if (type === "program" && this.onProgramChangeCallback) {
      this.onProgramChangeCallback(msg);
    }
  });
}
```

Replace with:

```ts
const messageTypes = ["noteon", "noteoff", "poly aftertouch", "cc", "program", "channel aftertouch", "pitch", "sysex"] as const;

for (const type of messageTypes) {
  this.input.on(type as any, (msg: any) => {
    // Forward to shadow if connected (the bridge half)
    if (this.forwardOutput) {
      try { this.forwardOutput.send(type as any, msg); } catch {}
    }

    // Fire MCP-side callbacks (the MCP-listen half)
    if (type === "cc" && this.onCCCallback) {
      this.onCCCallback(msg);
    } else if (type === "program" && this.onProgramChangeCallback) {
      this.onProgramChangeCallback(msg);
    } else if (type === "sysex") {
      const bytes: number[] = [...(msg.bytes ?? [])];
      for (const cb of this.onSysExCallbacks) cb(bytes);
    }
  });
}
```

Note: easymidi's sysex event payload is `{bytes: number[]}` (consistent with how the mock-runner engine consumes it).

- [ ] **Step 3: Verify build + lint + existing unit tests**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -5
```

Expected: green. No new tests in this task — Task 3's `requestRolandValue` tests cover the wire-up indirectly, and Task 8's integration test covers it end-to-end.

- [ ] **Step 4: Commit**

```bash
git add src/midi/midi-manager.ts
git commit -m "feat(midi): receive sysex on connected input port (todo #22)"
```

---

## Task 3: Implement `requestRolandValue` in `roland-dt1.ts`

**Files:**
- Modify: `src/shared/roland-dt1.ts`
- Test: `tests/unit/shared/roland-dt1.test.ts`

The protocol-aware request/response helper. Builds an RQ1, subscribes one-shot to `onSysEx`, resolves on the first matching DT1 (correct address), rejects on timeout, always cleans up the listener.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/shared/roland-dt1.test.ts`:

```ts
import { buildDT1 as build_DT1, decodeRolandSize as decodeSize, parseRQ1 as parse_RQ1, requestRolandValue } from "../../../src/shared/roland-dt1.js";
import type { MidiConnection } from "../../../src/shared/midi-connection.js";

function makeFakeConn(): MidiConnection & { _fireSysEx(bytes: number[]): void; _lastSent: number[] | null } {
  let listeners: Array<(bytes: number[]) => void> = [];
  let lastSent: number[] | null = null;
  return {
    sendCC() {}, sendProgramChange() {}, sendNRPN() {},
    async sendCCBatch() {}, onCC() {},
    sendSysEx(bytes: number[]) { lastSent = bytes; },
    onSysEx(cb) { listeners.push(cb); },
    _fireSysEx(bytes: number[]) { for (const cb of listeners) cb([...bytes]); },
    get _lastSent() { return lastSent; },
  } as any;
}

describe("requestRolandValue", () => {
  const TEST_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };
  const ADDR = [0x01, 0x50, 0x00, 0x00];
  const DEVICE_ID = 0x10;

  it("resolves with the data bytes when a matching DT1 arrives", async () => {
    const conn = makeFakeConn();
    const promise = requestRolandValue(conn, TEST_MODEL_ID, DEVICE_ID, ADDR, 1, 100);

    // Sanity: an RQ1 was sent.
    assert.ok(conn._lastSent, "expected requestRolandValue to send a sysex");
    const parsedReq = parse_RQ1(conn._lastSent!, TEST_MODEL_ID);
    assert.ok(parsedReq, "sent sysex must parse as RQ1");
    assert.deepStrictEqual(parsedReq!.address, ADDR);
    assert.equal(decodeSize(parsedReq!.size), 1);

    // Fire a matching DT1.
    const dt1 = build_DT1(TEST_MODEL_ID, DEVICE_ID, ADDR, [0x42]);
    conn._fireSysEx(dt1);

    const data = await promise;
    assert.deepStrictEqual(data, [0x42]);
  });

  it("ignores DT1 messages with a different address", async () => {
    const conn = makeFakeConn();
    const promise = requestRolandValue(conn, TEST_MODEL_ID, DEVICE_ID, ADDR, 1, 100);

    // Wrong address — should be ignored.
    const wrong = build_DT1(TEST_MODEL_ID, DEVICE_ID, [0x01, 0x60, 0x00, 0x00], [0x99]);
    conn._fireSysEx(wrong);

    // Right address — should resolve.
    const right = build_DT1(TEST_MODEL_ID, DEVICE_ID, ADDR, [0x42]);
    conn._fireSysEx(right);

    const data = await promise;
    assert.deepStrictEqual(data, [0x42]);
  });

  it("rejects on timeout when no matching DT1 arrives", async () => {
    const conn = makeFakeConn();
    await assert.rejects(
      requestRolandValue(conn, TEST_MODEL_ID, DEVICE_ID, ADDR, 1, 30),
      /timeout/i,
    );
  });

  it("ignores non-DT1 sysex while waiting", async () => {
    const conn = makeFakeConn();
    const promise = requestRolandValue(conn, TEST_MODEL_ID, DEVICE_ID, ADDR, 1, 100);
    conn._fireSysEx([0xF0, 0x42, 0x99, 0xF7]); // not Roland; should be ignored
    const dt1 = build_DT1(TEST_MODEL_ID, DEVICE_ID, ADDR, [0x42]);
    conn._fireSysEx(dt1);
    const data = await promise;
    assert.deepStrictEqual(data, [0x42]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test tests/unit/shared/roland-dt1.test.ts 2>&1 | tail -10
```

Expected: FAIL — `requestRolandValue` is not exported.

- [ ] **Step 3: Implement `requestRolandValue`**

In `src/shared/roland-dt1.ts`, append after the `addAddresses` function:

```ts
import type { MidiConnection } from "./midi-connection.js";

/**
 * Send a Roland RQ1 SysEx and await the matching DT1 response.
 *
 * Resolves with the DT1 data bytes when a DT1 arrives whose address equals
 * `address`. Rejects with a timeout error if no matching DT1 arrives within
 * `timeoutMs`. Non-DT1 SysEx and DT1s with mismatched addresses are
 * silently ignored — they may be unrelated traffic on the bus.
 *
 * The one-shot `onSysEx` listener registered here is NOT explicitly
 * unsubscribed (the {@link MidiConnection} interface doesn't expose an
 * unsubscribe). Callers are expected to use a long-lived connection where
 * a leftover no-op listener is harmless. If you find yourself in a hot
 * loop calling this, that's a signal to extend `MidiConnection` with
 * subscribe/unsubscribe semantics — but YAGNI for now.
 */
export async function requestRolandValue(
  conn: MidiConnection,
  modelId: RolandModelId,
  deviceId: number,
  address: number[],
  size: number,
  timeoutMs: number,
): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`requestRolandValue: timeout after ${timeoutMs}ms (addr=${address.map(b => b.toString(16).padStart(2, "0")).join(":")})`));
    }, timeoutMs);

    conn.onSysEx((bytes) => {
      if (resolved) return;
      const dt1 = parseDT1(bytes, modelId);
      if (!dt1) return;
      if (!dt1.address.every((b, i) => b === address[i])) return;
      // (We intentionally don't check data length here — the caller asked
      //  for `size` bytes, but if the device sends fewer/more, returning
      //  what we got is more useful than rejecting.)
      resolved = true;
      clearTimeout(timer);
      resolve(dt1.data);
    });

    // Build and send the RQ1. Size is encoded as 4 x 7-bit bytes
    // (MSB-first), matching the wire format produced by buildRQ1.
    const sizeBytes = [
      (size >> 21) & 0x7F,
      (size >> 14) & 0x7F,
      (size >> 7) & 0x7F,
      size & 0x7F,
    ];
    conn.sendSysEx(buildRQ1(modelId, deviceId, address, sizeBytes));
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx tsx --test tests/unit/shared/roland-dt1.test.ts 2>&1 | tail -8
```

Expected: PASS — all four `requestRolandValue` cases plus the existing `parseRQ1`/`decodeRolandSize` cases.

- [ ] **Step 5: Commit**

```bash
git add src/shared/roland-dt1.ts tests/unit/shared/roland-dt1.test.ts
git commit -m "feat(roland-dt1): requestRolandValue helper for RQ1→DT1 round-trips (todo #22)"
```

---

## Task 4: `BridgeRegistry` — device edges + extended cycle detection

**Files:**
- Modify: `src/mcb/bridge-registry.ts`
- Test: `tests/unit/mcb/bridge-registry.test.ts`

#21 enabling bidirectional mocks means a lease that has both primary and input directions effectively introduces a device-internal edge `primary-out → input-port`. Combined with explicit bridges, this can form cycles that today's walker (which only knows about bridges) doesn't catch.

Concrete scenario: lease A claims primary `mockA-out` and input `mockA-out` (same OS port name — mocks expose both directions on one name). Lease B claims primary `mockB-out` and input `mockB-out`. Bridge 1: `mockA-out → mockB-in`. Bridge 2: `mockB-out → mockA-in`. With device edges `mockA-out → mockA-in` and `mockB-out → mockB-in` factored in, we have a cycle that should be refused.

- [ ] **Step 1: Write failing tests for cycle detection with device edges**

Append to `tests/unit/mcb/bridge-registry.test.ts`:

```ts
describe("BridgeRegistry: device-edge cycle detection (todo #22)", () => {
  it("refuses a bridge that closes a cycle through registered device edges", () => {
    const r = new BridgeRegistry();
    // Two devices, each with an internal out→in edge (the device's MIDI Out
    // can flow back to its MIDI In if anything bridges it).
    r.addDeviceEdge("dev-A", "mockA-out", "mockA-in");
    r.addDeviceEdge("dev-B", "mockB-out", "mockB-in");

    // First bridge OK: dev-A's out → dev-B's in.
    r.add("dev-A", "mockA-out", "mockB-in");

    // Second bridge SHOULD fail: dev-B's out → dev-A's in would close the
    // loop A_out → (bridge1) → B_in → (devB internal) → B_out → (this) → A_in → (devA internal) → A_out.
    assert.throws(
      () => r.add("dev-B", "mockB-out", "mockA-in"),
      /cycle-would-form/,
    );
  });

  it("allows bridges that do not close a cycle even when device edges exist", () => {
    const r = new BridgeRegistry();
    r.addDeviceEdge("dev-A", "mockA-out", "mockA-in");
    r.addDeviceEdge("dev-B", "mockB-out", "mockB-in");
    // Single bridge — no cycle.
    r.add("dev-A", "mockA-out", "mockB-in");
    // No throw — passes.
  });

  it("removeDeviceEdge releases the constraint", () => {
    const r = new BridgeRegistry();
    r.addDeviceEdge("dev-A", "mockA-out", "mockA-in");
    r.addDeviceEdge("dev-B", "mockB-out", "mockB-in");
    r.add("dev-A", "mockA-out", "mockB-in");

    // Remove dev-B's device edge — the bridge B_out→A_in is no longer
    // a closing edge (B_in no longer chains to B_out).
    r.removeDeviceEdge("dev-B");

    // Now this bridge should succeed.
    r.add("dev-B", "mockB-out", "mockA-in");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test tests/unit/mcb/bridge-registry.test.ts 2>&1 | tail -10
```

Expected: FAIL — `addDeviceEdge` is not a function.

- [ ] **Step 3: Add device-edge support to `BridgeRegistry`**

In `src/mcb/bridge-registry.ts`, replace the entire class body with:

```ts
interface BridgeRecord {
  masterPortName: string;
  shadowPortName: string;
}

interface DeviceEdgeRecord {
  outPort: string;
  inPort: string;
}

export type BridgeRegistryErrorCode =
  | "self-shadow"
  | "bridge-already-exists"
  | "shadow-conflict"
  | "master-port-conflict"
  | "cycle-would-form";

export class BridgeRegistryError extends Error {
  constructor(public readonly code: BridgeRegistryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BridgeRegistryError";
  }
}

export class BridgeRegistry {
  private bridges = new Map<string, BridgeRecord>();
  private shadowIndex = new Map<string, string>();
  private masterIndex = new Map<string, string>();

  // Device edges: each device with both primary-out and input contributes
  // an internal edge `outPort → inPort`. Cycle detection treats these
  // identically to bridge edges in the port→port graph.
  private deviceEdges = new Map<string, DeviceEdgeRecord>();
  // Reverse index: outPort → deviceId, used by the walker to look up the
  // next inPort given an outPort.
  private outPortToDevice = new Map<string, string>();

  addDeviceEdge(deviceId: string, outPort: string, inPort: string): void {
    this.deviceEdges.set(deviceId, { outPort, inPort });
    this.outPortToDevice.set(outPort, deviceId);
  }

  removeDeviceEdge(deviceId: string): void {
    const edge = this.deviceEdges.get(deviceId);
    if (!edge) return;
    this.outPortToDevice.delete(edge.outPort);
    this.deviceEdges.delete(deviceId);
  }

  add(masterDeviceId: string, masterPortName: string, shadowPortName: string): void {
    if (masterPortName === shadowPortName) {
      throw new BridgeRegistryError("self-shadow", "master and shadow ports must differ");
    }
    if (this.bridges.has(masterDeviceId)) {
      throw new BridgeRegistryError("bridge-already-exists", `master ${masterDeviceId} already has a bridge`);
    }
    if (this.shadowIndex.has(shadowPortName)) {
      throw new BridgeRegistryError("shadow-conflict", `${shadowPortName} is already a shadow target`);
    }
    if (this.masterIndex.has(masterPortName)) {
      throw new BridgeRegistryError("master-port-conflict", `${masterPortName} is already a master port`);
    }
    if (this.wouldFormCycle(masterPortName, shadowPortName)) {
      throw new BridgeRegistryError("cycle-would-form", `bridge ${masterPortName}→${shadowPortName} would close a chain`);
    }
    this.bridges.set(masterDeviceId, { masterPortName, shadowPortName });
    this.shadowIndex.set(shadowPortName, masterDeviceId);
    this.masterIndex.set(masterPortName, masterDeviceId);
  }

  remove(masterDeviceId: string): void {
    const bridge = this.bridges.get(masterDeviceId);
    if (!bridge) return;
    this.shadowIndex.delete(bridge.shadowPortName);
    this.masterIndex.delete(bridge.masterPortName);
    this.bridges.delete(masterDeviceId);
  }

  shadowOf(masterDeviceId: string): string | undefined {
    return this.bridges.get(masterDeviceId)?.shadowPortName;
  }

  isShadowTarget(portName: string): { masterDeviceId: string } | undefined {
    const masterDeviceId = this.shadowIndex.get(portName);
    return masterDeviceId ? { masterDeviceId } : undefined;
  }

  /**
   * Walk the port graph from `shadowPortName` along the chain of edges:
   * - Bridge edges: master-port → shadow-port (existing).
   * - Device edges: out-port → in-port (added by addDeviceEdge).
   *
   * Both kinds are traversed identically. The walker needs to step from
   * a port to the NEXT port via either kind of edge:
   * - From an in-port: was it the shadow-target of a bridge? If so, the
   *   bridge's master-port is reachable backward — but cycle detection
   *   tracks FORWARD reachability. So we step from a port to whatever
   *   port is one forward edge away — that's:
   *   - master-port → shadow-port (bridges go this direction)
   *   - out-port → in-port (device edges go this direction)
   *
   * To find the forward edge from `current`, check both the masterIndex
   * (treating `current` as a master-port of a bridge) and the
   * outPortToDevice map (treating `current` as an out-port of a device).
   * Whichever resolves first gives the next port. (At most one resolves —
   * a port can't be both a bridge master AND a device out-port owned by
   * different devices. The lease/bridge invariants enforce this.)
   *
   * If the walk reaches `masterPortName` (the proposed new bridge's
   * master-port), adding the edge would close a cycle.
   */
  private wouldFormCycle(masterPortName: string, shadowPortName: string): boolean {
    let current: string | undefined = shadowPortName;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (current === masterPortName) return true;
      if (seen.has(current)) return false;
      seen.add(current);

      // Try a bridge edge: current is the master-port of an existing bridge?
      const nextMasterId = this.masterIndex.get(current);
      if (nextMasterId !== undefined) {
        current = this.bridges.get(nextMasterId)?.shadowPortName;
        continue;
      }

      // Try a device edge: current is the out-port of a registered device?
      const nextDeviceId = this.outPortToDevice.get(current);
      if (nextDeviceId !== undefined) {
        current = this.deviceEdges.get(nextDeviceId)?.inPort;
        continue;
      }

      // No outgoing edge — chain terminates here.
      return false;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsx --test tests/unit/mcb/bridge-registry.test.ts 2>&1 | tail -10
```

Expected: PASS — both pre-existing and new cycle tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/bridge-registry.ts tests/unit/mcb/bridge-registry.test.ts
git commit -m "feat(mcb): bridge registry tracks device edges for cycle detection (todo #22)"
```

---

## Task 5: `LeaseRegistry` registers device edges with `BridgeRegistry`

**Files:**
- Modify: `src/mcb/lease-registry.ts`
- Modify: `src/mcb/http/devices.ts` (constructor wiring)
- Test: `tests/unit/mcb/lease-registry.test.ts`

When a lease has both `primary.portName` and `input.portName`, register a device edge in BridgeRegistry. Remove on lease removal. This requires `LeaseRegistry` to hold a reference to BridgeRegistry — pass it in via the constructor.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/mcb/lease-registry.test.ts`:

```ts
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";

describe("LeaseRegistry registers device edges (todo #22)", () => {
  it("calls bridges.addDeviceEdge when a lease has both primary and input", () => {
    const bridges = new BridgeRegistry();
    const leases = new LeaseRegistry(bridges);

    leases.add({
      deviceId: "dev-A",
      ownerSessionId: "sess-1",
      model: "roland-juno-x",
      primary: { portName: "mockA-out", wsPort: null },
      input: { portName: "mockA-in" },
      channel: 1,
      connectedAt: Date.now(),
    } as any);

    // Now adding a bridge `mockA-out → mockA-in` should be detected as a cycle.
    assert.throws(
      () => bridges.add("dev-X", "mockA-out", "mockA-in"),
      /cycle-would-form/,
    );
  });

  it("does NOT register a device edge when a lease has no input", () => {
    const bridges = new BridgeRegistry();
    const leases = new LeaseRegistry(bridges);

    leases.add({
      deviceId: "dev-A",
      ownerSessionId: "sess-1",
      model: "nord-electro-5d",
      primary: { portName: "nord-out", wsPort: null },
      // no input
      channel: 1,
      connectedAt: Date.now(),
    } as any);

    // No device edge → no cycle from the device's internal flow.
    bridges.add("dev-X", "nord-out", "nord-in"); // succeeds
  });

  it("removeDevice releases the device edge", () => {
    const bridges = new BridgeRegistry();
    const leases = new LeaseRegistry(bridges);

    leases.add({
      deviceId: "dev-A",
      ownerSessionId: "sess-1",
      model: "roland-juno-x",
      primary: { portName: "mockA-out", wsPort: null },
      input: { portName: "mockA-in" },
      channel: 1,
      connectedAt: Date.now(),
    } as any);

    leases.remove("dev-A");

    // After removal, the device edge is gone — bridges to mockA-in succeed.
    bridges.add("dev-X", "other-out", "mockA-in"); // succeeds
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx tsx --test tests/unit/mcb/lease-registry.test.ts 2>&1 | tail -5
```

Expected: FAIL — `LeaseRegistry` constructor doesn't take a `BridgeRegistry`, and there's no `addDeviceEdge` call.

- [ ] **Step 3: Update `LeaseRegistry` to accept and use a `BridgeRegistry`**

Replace the body of `src/mcb/lease-registry.ts`:

```ts
import type { BridgeRegistry } from "./bridge-registry.js";
import type { Lease } from "./types.js";

export type LeaseRegistryErrorCode = "port-already-owned";

export class LeaseRegistryError extends Error {
  constructor(public readonly code: LeaseRegistryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LeaseRegistryError";
  }
}

export class LeaseRegistry {
  private byDeviceId = new Map<string, Lease>();
  private primaryIndex = new Map<string, string>();

  constructor(private readonly bridges: BridgeRegistry) {}

  add(lease: Lease): void {
    if (this.primaryIndex.has(lease.primary.portName)) {
      throw new LeaseRegistryError("port-already-owned", lease.primary.portName);
    }
    this.byDeviceId.set(lease.deviceId, lease);
    this.primaryIndex.set(lease.primary.portName, lease.deviceId);

    // Register the device-internal edge primary.out → input. Cycle
    // detection (BridgeRegistry.wouldFormCycle) treats this as an edge
    // when validating future bridges.
    if (lease.input) {
      this.bridges.addDeviceEdge(lease.deviceId, lease.primary.portName, lease.input.portName);
    }
  }

  remove(deviceId: string): void {
    const lease = this.byDeviceId.get(deviceId);
    if (!lease) return;
    this.bridges.removeDeviceEdge(deviceId);
    this.primaryIndex.delete(lease.primary.portName);
    this.byDeviceId.delete(deviceId);
  }

  get(deviceId: string): Lease | undefined {
    return this.byDeviceId.get(deviceId);
  }

  isPrimary(portName: string): { sessionId: string; deviceId: string } | undefined {
    const deviceId = this.primaryIndex.get(portName);
    if (!deviceId) return undefined;
    const lease = this.byDeviceId.get(deviceId)!;
    return { sessionId: lease.ownerSessionId, deviceId };
  }

  listAll(): Lease[] {
    return [...this.byDeviceId.values()];
  }
}
```

- [ ] **Step 4: Update the constructor call site**

In `src/mcb/http/devices.ts` (or wherever `LeaseRegistry` is instantiated — search for `new LeaseRegistry`), pass the `BridgeRegistry`:

```bash
grep -rn "new LeaseRegistry" src/ tests/
```

For each call site, update from `new LeaseRegistry()` to `new LeaseRegistry(bridges)` (the BridgeRegistry instance is already in scope as `deps.bridges` in MCB-side code).

- [ ] **Step 5: Run unit tests**

```bash
npm run test:unit 2>&1 | tail -8
```

Expected: green. The lease-registry tests pass; pre-existing tests still pass; bridge-registry tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcb/lease-registry.ts src/mcb/http/devices.ts tests/unit/mcb/lease-registry.test.ts
git commit -m "feat(mcb): LeaseRegistry registers device edges in BridgeRegistry (todo #22)"
```

---

## Task 6: `connect_to_keyboard` auto-resolves `input_port` from a mock primary

**Files:**
- Modify: `src/mcb/http/devices.ts`

When `body.input_port` is unset and the primary resolves to a registered mock, default the input to the same OS port name. Per #21, mocks expose both directions on the same name. Real hardware still requires an explicit `input_port` because the names differ.

- [ ] **Step 1: Add the auto-resolution logic**

In `src/mcb/http/devices.ts`, find:

```ts
let input: { portName: string } | undefined;
if (typeof body.input_port === "string") {
  const ip = resolveOrHttp(() => resolvePort(body.input_port!, "input", deps.portList, deps.mockRegistry));
  input = { portName: ip.portName };
}
```

Replace with:

```ts
let input: { portName: string } | undefined;
if (typeof body.input_port === "string") {
  const ip = resolveOrHttp(() => resolvePort(body.input_port!, "input", deps.portList, deps.mockRegistry));
  input = { portName: ip.portName };
} else {
  // Auto-resolve from a mock primary: mocks expose both directions
  // (device's MIDI In and MIDI Out) under the same OS port name (todo #21).
  // Real hardware uses different names for IN vs OUT, so the user must
  // pass `input_port` explicitly there.
  const mockEntry = deps.mockRegistry.findByMidiPort(primary.portName);
  if (mockEntry) {
    input = { portName: primary.portName };
  }
}
```

If `deps.mockRegistry.findByMidiPort` doesn't exist on the deps shape, search for the function — it may be exported elsewhere as a free function in `src/shared/mock-registry.ts`. Use the version that's already imported in `connect.ts`. Adjust the deps shape if needed.

- [ ] **Step 2: Verify build + lint + unit**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add src/mcb/http/devices.ts
git commit -m "feat(mcb): auto-resolve input port from mock primary (todo #22)"
```

---

## Task 7: Integration test — RQ1 round-trip via real-MIDI through `MidiManager`

**Files:**
- Test: `tests/integration/mcp-sysex-receive.test.ts` (new)

End-to-end smoke: spawn a JUNO-X mock on a virtual MIDI port pair, connect a `MidiManager` to send to the IN side and listen on the OUT side, send an RQ1 via `requestRolandValue`, assert the resolved DT1 carries the expected bytes. Skipped in WS-only (Docker) mode because real-MIDI receive is what's being tested.

- [ ] **Step 1: Write the test**

Create `tests/integration/mcp-sysex-receive.test.ts`:

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MidiManager } from "../../src/midi/midi-manager.js";
import { MockProcess } from "../helpers/mock-process.js";
import { requestRolandValue, buildDT1, addAddresses } from "../../src/shared/roland-dt1.js";

const IS_DOCKER_WS_MODE = !!process.env.MOCK_WS_URL;
const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };
const SCENE_BASE = [0x01, 0x00, 0x00, 0x00];
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00];
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

describe("MCP sysex receive: RQ1 round-trip via real MIDI", { concurrency: 1, skip: IS_DOCKER_WS_MODE }, () => {
  it("sends RQ1, receives DT1 with the stored value", async () => {
    const mock = await MockProcess.start({ model: "roland-juno-x", wsPort: 5600 });
    try {
      // Wait for the mock to register its MIDI ports.
      await new Promise((r) => setTimeout(r, 300));

      const portName = "Roland JUNO-X Mock";
      const midi = new MidiManager();
      midi.connect(portName);
      midi.connectInput(portName);

      // Pre-set chorus_switch=1 via DT1 so we have something non-default to read.
      const setMsg = buildDT1(JUNO_X_MODEL_ID, 0x10, CHORUS_SWITCH_ADDR, [0x01]);
      midi.sendSysEx(setMsg);
      await new Promise((r) => setTimeout(r, 50));

      // Now query via RQ1.
      const data = await requestRolandValue(midi, JUNO_X_MODEL_ID, 0x10, CHORUS_SWITCH_ADDR, 1, 500);
      assert.deepStrictEqual(data, [0x01], "expected chorus_switch=1 from RQ1 round-trip");

      midi.disconnect();
    } finally {
      await mock.stop();
    }
  });

  it("times out cleanly when no device is listening to RQ1", async () => {
    // No mock running here — the input port doesn't exist, so the test
    // skips port opening if the port name isn't found. We simulate the
    // timeout path by sending RQ1 to a non-existent port.
    // (Skip if any JUNO-X mock happens to be running — interferes.)
    // For deterministic isolation, just construct a MidiManager that
    // never connects an input.
    const midi = new MidiManager();
    // Without connectInput, onSysEx fires for nothing → timeout.
    await assert.rejects(
      requestRolandValue(midi, JUNO_X_MODEL_ID, 0x10, CHORUS_SWITCH_ADDR, 1, 30),
      /timeout/i,
    );
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
npm run test:integration -- --test-name-pattern="RQ1 round-trip"
```

Expected: PASS — the first case round-trips RQ1→DT1 via the MidiManager input listener; the second confirms the timeout path.

If the first case fails because the mock didn't register in time, increase the wait to 500ms.

If the test skips entirely under `MOCK_WS_URL`, that's expected.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcp-sysex-receive.test.ts
git commit -m "test(integration): RQ1 round-trip via MidiManager input listener (todo #22)"
```

---

## Task 8: Add todo #25 — defer WS-mode SysEx receive

**Files:**
- Modify: `docs/plans/pending/todo-list.md`

This PR's real-MIDI scope works locally and validates the end-to-end RQ1 flow. WS-mode receive (mock spinning up a second WS, MCP-side WsMidiConnection listening there) is a separate body of work — it requires plumbing the second WS port through mock-registry, MCB manifest, and connect.ts; updating Docker test infra; and matching the CI integration test surface. Captured here so it's not lost.

- [ ] **Step 1: Add the todo entry**

In `docs/plans/pending/todo-list.md`, append (or insert after the existing #22/#23/#24 block):

```markdown
### 25. WS-mode SysEx receive — second WebSocket lane for outgoing MIDI

**Status:** Needs design.

#21 added a virtual MIDI Out port on every model mock; #22 wired the MCP-side real-MIDI receive path. CI/Docker mode (where `MOCK_WS_URL` is set and real MIDI is unavailable) currently has no symmetric receive path — `WsMidiConnection.onSysEx` is still a no-op.

To close that gap, mirror the real-MIDI approach over WebSockets. The user's directive from the #22 brainstorm (paraphrased): *similar to the output direction's env var, we can have an env var that picks real MIDI vs WS for receive.*

Scope:
- **MockEngine: second WS server.** Per the "port for port" decision recorded in earlier #21 brainstorm — each MIDI direction maps to its own WS port. Existing WS keeps its mixed role (UI state + UI commands + MCP status); new WS is dedicated to outgoing-from-mock MIDI events. On every `MockHandlerResult.sysexOut`, broadcast `{type:"sysex", bytes}` only on the new server.
- **mock-registry**: add `wsOutPort` field alongside the existing `wsPort`.
- **MCB manifest**: surface `primary.wsOutPort` from the mock-registry entry.
- **`WsMidiConnection`**: take a second URL; listen there for `{type:"sysex"}`; fire `onSysEx`.
- **`connect.ts`**: plumb `manifest.primary.wsOutPort` into the WS-mode `WsMidiConnection.connect` call. Add `MOCK_WS_OUT_URL` env var for direct-WS-mode usage in tests.
- **CI integration test** for RQ1 round-trip in WS mode.

Out of scope (separate todo if needed): the receive path on real hardware over a *bridge* (e.g. someone wants to listen for DT1 via a bridge tee instead of direct connection). Today's bridges are one-way (master out → shadow in); making them bidirectional or adding a separate input bridge is its own design work.

Useful prior art: `src/midi/ws-midi-connection.ts` (existing send-only WS impl), `src/mock-runner/engine.ts` (existing WS server + virtual MIDI Out fan-out from #21), `tests/helpers/test-harness.ts` (CI/Docker WS-mode infrastructure).
```

- [ ] **Step 2: Commit**

```bash
git add docs/plans/pending/todo-list.md
git commit -m "docs(plans): add todo #25 — WS-mode sysex receive (todo #22)"
```

---

## Task 9: Final sweep + PR

**Files:** none (verification + PR creation)

- [ ] **Step 1: Run the full local pyramid**

```bash
npm run lint
npm run test:check
npm run test:unit
npm run test:integration
npm run test:e2e:mcb
```

Expected: all green. If anything fails, fix before proceeding.

- [ ] **Step 2: Move plan to completed, strike #22 from todo-list**

```bash
mv docs/plans/pending/22-mcp-sysex-receive.md docs/plans/completed/
git add docs/plans/completed/22-mcp-sysex-receive.md
```

Edit `docs/plans/pending/todo-list.md` and delete the entire `### 22. MCP-side receive plumbing for SysEx: connect semantics + bridge integration` block. Leave `### 23.`, `### 24.`, and `### 25.` (added in Task 8).

```bash
git add docs/plans/pending/todo-list.md
git commit -m "docs(plans): #22 complete — MCP-side sysex receive (real-MIDI) shipped"
```

- [ ] **Step 3: Push + create PR**

```bash
git push -u origin feat/plan-22/mcp-sysex-receive
gh pr create --title "feat(midi): MCP-side sysex receive + requestRolandValue + bridge cycle hardening (#22)" --body "$(cat <<'EOF'
## Summary

Closes the loop on the RQ1 protocol foundation laid in #21. Three concentric layers:

1. **Transport** — MidiManager.connectInput now consumes \`input.on(\"sysex\")\`, fans the bytes to both the shadow (existing forwardOutput tee) and the MCP (new \`onSysEx\` callbacks). \`MidiConnection.onSysEx\` is now required.
2. **Protocol** — \`requestRolandValue(conn, modelId, deviceId, address, size, timeoutMs)\` lives next to the existing DT1/RQ1 helpers. Builds an RQ1, awaits the matching DT1, resolves with data bytes.
3. **Lease + bridge graph** — \`BridgeRegistry\` learns about device-internal edges (lease's primary-out → input port). Combined with explicit bridges, this catches cycles that #21's bidirectional mocks newly enable. \`LeaseRegistry\` registers/unregisters device edges automatically. \`connect_to_keyboard\` auto-resolves \`input_port\` from a mock primary.

**End-to-end JUNO-X \`get_current_state\`** is NOT in scope here — that's #23, which can now build directly on \`requestRolandValue\`.

**WS-mode SysEx receive** (mocks broadcasting outgoing SysEx over a second WebSocket lane) is also deferred — see #25 added at the end of the plan.

## What's new

- \`MidiManager\` receives sysex on the connected input port (currently used for the RQ1→DT1 path; future: live knob feedback).
- \`requestRolandValue\` helper in \`src/shared/roland-dt1.ts\`.
- \`BridgeRegistry.addDeviceEdge\` / \`removeDeviceEdge\`; \`wouldFormCycle\` now traverses both bridge edges and device edges.
- \`LeaseRegistry\` is constructed with a \`BridgeRegistry\` reference and registers/removes device edges with each lease.
- \`connect_to_keyboard\` auto-resolves \`input_port\` to the primary's port name when the primary is a registered mock.
- New integration test: RQ1 round-trip via MidiManager (local-only).
- Todo #25 added for WS-mode receive.

## What's deferred

**Todo #23 — JUNO-X \`get_current_state\` rewrite (now unblocked).**
**Todo #25 — WS-mode SysEx receive.** Mock second WS server, MidiConnection second URL, MCB manifest plumbing.

## Test plan

- [x] \`npm run lint\`
- [x] \`npm run test:check\`
- [x] \`npm run test:unit\` — includes new \`requestRolandValue\`, \`BridgeRegistry\` device-edge cycle, and \`LeaseRegistry\` device-edge tests.
- [x] \`npm run test:integration\` — includes new \`mcp-sysex-receive.test.ts\` (skipped in WS-mode CI).
- [x] \`npm run test:e2e:mcb\`
- [ ] CI

## Plan

\`docs/plans/completed/22-mcp-sysex-receive.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Monitor CI + Copilot review**

Use `superpowers:finishing-a-development-branch` to handle CI failures and Copilot comments. Coverage gate is pre-existing red on `main`.

---

## Self-Review

**Spec coverage** (against the goal: MCP-side SysEx receive + `requestRolandValue` + bridge cycle hardening):

| Goal element | Task |
|---|---|
| Promote `MidiConnection.onSysEx` to required | Task 1 |
| Wire `input.on("sysex")` in MidiManager | Task 2 |
| Fan-out: incoming SysEx to both MCP callback and shadow forward | Task 2 (existing forwardOutput pattern; sysex slots into the existing fan-out) |
| `requestRolandValue` in `roland-dt1.ts` | Task 3 |
| BridgeRegistry device edges + extended cycle detection | Task 4 |
| LeaseRegistry registers device edges | Task 5 |
| `connect_to_keyboard` auto-resolves input from mock primary | Task 6 |
| Integration test for RQ1 round-trip | Task 7 |
| Defer WS-mode receive explicitly | Task 8 (todo #25) |

**Placeholder scan:** every step shows the actual code or command. No "TBD" markers.

**Type consistency:**
- `requestRolandValue(conn, modelId, deviceId, address, size, timeoutMs)` signature consistent across the implementation, tests, and integration test.
- `BridgeRegistry.addDeviceEdge(deviceId, outPort, inPort)` / `removeDeviceEdge(deviceId)` — used the same way in tests, in LeaseRegistry, and in the implementation.
- `LeaseRegistry` constructor signature changed (`new LeaseRegistry(bridges)`) — Task 5 Step 4 explicitly says to update all call sites.

**Pre-flight verification:**
- `parseDT1` is already exported from `src/shared/roland-dt1.ts` (used in #21).
- `buildRQ1` is already exported (used in #21).
- `mockRegistry.findByMidiPort` is available — confirm in Task 6 (the function is exported from `src/shared/mock-registry.ts`).
- `MidiConnection` import path in `roland-dt1.ts` adds a new import (the file currently doesn't depend on it). That's an additive change; no circular import concern (midi-connection.ts imports nothing from shared/).
- The forwardOutput fan-out in connectInput already calls `forwardOutput.send("sysex", msg)` for free once "sysex" is added to messageTypes — verified by reading the existing handler in midi-manager.ts:268-279.
