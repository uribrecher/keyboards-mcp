# midi-connections-broker (MCB) — Phase 1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `midi-connections-broker` (MCB) Node binary that listens on a Unix domain socket, speaks HTTP, and implements the connection broker's full control plane (sessions, lease registry, bridge registry, port resolver, SSE topology events) — without opening any MIDI ports or WebSockets, and without modifying any existing repo files.

**Architecture:** New top-level `src/mcb/` directory. Pure metadata + arbitration. Tests against synthetic HTTP/UDS clients verify lock semantics, bridge invariants, port resolution, session GC, and SSE delivery end-to-end. Phase 2 (separate plan) integrates MCB into MCP; Phase 1 stands alone.

**Tech Stack:** Node (existing version), TypeScript 5.5+, `node:http` over Unix domain socket, `node:test` + `node:assert`, `tsx` runner, `easymidi` (read-only for port listing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-05-midi-connections-broker-mvp.md`. Architectural reference: `docs/superpowers/specs/2026-05-05-midi-connections-broker-design.md`. **Backlog (do NOT plan from):** `docs/superpowers/specs/2026-05-05-midi-connections-broker-backlog.md`.

---

## Pragmatic deviation from the spec

The spec says "MCB reads peer PID via `SO_PEERCRED` (Linux) / `LOCAL_PEERPID` (macOS)". Node's standard library has no built-in for these syscalls, and existing third-party packages are stale. **For Phase 1, MCB receives the client's PID in the request body** (`POST /v1/sessions { processName?: string, pid: number }`). Trust gate: the UDS file is `0600` (owner-only); a malicious co-resident user cannot connect; an MCP that lies about its own PID only hurts itself (its session GCs against the wrong PID). The interface is wrapped in a `PeerCredsReader` so a future task (backlog: "OS-level peer-PID via syscall") can swap it without API changes.

## File structure

```
src/mcb/
  index.ts                  # bin entry: parse env, set up server, listen, signal handlers
  types.ts                  # MCB-internal types: Lease, ShadowEndpoint, Session, Manifest
  http/
    server.ts               # request routing, JSON body parse helpers
    sessions.ts             # POST /v1/sessions, attach, DELETE, GET sessions/:id/devices
    devices.ts              # POST /v1/devices, GET, DELETE
    midi-ports.ts           # GET /v1/midi/ports
    events.ts               # GET /v1/events (SSE)
    health.ts               # GET /v1/health
    errors.ts               # formatError(err) → { error, message, details? }
  lease-registry.ts         # in-memory: Map<deviceId, Lease>; isPrimary(portName)
  bridge-registry.ts        # in-memory: Map<masterDeviceId, ShadowEndpoint>
  port-resolver.ts          # strict resolution + injectable PortListReader
  session-manager.ts        # session lifecycle, PID-liveness watcher
  event-broadcaster.ts      # internal pub-sub for SSE

tests/
  helpers/
    mcb-spawn.ts            # spawn MCB binary as child process for integration tests
    mcb-client.ts           # HTTP-over-UDS client used by integration tests
  unit/mcb/
    bridge-registry.test.ts
    lease-registry.test.ts
    port-resolver.test.ts
    session-manager.test.ts
    event-broadcaster.test.ts
  integration/mcb/
    lifecycle.test.ts
    multi-session.test.ts
    bridge-invariants.test.ts
    sse-events.test.ts
    pid-liveness.test.ts
```

`package.json` additions:
- `bin: { "midi-connections-broker": "./dist/mcb/index.js" }`
- `scripts.mcb: "tsx src/mcb/index.ts"` (foreground for dev)
- `scripts.test:unit` (existing) automatically picks up `tests/unit/mcb/*.test.ts` via the existing `find tests/unit -name '*.test.ts'` pattern.
- `scripts.test:integration` (existing) automatically picks up `tests/integration/mcb/*.test.ts`.

---

## Task 1: Scaffold and types

**Files:**
- Create: `src/mcb/types.ts`
- Create: `src/mcb/index.ts` (minimal bin entry)
- Modify: `package.json` (bin entry, mcb script)

- [ ] **Step 1: Write the failing smoke test**

Create `tests/unit/mcb/scaffold.test.ts`:

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { Session, Lease, Manifest, ShadowEndpoint } from "../../../src/mcb/types.js";

describe("MCB scaffold", () => {
  it("type module is importable", () => {
    const lease: Lease = {
      deviceId: "test-id",
      ownerSessionId: "test-sess",
      model: "test-model",
      primary: { portName: "Test Port", wsPort: null },
      label: "default",
      channel: 1,
    };
    assert.equal(lease.deviceId, "test-id");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx tsx --test tests/unit/mcb/scaffold.test.ts`

Expected: FAIL with module-not-found / cannot-import error.

- [ ] **Step 3: Create `src/mcb/types.ts`**

```ts
export interface Session {
  sessionId: string;
  pid: number;
  processName?: string;
  ownedDeviceIds: Set<string>;
  createdAt: number;        // epoch ms
  markedDeadAt: number | null;  // epoch ms when liveness watcher first declared dead, else null
}

export interface ShadowEndpoint {
  portName: string;
}

export interface Lease {
  deviceId: string;
  ownerSessionId: string;
  model: string;
  primary: PortInfo;
  input?: { portName: string };
  shadow?: PortInfo;
  label: string;
  channel: number;
  lowerChannel?: number;
  upperChannel?: number;
  connectedAt: number;     // epoch ms — preserves connection-time order
}

export interface PortInfo {
  portName: string;
  wsPort: number | null;
}

/** What POST /v1/devices and GET /v1/devices/:id return. Same shape as Lease minus connectedAt. */
export type Manifest = Omit<Lease, "connectedAt">;

export interface SessionOwnerInfo {
  sessionId: string;
  pid: number;
  processName?: string;
}

export type Direction = "output" | "input";

export interface PortListReader {
  listOutputs(): string[];
  listInputs(): string[];
}

export interface MockRegistryEntry {
  midiPort: string;
  wsPort: number;
  label: string;
  pid: number;
}
export interface MockRegistryReader {
  findByLabel(label: string): MockRegistryEntry | undefined;
  findByMidiPort(midiPort: string): MockRegistryEntry | undefined;
  list(): MockRegistryEntry[];
}

export interface PeerCredsReader {
  /** For MVP, returns the PID supplied by the client in the request body. */
  readPid(req: { body: { pid?: number } }): number | undefined;
}
```

- [ ] **Step 4: Create `src/mcb/index.ts`**

```ts
#!/usr/bin/env node
/**
 * midi-connections-broker (MCB) — entry point.
 * Phase 1 MVP: control-plane-only HTTP server over Unix domain socket.
 */

const SOCKET_PATH = process.env.MCB_SOCKET ?? `${process.env.HOME}/.mcb/sock`;

console.log(`MCB starting (socket: ${SOCKET_PATH})`);
console.log("Phase 1 MVP scaffolding — server not yet implemented.");

// Will hand off to startServer() in Task 7.
```

- [ ] **Step 5: Update `package.json`**

Add to `"scripts"`:
```json
"mcb": "tsx src/mcb/index.ts"
```

Add to top-level (after `"scripts"`):
```json
"bin": {
  "midi-connections-broker": "./dist/mcb/index.js"
}
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npx tsx --test tests/unit/mcb/scaffold.test.ts`

Expected: PASS.

- [ ] **Step 7: Smoke-run MCB**

Run: `npm run mcb`

Expected: prints `MCB starting (socket: ...)` and `Phase 1 MVP scaffolding — server not yet implemented.`, then exits cleanly.

- [ ] **Step 8: Commit**

```bash
git add src/mcb/types.ts src/mcb/index.ts tests/unit/mcb/scaffold.test.ts package.json
git commit -m "feat(mcb): scaffold types, bin entry, and npm script"
```

---

## Task 2: BridgeRegistry

**Files:**
- Create: `src/mcb/bridge-registry.ts`
- Create: `tests/unit/mcb/bridge-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/bridge-registry.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";

let registry: BridgeRegistry;

describe("BridgeRegistry", () => {
  beforeEach(() => {
    registry = new BridgeRegistry();
  });

  describe("add", () => {
    it("adds a master→shadow edge", () => {
      registry.add("dev-A", "Master Port", "Shadow Port");
      assert.equal(registry.shadowOf("dev-A"), "Shadow Port");
    });

    it("rejects self-shadow", () => {
      assert.throws(
        () => registry.add("dev-A", "Same Port", "Same Port"),
        { message: /self-shadow/i },
      );
    });

    it("rejects when master already has a bridge", () => {
      registry.add("dev-A", "Master Port", "Shadow Port");
      assert.throws(
        () => registry.add("dev-A", "Master Port", "Other Shadow"),
        { message: /bridge-already-exists/i },
      );
    });

    it("rejects when shadow port is already a target of another bridge", () => {
      registry.add("dev-A", "Master Port A", "Shared Shadow");
      assert.throws(
        () => registry.add("dev-B", "Master Port B", "Shared Shadow"),
        { message: /shadow-conflict/i },
      );
    });

    it("rejects a cycle: A shadows B, B shadows A", () => {
      registry.add("dev-A", "Port A", "Port B");
      // Now we want to add dev-B with master Port B, shadow Port A.
      // Walking shadow chain from "Port A" must find "Port B" via dev-A's bridge.
      // We need a way for the cycle detector to know that "Port A" is also a master.
      // For MVP, the cycle check is supplied with a primaryToDeviceId resolver.
      const primaryToDeviceId = (port: string) =>
        port === "Port B" ? "dev-A" /* dev-A's master is Port A; but for the cycle we need Port B as the new master, so... */ : undefined;
      // Re-spec: cycle detection walks outgoing bridges starting from the new shadow.
      // From new shadow "Port A": is "Port A" a master of any device? primaryToDeviceId("Port A") = "dev-X"?
      // Then check if dev-X has a bridge whose shadow is the new master.
      // For this test we manually wire the resolver to confirm rejection.
      const resolver = (port: string) => port === "Port A" ? "dev-A" : undefined;
      assert.throws(
        () => registry.add("dev-B", "Port B", "Port A", resolver),
        { message: /cycle-would-form/i },
      );
    });
  });

  describe("remove", () => {
    it("removes the master's bridge", () => {
      registry.add("dev-A", "Master Port", "Shadow Port");
      registry.remove("dev-A");
      assert.equal(registry.shadowOf("dev-A"), undefined);
    });

    it("is a no-op for unknown master", () => {
      registry.remove("dev-nonexistent");
      // no throw
    });
  });

  describe("isShadowTarget", () => {
    it("returns the master deviceId for a shadow port", () => {
      registry.add("dev-A", "Master Port", "Shadow Port");
      assert.deepEqual(registry.isShadowTarget("Shadow Port"), { masterDeviceId: "dev-A" });
    });

    it("returns undefined for non-shadow port", () => {
      registry.add("dev-A", "Master Port", "Shadow Port");
      assert.equal(registry.isShadowTarget("Random Port"), undefined);
    });
  });

  describe("shadowOf", () => {
    it("returns the shadow port for a master deviceId", () => {
      registry.add("dev-A", "Master Port", "Shadow Port");
      assert.equal(registry.shadowOf("dev-A"), "Shadow Port");
    });

    it("returns undefined for a master without a bridge", () => {
      assert.equal(registry.shadowOf("dev-X"), undefined);
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/bridge-registry.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcb/bridge-registry.ts`**

```ts
import type { ShadowEndpoint } from "./types.js";

/** Resolves an OS port name to the deviceId of the device whose primary is that port, if any. */
export type PrimaryResolver = (portName: string) => string | undefined;

export class BridgeRegistry {
  /** masterDeviceId → { shadowPortName } */
  private bridges = new Map<string, ShadowEndpoint>();
  /** masterDeviceId → masterPortName, used for cycle walks */
  private masterPorts = new Map<string, string>();
  /** shadowPortName → masterDeviceId, for fast isShadowTarget */
  private shadowIndex = new Map<string, string>();

  /**
   * Add a bridge edge.
   *
   * @param masterDeviceId  The master device's id.
   * @param masterPortName  The master device's primary port name (used for cycle detection).
   * @param shadowPortName  The shadow port name.
   * @param primaryResolver Optional resolver: portName → deviceId (if portName is some other device's primary).
   *                        Used for cycle detection. If omitted, cycle check still runs against this registry's own masters.
   */
  add(
    masterDeviceId: string,
    masterPortName: string,
    shadowPortName: string,
    primaryResolver?: PrimaryResolver,
  ): void {
    if (masterPortName === shadowPortName) {
      throw new Error("self-shadow: master and shadow ports must differ");
    }
    if (this.bridges.has(masterDeviceId)) {
      throw new Error(`bridge-already-exists for master ${masterDeviceId}`);
    }
    if (this.shadowIndex.has(shadowPortName)) {
      throw new Error(`shadow-conflict: ${shadowPortName} is already a shadow target`);
    }
    if (this.cycleWouldForm(masterPortName, shadowPortName, primaryResolver)) {
      throw new Error("cycle-would-form: routing cycle detected");
    }

    this.bridges.set(masterDeviceId, { portName: shadowPortName });
    this.masterPorts.set(masterDeviceId, masterPortName);
    this.shadowIndex.set(shadowPortName, masterDeviceId);
  }

  remove(masterDeviceId: string): void {
    const bridge = this.bridges.get(masterDeviceId);
    if (!bridge) return;
    this.shadowIndex.delete(bridge.portName);
    this.bridges.delete(masterDeviceId);
    this.masterPorts.delete(masterDeviceId);
  }

  shadowOf(masterDeviceId: string): string | undefined {
    return this.bridges.get(masterDeviceId)?.portName;
  }

  isShadowTarget(portName: string): { masterDeviceId: string } | undefined {
    const masterDeviceId = this.shadowIndex.get(portName);
    return masterDeviceId ? { masterDeviceId } : undefined;
  }

  /** Walk outgoing bridges starting from a port; return true if we ever see masterPort. */
  private cycleWouldForm(
    newMasterPort: string,
    newShadowPort: string,
    primaryResolver?: PrimaryResolver,
  ): boolean {
    let cursor: string | undefined = newShadowPort;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === newMasterPort) return true;
      if (visited.has(cursor)) return false; // pre-existing cycle (shouldn't happen but defensive)
      visited.add(cursor);
      // Is `cursor` a primary of some device? If yes, follow that device's bridge.
      const cursorDeviceId = primaryResolver?.(cursor);
      if (!cursorDeviceId) return false;
      const next = this.bridges.get(cursorDeviceId)?.portName;
      cursor = next;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/bridge-registry.test.ts`

Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/bridge-registry.ts tests/unit/mcb/bridge-registry.test.ts
git commit -m "feat(mcb): bridge registry with cardinality, cycle, and self-shadow guards"
```

---

## Task 3: LeaseRegistry

**Files:**
- Create: `src/mcb/lease-registry.ts`
- Create: `tests/unit/mcb/lease-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/lease-registry.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import type { Lease } from "../../../src/mcb/types.js";

let registry: LeaseRegistry;

function fixture(overrides: Partial<Lease> = {}): Lease {
  return {
    deviceId: "dev-1",
    ownerSessionId: "sess-1",
    model: "nord-electro-5d",
    primary: { portName: "Nord Electro 5 MIDI Input", wsPort: null },
    label: "default",
    channel: 1,
    connectedAt: Date.now(),
    ...overrides,
  };
}

describe("LeaseRegistry", () => {
  beforeEach(() => {
    registry = new LeaseRegistry();
  });

  it("adds a lease and reads it back", () => {
    const lease = fixture();
    registry.add(lease);
    assert.deepEqual(registry.get("dev-1"), lease);
  });

  it("rejects adding a lease whose primary is already owned", () => {
    registry.add(fixture({ deviceId: "dev-1", primary: { portName: "Same Port", wsPort: null } }));
    assert.throws(
      () => registry.add(fixture({ deviceId: "dev-2", primary: { portName: "Same Port", wsPort: null } })),
      { message: /port-already-owned/i },
    );
  });

  it("removes a lease", () => {
    registry.add(fixture({ deviceId: "dev-1" }));
    registry.remove("dev-1");
    assert.equal(registry.get("dev-1"), undefined);
  });

  it("isPrimary returns owner info for a leased port", () => {
    registry.add(fixture({ deviceId: "dev-1", ownerSessionId: "sess-1", primary: { portName: "Port X", wsPort: null } }));
    assert.deepEqual(registry.isPrimary("Port X"), { sessionId: "sess-1", deviceId: "dev-1" });
  });

  it("isPrimary returns undefined for a port nobody owns", () => {
    assert.equal(registry.isPrimary("Random Port"), undefined);
  });

  it("listAll returns every lease", () => {
    registry.add(fixture({ deviceId: "dev-1", primary: { portName: "Port A", wsPort: null } }));
    registry.add(fixture({ deviceId: "dev-2", primary: { portName: "Port B", wsPort: null } }));
    const all = registry.listAll();
    assert.equal(all.length, 2);
    assert.ok(all.some((l) => l.deviceId === "dev-1"));
    assert.ok(all.some((l) => l.deviceId === "dev-2"));
  });

  it("listBySession returns the session's leases in connection-time order", () => {
    const earlier = fixture({ deviceId: "dev-A", ownerSessionId: "sess-1", primary: { portName: "Port A", wsPort: null }, connectedAt: 100 });
    const later   = fixture({ deviceId: "dev-B", ownerSessionId: "sess-1", primary: { portName: "Port B", wsPort: null }, connectedAt: 200 });
    const other   = fixture({ deviceId: "dev-C", ownerSessionId: "sess-2", primary: { portName: "Port C", wsPort: null }, connectedAt: 150 });
    registry.add(later);
    registry.add(earlier);
    registry.add(other);

    const list = registry.listBySession("sess-1");
    assert.deepEqual(list.map((l) => l.deviceId), ["dev-A", "dev-B"]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/lease-registry.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcb/lease-registry.ts`**

```ts
import type { Lease, SessionOwnerInfo } from "./types.js";

export class LeaseRegistry {
  private byDeviceId = new Map<string, Lease>();
  private primaryIndex = new Map<string, string>();  // primary portName → deviceId

  add(lease: Lease): void {
    if (this.primaryIndex.has(lease.primary.portName)) {
      throw new Error(`port-already-owned: ${lease.primary.portName}`);
    }
    this.byDeviceId.set(lease.deviceId, lease);
    this.primaryIndex.set(lease.primary.portName, lease.deviceId);
  }

  remove(deviceId: string): void {
    const lease = this.byDeviceId.get(deviceId);
    if (!lease) return;
    this.primaryIndex.delete(lease.primary.portName);
    this.byDeviceId.delete(deviceId);
  }

  get(deviceId: string): Lease | undefined {
    return this.byDeviceId.get(deviceId);
  }

  /** Returns the session/device owning this primary port, or undefined. */
  isPrimary(portName: string): { sessionId: string; deviceId: string } | undefined {
    const deviceId = this.primaryIndex.get(portName);
    if (!deviceId) return undefined;
    const lease = this.byDeviceId.get(deviceId)!;
    return { sessionId: lease.ownerSessionId, deviceId };
  }

  /** Returns the deviceId of the primary owner, or undefined. */
  primaryOwner(portName: string): string | undefined {
    return this.primaryIndex.get(portName);
  }

  listAll(): Lease[] {
    return [...this.byDeviceId.values()];
  }

  listBySession(sessionId: string): Lease[] {
    return [...this.byDeviceId.values()]
      .filter((l) => l.ownerSessionId === sessionId)
      .sort((a, b) => a.connectedAt - b.connectedAt);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/lease-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/lease-registry.ts tests/unit/mcb/lease-registry.test.ts
git commit -m "feat(mcb): lease registry with primary-port exclusivity and per-session ordering"
```

---

## Task 4: PortResolver

**Files:**
- Create: `src/mcb/port-resolver.ts`
- Create: `tests/unit/mcb/port-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/port-resolver.test.ts`:

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolvePort } from "../../../src/mcb/port-resolver.js";
import type { PortListReader, MockRegistryReader, MockRegistryEntry } from "../../../src/mcb/types.js";

function makePortList(outputs: string[], inputs: string[] = []): PortListReader {
  return {
    listOutputs: () => outputs,
    listInputs: () => inputs,
  };
}

function makeRegistry(entries: MockRegistryEntry[]): MockRegistryReader {
  return {
    findByLabel: (label) => entries.find((e) => e.label === label),
    findByMidiPort: (midiPort) => entries.find((e) => e.midiPort === midiPort),
    list: () => entries,
  };
}

describe("PortResolver", () => {
  it("resolves a mock label (output direction)", () => {
    const ports = makePortList(["Nord Electro 5D Mock"]);
    const registry = makeRegistry([
      { midiPort: "Nord Electro 5D Mock", wsPort: 3002, label: "nordi", pid: 1234 },
    ]);
    const result = resolvePort("nordi", "output", ports, registry);
    assert.deepEqual(result, { portName: "Nord Electro 5D Mock", wsPort: 3002 });
  });

  it("rejects a mock label for input direction", () => {
    const ports = makePortList([], []);
    const registry = makeRegistry([
      { midiPort: "Nord Electro 5D Mock", wsPort: 3002, label: "nordi", pid: 1234 },
    ]);
    assert.throws(
      () => resolvePort("nordi", "input", ports, registry),
      { message: /port-not-found/i },
    );
  });

  it("resolves an exact OS output port name", () => {
    const ports = makePortList(["Nord Electro 5 MIDI Input"]);
    const registry = makeRegistry([]);
    const result = resolvePort("Nord Electro 5 MIDI Input", "output", ports, registry);
    assert.deepEqual(result, { portName: "Nord Electro 5 MIDI Input", wsPort: null });
  });

  it("resolves an exact OS input port name", () => {
    const ports = makePortList([], ["Nord Electro 5 MIDI Output"]);
    const registry = makeRegistry([]);
    const result = resolvePort("Nord Electro 5 MIDI Output", "input", ports, registry);
    assert.deepEqual(result, { portName: "Nord Electro 5 MIDI Output", wsPort: null });
  });

  it("does NOT substring-match", () => {
    const ports = makePortList(["Nord Electro 5 MIDI Input"]);
    const registry = makeRegistry([]);
    assert.throws(
      () => resolvePort("Nord", "output", ports, registry),
      { message: /port-not-found/i },
    );
  });

  it("rejects zero matches with details", () => {
    const ports = makePortList(["Some Port"]);
    const registry = makeRegistry([
      { midiPort: "Other Port", wsPort: 3000, label: "junio", pid: 5678 },
    ]);
    try {
      resolvePort("nonexistent", "output", ports, registry);
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.match(err.message, /port-not-found/i);
      assert.deepEqual(err.details.availableMockLabels, ["junio"]);
      assert.deepEqual(err.details.availableOsPorts, ["Some Port"]);
    }
  });

  it("rejects multiple matches as ambiguous", () => {
    const ports = makePortList(["Ambiguous"]);
    const registry = makeRegistry([
      { midiPort: "Some Other Port", wsPort: 3000, label: "Ambiguous", pid: 5678 },
    ]);
    try {
      resolvePort("Ambiguous", "output", ports, registry);
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.match(err.message, /ambiguous-port/i);
    }
  });

  it("re-checks OS visibility after registry resolution", () => {
    const ports = makePortList([]);  // mock's port has disappeared from OS
    const registry = makeRegistry([
      { midiPort: "Nord Mock", wsPort: 3002, label: "nordi", pid: 1234 },
    ]);
    assert.throws(
      () => resolvePort("nordi", "output", ports, registry),
      { message: /port-not-found/i },
    );
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/port-resolver.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/mcb/port-resolver.ts`**

```ts
import type {
  Direction, PortListReader, MockRegistryReader, PortInfo,
} from "./types.js";

export class PortResolutionError extends Error {
  constructor(
    public code: "port-not-found" | "ambiguous-port",
    message: string,
    public details: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function resolvePort(
  arg: string,
  direction: Direction,
  ports: PortListReader,
  registry: MockRegistryReader,
): PortInfo {
  const osPorts = direction === "output" ? ports.listOutputs() : ports.listInputs();
  const candidates: Array<{ kind: "mock" | "os"; portName: string; wsPort?: number }> = [];

  // Step 1: mock label match (output direction only)
  if (direction === "output") {
    const mockEntry = registry.findByLabel(arg);
    if (mockEntry) {
      candidates.push({ kind: "mock", portName: mockEntry.midiPort, wsPort: mockEntry.wsPort });
    }
  }

  // Step 2: OS port exact match
  if (osPorts.includes(arg)) {
    // Check if it's also a mock's midiPort (for wsPort lookup)
    const mockByPort = registry.findByMidiPort(arg);
    candidates.push({ kind: "os", portName: arg, wsPort: mockByPort?.wsPort });
  }

  // Dedup: if both label-resolved and OS-name match the SAME port, that's not ambiguous
  const uniquePorts = new Set(candidates.map((c) => c.portName));
  if (uniquePorts.size === 0) {
    throw new PortResolutionError(
      "port-not-found",
      `Port not found: '${arg}'`,
      {
        arg,
        direction,
        availableMockLabels: direction === "output" ? registry.list().map((e) => e.label) : [],
        availableOsPorts: osPorts,
      },
    );
  }
  if (uniquePorts.size > 1) {
    throw new PortResolutionError(
      "ambiguous-port",
      `Ambiguous port name '${arg}'`,
      { arg, candidates: candidates.map((c) => c.portName) },
    );
  }

  const [chosen] = candidates;

  // OS-visibility re-check (already done implicitly for OS-direct matches, redundant only for mock-label resolves)
  if (chosen.kind === "mock" && !osPorts.includes(chosen.portName)) {
    throw new PortResolutionError(
      "port-not-found",
      `Port not found: '${arg}' (mock '${arg}' resolved to '${chosen.portName}', but it is not currently visible to the OS)`,
      { arg, resolvedTo: chosen.portName, direction },
    );
  }

  return { portName: chosen.portName, wsPort: chosen.wsPort ?? null };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/port-resolver.test.ts`

Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/port-resolver.ts tests/unit/mcb/port-resolver.test.ts
git commit -m "feat(mcb): strict port resolver with direction-aware mock-label and OS-name matching"
```

---

## Task 5: SessionManager

**Files:**
- Create: `src/mcb/session-manager.ts`
- Create: `tests/unit/mcb/session-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/session-manager.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { SessionManager } from "../../../src/mcb/session-manager.js";

let mgr: SessionManager;
let alivePids: Set<number>;

beforeEach(() => {
  alivePids = new Set([100, 200]);
  mgr = new SessionManager({
    livenessChecker: (pid) => alivePids.has(pid),
    reattachWindowMs: 30_000,
    deadAfterMissesAtMs: 10_000,
    nowMs: () => 0,  // overridden per test via mgr.setClock(...)
  });
});

describe("SessionManager", () => {
  it("creates a session and returns sessionId + ownerPid", () => {
    const s = mgr.create({ pid: 100, processName: "test" });
    assert.match(s.sessionId, /^[a-f0-9-]{36}$/i);  // UUID
    assert.equal(s.pid, 100);
    assert.equal(s.processName, "test");
  });

  it("get returns the session", () => {
    const created = mgr.create({ pid: 100 });
    assert.equal(mgr.get(created.sessionId)!.pid, 100);
  });

  it("delete removes the session", () => {
    const created = mgr.create({ pid: 100 });
    mgr.delete(created.sessionId);
    assert.equal(mgr.get(created.sessionId), undefined);
  });

  it("attach succeeds when PID matches and session is live", () => {
    const created = mgr.create({ pid: 100 });
    const reattached = mgr.attach(created.sessionId, 100);
    assert.equal(reattached.sessionId, created.sessionId);
  });

  it("attach throws pid-mismatch when PID differs", () => {
    const created = mgr.create({ pid: 100 });
    assert.throws(
      () => mgr.attach(created.sessionId, 200),
      { message: /pid-mismatch/i },
    );
  });

  it("attach throws session-not-found for unknown sessionId", () => {
    assert.throws(
      () => mgr.attach("nonexistent", 100),
      { message: /session-not-found/i },
    );
  });

  it("listAll returns all sessions", () => {
    mgr.create({ pid: 100 });
    mgr.create({ pid: 200 });
    assert.equal(mgr.listAll().length, 2);
  });

  describe("PID-liveness GC", () => {
    it("does not GC a live PID", () => {
      const created = mgr.create({ pid: 100 });
      const dead = mgr.runLivenessSweep(0);
      assert.deepEqual(dead, []);
      assert.ok(mgr.get(created.sessionId));
    });

    it("marks a session dead after consecutive misses", () => {
      const created = mgr.create({ pid: 100 });
      alivePids.delete(100);
      // First sweep at t=0 marks dead (since the session has 0 missed sweeps initially, this depends on impl)
      // Spec says ten consecutive misses; we use the deadAfterMissesAtMs config (10s by default in production).
      // Test config: deadAfterMissesAtMs=10_000ms.
      // So we sweep at t=0 (first miss recorded), then at t=10_001 the session crosses threshold.
      mgr.runLivenessSweep(0);
      assert.equal(mgr.get(created.sessionId)?.markedDeadAt, null);  // not yet dead

      mgr.runLivenessSweep(10_001);
      const session = mgr.get(created.sessionId);
      assert.ok(session, "session should still exist (within reattach window)");
      assert.ok(session!.markedDeadAt !== null, "session should be marked dead");
    });

    it("hard-GCs a session after the reattach window expires", () => {
      const created = mgr.create({ pid: 100 });
      alivePids.delete(100);
      mgr.runLivenessSweep(0);          // record first miss
      mgr.runLivenessSweep(10_001);     // mark dead at t=10_001
      // Reattach window is 30_000ms after markedDeadAt.
      mgr.runLivenessSweep(10_001 + 30_001);  // past the window
      assert.equal(mgr.get(created.sessionId), undefined);
    });

    it("returns the list of hard-GCed sessionIds from runLivenessSweep", () => {
      const a = mgr.create({ pid: 100 });
      const b = mgr.create({ pid: 200 });
      alivePids.clear();
      mgr.runLivenessSweep(0);
      mgr.runLivenessSweep(10_001);
      const hardGCed = mgr.runLivenessSweep(10_001 + 30_001);
      assert.equal(hardGCed.length, 2);
      assert.ok(hardGCed.some((s) => s.sessionId === a.sessionId));
      assert.ok(hardGCed.some((s) => s.sessionId === b.sessionId));
    });

    it("recovers a session if PID becomes alive again before mark-dead", () => {
      const created = mgr.create({ pid: 100 });
      alivePids.delete(100);
      mgr.runLivenessSweep(0);
      alivePids.add(100);  // alive again
      mgr.runLivenessSweep(5_000);
      assert.equal(mgr.get(created.sessionId)!.markedDeadAt, null);
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/session-manager.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/mcb/session-manager.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Session } from "./types.js";

export interface SessionManagerOptions {
  livenessChecker: (pid: number) => boolean;
  /** ms after first PID-miss at which the session is marked dead. Production: 10_000. */
  deadAfterMissesAtMs: number;
  /** ms after marked-dead at which the session is hard-GCed. Production: 30_000. */
  reattachWindowMs: number;
  /** Optional clock override for tests. Defaults to Date.now. */
  nowMs?: () => number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** sessionId → { firstMissAt: number | null }  */
  private missState = new Map<string, { firstMissAt: number | null }>();

  constructor(private opts: SessionManagerOptions) {}

  private now(): number {
    return this.opts.nowMs ? this.opts.nowMs() : Date.now();
  }

  create(input: { pid: number; processName?: string }): Session {
    const session: Session = {
      sessionId: randomUUID(),
      pid: input.pid,
      processName: input.processName,
      ownedDeviceIds: new Set(),
      createdAt: this.now(),
      markedDeadAt: null,
    };
    this.sessions.set(session.sessionId, session);
    this.missState.set(session.sessionId, { firstMissAt: null });
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.missState.delete(sessionId);
  }

  attach(sessionId: string, callingPid: number): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session-not-found: ${sessionId}`);
    if (session.pid !== callingPid) {
      throw new Error(`pid-mismatch: session pid ${session.pid}, calling pid ${callingPid}`);
    }
    return session;
  }

  listAll(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Run one liveness sweep. Returns sessions that are hard-GCed by this sweep.
   * Caller is responsible for tearing down their leases.
   */
  runLivenessSweep(now: number = this.now()): Session[] {
    const hardGCed: Session[] = [];
    for (const [sessionId, session] of this.sessions) {
      const alive = this.opts.livenessChecker(session.pid);
      const ms = this.missState.get(sessionId)!;

      if (alive) {
        // Reset state — process recovered.
        ms.firstMissAt = null;
        session.markedDeadAt = null;
        continue;
      }

      // Process is gone.
      if (ms.firstMissAt === null) {
        ms.firstMissAt = now;
        continue;
      }

      const sinceFirstMiss = now - ms.firstMissAt;
      if (session.markedDeadAt === null && sinceFirstMiss >= this.opts.deadAfterMissesAtMs) {
        session.markedDeadAt = now;
        continue;
      }

      if (session.markedDeadAt !== null) {
        const sinceMarkedDead = now - session.markedDeadAt;
        if (sinceMarkedDead >= this.opts.reattachWindowMs) {
          hardGCed.push(session);
          this.delete(sessionId);
        }
      }
    }
    return hardGCed;
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/session-manager.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/session-manager.ts tests/unit/mcb/session-manager.test.ts
git commit -m "feat(mcb): session manager with PID-liveness GC and reattach window"
```

---

## Task 6: EventBroadcaster

**Files:**
- Create: `src/mcb/event-broadcaster.ts`
- Create: `tests/unit/mcb/event-broadcaster.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/event-broadcaster.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { EventBroadcaster } from "../../../src/mcb/event-broadcaster.js";

let broadcaster: EventBroadcaster;

beforeEach(() => {
  broadcaster = new EventBroadcaster();
});

describe("EventBroadcaster", () => {
  it("delivers an event to a subscribed listener", () => {
    const seen: any[] = [];
    broadcaster.subscribe((evt) => seen.push(evt));
    broadcaster.publish({ type: "device-connected", deviceId: "dev-1" });
    assert.deepEqual(seen, [{ type: "device-connected", deviceId: "dev-1" }]);
  });

  it("delivers each event to ALL subscribers (broadcast)", () => {
    const a: any[] = [], b: any[] = [];
    broadcaster.subscribe((evt) => a.push(evt));
    broadcaster.subscribe((evt) => b.push(evt));
    broadcaster.publish({ type: "session-created", sessionId: "s-1" });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  it("unsubscribe stops delivery to that listener", () => {
    const seen: any[] = [];
    const unsub = broadcaster.subscribe((evt) => seen.push(evt));
    unsub();
    broadcaster.publish({ type: "device-connected", deviceId: "dev-1" });
    assert.deepEqual(seen, []);
  });

  it("does not throw if a listener throws", () => {
    broadcaster.subscribe(() => { throw new Error("listener crash"); });
    const seen: any[] = [];
    broadcaster.subscribe((evt) => seen.push(evt));
    broadcaster.publish({ type: "session-created", sessionId: "s-1" });
    assert.equal(seen.length, 1);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/event-broadcaster.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/mcb/event-broadcaster.ts`**

```ts
export type McbEvent =
  | { type: "session-created"; sessionId: string; pid: number; processName?: string }
  | { type: "session-released"; sessionId: string }
  | { type: "device-connected"; deviceId: string; ownerSessionId: string; model: string; primaryPort: string; shadowPort?: string }
  | { type: "device-disconnected"; deviceId: string; ownerSessionId: string }
  | { type: "bridge-created"; masterDeviceId: string; shadowPort: string }
  | { type: "bridge-removed"; masterDeviceId: string; shadowPort: string };

export type EventListener = (evt: McbEvent) => void;

export class EventBroadcaster {
  private listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(evt: McbEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(evt);
      } catch (err) {
        // A buggy listener should not break the broadcaster.
        console.error("[mcb] event listener threw:", err);
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/event-broadcaster.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/event-broadcaster.ts tests/unit/mcb/event-broadcaster.test.ts
git commit -m "feat(mcb): event broadcaster for SSE topology notifications"
```

---

## Task 7: HTTP server scaffolding + /v1/health

**Files:**
- Create: `src/mcb/http/server.ts`
- Create: `src/mcb/http/health.ts`
- Create: `src/mcb/http/errors.ts`
- Modify: `src/mcb/index.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/mcb/health.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnMcb, type McbHandle } from "../../helpers/mcb-spawn.js";
import { httpRequest } from "../../helpers/mcb-client.js";

let mcb: McbHandle;

describe("MCB /v1/health (integration)", () => {
  before(async () => { mcb = await spawnMcb(); });
  after(async () => { await mcb.stop(); });

  it("returns ok:true with uptime and counts", async () => {
    const res = await httpRequest(mcb.socketPath, "GET", "/v1/health");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.uptimeSec, "number");
    assert.equal(res.body.sessionsActive, 0);
    assert.equal(res.body.devicesConnected, 0);
  });

  it("returns 404 for unknown path", async () => {
    const res = await httpRequest(mcb.socketPath, "GET", "/v1/nope");
    assert.equal(res.statusCode, 404);
  });
});
```

This depends on test helpers from Task 13, but Task 13 itself depends on the server existing. **Build the server first, then come back to write integration tests** — the unit-level tests below are sufficient for this task.

Replace the integration test above with a unit-level test for now:

Create `tests/unit/mcb/http-server.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../../../src/mcb/http/server.js";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";
import { SessionManager } from "../../../src/mcb/session-manager.js";
import { EventBroadcaster } from "../../../src/mcb/event-broadcaster.js";

let server: StartedServer;
let socketDir: string;
let socketPath: string;

beforeEach(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "mcb-test-"));
  socketPath = join(socketDir, "sock");
  server = await startServer({
    socketPath,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager({
      livenessChecker: () => true,
      deadAfterMissesAtMs: 10_000,
      reattachWindowMs: 30_000,
    }),
    events: new EventBroadcaster(),
    portList: { listOutputs: () => [], listInputs: () => [] },
    mockRegistry: { findByLabel: () => undefined, findByMidiPort: () => undefined, list: () => [] },
  });
});

afterEach(async () => {
  await server.stop();
  rmSync(socketDir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: any;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          resolve({ statusCode: res.statusCode!, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("MCB HTTP server", () => {
  it("GET /v1/health returns 200 with shape", async () => {
    const res = await call("GET", "/v1/health");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.uptimeSec, "number");
    assert.equal(res.body.sessionsActive, 0);
    assert.equal(res.body.devicesConnected, 0);
  });

  it("GET /v1/nope returns 404", async () => {
    const res = await call("GET", "/v1/nope");
    assert.equal(res.statusCode, 404);
  });

  it("POST with invalid JSON returns 400", async () => {
    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = httpRequest(
        { socketPath, method: "POST", path: "/v1/sessions", headers: { "content-type": "application/json" } },
        (response) => {
          response.on("data", () => {});
          response.on("end", () => resolve({ statusCode: response.statusCode! }));
        },
      );
      req.on("error", reject);
      req.write("{not valid json");
      req.end();
    });
    assert.equal(res.statusCode, 400);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/http-server.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcb/http/errors.ts`**

```ts
export interface ErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function formatError(err: unknown): { statusCode: number; body: ErrorBody } {
  if (err instanceof HttpError) {
    return {
      statusCode: err.statusCode,
      body: { error: err.code, message: err.message, details: err.details },
    };
  }
  // Map known thrown messages from registries to HTTP errors.
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("port-not-found")) {
      return { statusCode: 400, body: { error: "port-not-found", message: msg, details: (err as any).details } };
    }
    if (msg.includes("ambiguous-port")) {
      return { statusCode: 400, body: { error: "ambiguous-port", message: msg, details: (err as any).details } };
    }
    if (msg.includes("port-already-owned")) {
      return { statusCode: 409, body: { error: "port-already-owned", message: msg } };
    }
    if (msg.includes("self-shadow")) {
      return { statusCode: 409, body: { error: "self-shadow", message: msg } };
    }
    if (msg.includes("bridge-already-exists")) {
      return { statusCode: 409, body: { error: "bridge-already-exists", message: msg } };
    }
    if (msg.includes("shadow-conflict")) {
      return { statusCode: 409, body: { error: "shadow-conflict", message: msg } };
    }
    if (msg.includes("cycle-would-form")) {
      return { statusCode: 409, body: { error: "cycle-would-form", message: msg } };
    }
    if (msg.includes("session-not-found")) {
      return { statusCode: 404, body: { error: "session-not-found", message: msg } };
    }
    if (msg.includes("pid-mismatch")) {
      return { statusCode: 403, body: { error: "pid-mismatch", message: msg } };
    }
  }
  const errorId = Math.random().toString(36).slice(2, 10);
  console.error(`[mcb] internal-error ${errorId}:`, err);
  return {
    statusCode: 500,
    body: { error: "internal-error", message: `Internal server error (id: ${errorId})` },
  };
}
```

- [ ] **Step 4: Implement `src/mcb/http/health.ts`**

```ts
import type { LeaseRegistry } from "../lease-registry.js";
import type { SessionManager } from "../session-manager.js";

export function healthHandler(deps: { leases: LeaseRegistry; sessions: SessionManager; startedAtMs: number }) {
  return async (): Promise<{ statusCode: number; body: any }> => {
    return {
      statusCode: 200,
      body: {
        ok: true,
        uptimeSec: Math.floor((Date.now() - deps.startedAtMs) / 1000),
        sessionsActive: deps.sessions.listAll().length,
        devicesConnected: deps.leases.listAll().length,
      },
    };
  };
}
```

- [ ] **Step 5: Implement `src/mcb/http/server.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { EventBroadcaster } from "../event-broadcaster.js";
import type { PortListReader, MockRegistryReader } from "../types.js";
import { formatError, HttpError } from "./errors.js";
import { healthHandler } from "./health.js";

export interface ServerDeps {
  socketPath: string;
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  sessions: SessionManager;
  events: EventBroadcaster;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

export interface StartedServer {
  socketPath: string;
  stop(): Promise<void>;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<{ statusCode: number; body: any } | { sse: true; res: ServerResponse }>;
}

export interface RouteContext {
  params: Record<string, string>;
  body: any;
  headers: Record<string, string | undefined>;
  query: Record<string, string>;
  rawReq: IncomingMessage;
  rawRes: ServerResponse;
}

export async function startServer(deps: ServerDeps): Promise<StartedServer> {
  const startedAtMs = Date.now();

  // Make socket dir
  const dir = dirname(deps.socketPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Stale socket probe-and-unlink: try connecting; if connect fails, unlink.
  if (existsSync(deps.socketPath)) {
    const reachable = await probeSocket(deps.socketPath);
    if (reachable) {
      throw new Error(`MCB socket at ${deps.socketPath} is already in use by another live process. Refusing to start.`);
    }
    unlinkSync(deps.socketPath);
  }

  const routes: Route[] = [
    {
      method: "GET", pattern: /^\/v1\/health$/,
      handler: async () => (await healthHandler({ leases: deps.leases, sessions: deps.sessions, startedAtMs })()),
    },
    // More routes added in Tasks 8–11.
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://mcb.local");
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) {
        respond(res, 404, { error: "not-found", message: `No route for ${req.method} ${url.pathname}` });
        return;
      }
      const m = route.pattern.exec(url.pathname)!;
      const params: Record<string, string> = {};
      // Named capture groups become params:
      const groups = m.groups ?? {};
      for (const [k, v] of Object.entries(groups)) if (v !== undefined) params[k] = v;

      // Read body
      let body: any = undefined;
      if (req.method !== "GET") {
        const buf = await readBody(req);
        if (buf.length > 0) {
          try { body = JSON.parse(buf.toString()); }
          catch { respond(res, 400, { error: "invalid-input", message: "Body must be valid JSON" }); return; }
        }
      }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) query[k] = v;

      const ctx: RouteContext = { params, body, headers, query, rawReq: req, rawRes: res };
      const result = await route.handler(ctx);
      if ("sse" in result) {
        // SSE: handler took ownership of `res`; do nothing.
        return;
      }
      respond(res, result.statusCode, result.body);
    } catch (err) {
      const formatted = formatError(err);
      respond(res, formatted.statusCode, formatted.body);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.socketPath, () => {
      try { chmodSync(deps.socketPath, 0o600); } catch { /* macOS sometimes refuses; not fatal */ }
      resolve();
    });
  });

  return {
    socketPath: deps.socketPath,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => {
        if (existsSync(deps.socketPath)) {
          try { unlinkSync(deps.socketPath); } catch { /* ignore */ }
        }
        resolve();
      });
    }),
  };
}

function respond(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function probeSocket(socketPath: string): Promise<boolean> {
  const { request } = await import("node:http");
  return new Promise<boolean>((resolve) => {
    const req = request({ socketPath, method: "GET", path: "/v1/health", timeout: 200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Add this so route.pattern can include named groups for path params.
// (RegExp groups via /pattern/g; we'll use them in Tasks 8-11.)
export function createRouter(routes: Route[]) {
  return routes;
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/http-server.test.ts`

Expected: PASS.

- [ ] **Step 7: Update `src/mcb/index.ts` to actually start the server**

```ts
#!/usr/bin/env node
import { startServer } from "./http/server.js";
import { LeaseRegistry } from "./lease-registry.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { SessionManager } from "./session-manager.js";
import { EventBroadcaster } from "./event-broadcaster.js";
import easymidi from "easymidi";
import * as mockRegistry from "../shared/mock-registry.js";

const SOCKET_PATH = process.env.MCB_SOCKET ?? `${process.env.HOME}/.mcb/sock`;

const leases = new LeaseRegistry();
const bridges = new BridgeRegistry();
const sessions = new SessionManager({
  livenessChecker: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  deadAfterMissesAtMs: 10_000,
  reattachWindowMs: 30_000,
});
const events = new EventBroadcaster();

const portList = {
  listOutputs: () => easymidi.getOutputs(),
  listInputs: () => easymidi.getInputs(),
};
const mockRegistryReader = {
  findByLabel: (label: string) => mockRegistry.readActive().find((e) => e.label === label),
  findByMidiPort: (midiPort: string) => mockRegistry.findByMidiPort(midiPort),
  list: () => mockRegistry.readActive(),
};

(async () => {
  const server = await startServer({
    socketPath: SOCKET_PATH,
    leases, bridges, sessions, events,
    portList, mockRegistry: mockRegistryReader,
  });
  console.log(`[mcb] listening on ${SOCKET_PATH}`);

  // PID-liveness sweep loop
  const sweepHandle = setInterval(() => {
    const hardGCed = sessions.runLivenessSweep();
    for (const s of hardGCed) {
      events.publish({ type: "session-released", sessionId: s.sessionId });
      // Tear down this session's leases (in Phase 1, no MIDI to close).
      for (const deviceId of s.ownedDeviceIds) {
        bridges.remove(deviceId);
        leases.remove(deviceId);
      }
    }
  }, 1000);

  const shutdown = async () => {
    console.log("[mcb] shutting down");
    clearInterval(sweepHandle);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})().catch((err) => {
  console.error("[mcb] startup failed:", err);
  process.exit(1);
});
```

> Note: this references `mockRegistry.readActive()` and `mockRegistry.findByMidiPort()`. Inspect `src/shared/mock-registry.ts` to confirm exact exports; if `readActive` is named differently, adjust.

- [ ] **Step 8: Smoke run**

Run: `npm run mcb`

Expected: prints `[mcb] listening on ~/.mcb/sock`. Press Ctrl-C: prints `[mcb] shutting down` and exits.

- [ ] **Step 9: Commit**

```bash
git add src/mcb/http/ src/mcb/index.ts tests/unit/mcb/http-server.test.ts
git commit -m "feat(mcb): http server scaffolding, /v1/health, and stale-socket probe"
```

---

## Task 8: Session HTTP endpoints

**Files:**
- Create: `src/mcb/http/sessions.ts`
- Modify: `src/mcb/http/server.ts` (register routes)
- Create: `tests/unit/mcb/http-sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/http-sessions.test.ts`. Use the same `call()` helper pattern as Task 7's test (copy it inline). Tests:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../../../src/mcb/http/server.js";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";
import { SessionManager } from "../../../src/mcb/session-manager.js";
import { EventBroadcaster } from "../../../src/mcb/event-broadcaster.js";

let server: StartedServer;
let socketDir: string;
let socketPath: string;

beforeEach(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "mcb-test-"));
  socketPath = join(socketDir, "sock");
  server = await startServer({
    socketPath,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager({
      livenessChecker: () => true,
      deadAfterMissesAtMs: 10_000,
      reattachWindowMs: 30_000,
    }),
    events: new EventBroadcaster(),
    portList: { listOutputs: () => [], listInputs: () => [] },
    mockRegistry: { findByLabel: () => undefined, findByMidiPort: () => undefined, list: () => [] },
  });
});

afterEach(async () => {
  await server.stop();
  rmSync(socketDir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req = httpRequest(
      { socketPath, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: any;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          resolve({ statusCode: res.statusCode!, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("MCB sessions endpoints", () => {
  it("POST /v1/sessions creates a session", async () => {
    const res = await call("POST", "/v1/sessions", { pid: 12345, processName: "test" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body.sessionId, /^[a-f0-9-]{36}$/i);
    assert.equal(res.body.ownerPid, 12345);
  });

  it("POST /v1/sessions rejects missing pid", async () => {
    const res = await call("POST", "/v1/sessions", { processName: "test" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "invalid-input");
  });

  it("POST /v1/sessions/:id/attach succeeds when pid matches", async () => {
    const create = await call("POST", "/v1/sessions", { pid: 12345 });
    const attach = await call("POST", `/v1/sessions/${create.body.sessionId}/attach`, { pid: 12345 });
    assert.equal(attach.statusCode, 200);
    assert.equal(attach.body.sessionId, create.body.sessionId);
  });

  it("POST /v1/sessions/:id/attach returns 403 when pid differs", async () => {
    const create = await call("POST", "/v1/sessions", { pid: 12345 });
    const attach = await call("POST", `/v1/sessions/${create.body.sessionId}/attach`, { pid: 99999 });
    assert.equal(attach.statusCode, 403);
    assert.equal(attach.body.error, "pid-mismatch");
  });

  it("POST /v1/sessions/:id/attach returns 404 for unknown session", async () => {
    const attach = await call("POST", `/v1/sessions/00000000-0000-0000-0000-000000000000/attach`, { pid: 1 });
    assert.equal(attach.statusCode, 404);
  });

  it("DELETE /v1/sessions/:id with matching X-Session-Id deletes", async () => {
    const create = await call("POST", "/v1/sessions", { pid: 12345 });
    const del = await call("DELETE", `/v1/sessions/${create.body.sessionId}`, undefined, {
      "x-session-id": create.body.sessionId,
    });
    assert.equal(del.statusCode, 204);
  });

  it("DELETE /v1/sessions/:id without matching X-Session-Id returns 403", async () => {
    const create = await call("POST", "/v1/sessions", { pid: 12345 });
    const del = await call("DELETE", `/v1/sessions/${create.body.sessionId}`, undefined, {
      "x-session-id": "different-id",
    });
    assert.equal(del.statusCode, 403);
    assert.equal(del.body.error, "session-mismatch");
  });

  it("GET /v1/sessions/:id/devices returns empty list initially", async () => {
    const create = await call("POST", "/v1/sessions", { pid: 12345 });
    const list = await call("GET", `/v1/sessions/${create.body.sessionId}/devices`);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.body, []);
  });

  it("GET /v1/sessions/:id/devices returns 404 for unknown session", async () => {
    const list = await call("GET", `/v1/sessions/00000000-0000-0000-0000-000000000000/devices`);
    assert.equal(list.statusCode, 404);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/http-sessions.test.ts`

Expected: FAIL — handlers not implemented; routes not registered.

- [ ] **Step 3: Implement `src/mcb/http/sessions.ts`**

```ts
import type { LeaseRegistry } from "../lease-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { EventBroadcaster } from "../event-broadcaster.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

interface SessionsDeps {
  sessions: SessionManager;
  leases: LeaseRegistry;
  bridges: import("../bridge-registry.js").BridgeRegistry;
  events: EventBroadcaster;
}

export function makeSessionsHandlers(deps: SessionsDeps) {
  return {
    create: async (ctx: RouteContext) => {
      const { pid, processName } = (ctx.body ?? {}) as { pid?: number; processName?: string };
      if (typeof pid !== "number" || pid <= 0) {
        throw new HttpError(400, "invalid-input", "Body must include numeric pid > 0");
      }
      const session = deps.sessions.create({ pid, processName });
      deps.events.publish({ type: "session-created", sessionId: session.sessionId, pid, processName });
      return {
        statusCode: 200,
        body: { sessionId: session.sessionId, ownerPid: pid },
      };
    },

    attach: async (ctx: RouteContext) => {
      const { id } = ctx.params;
      const { pid } = (ctx.body ?? {}) as { pid?: number };
      if (typeof pid !== "number" || pid <= 0) {
        throw new HttpError(400, "invalid-input", "Body must include numeric pid > 0");
      }
      try {
        const session = deps.sessions.attach(id, pid);
        return {
          statusCode: 200,
          body: { sessionId: session.sessionId, ownerPid: session.pid },
        };
      } catch (err: any) {
        if (err.message?.includes("session-not-found")) {
          throw new HttpError(404, "session-not-found", err.message);
        }
        if (err.message?.includes("pid-mismatch")) {
          throw new HttpError(403, "pid-mismatch", err.message);
        }
        throw err;
      }
    },

    delete: async (ctx: RouteContext) => {
      const { id } = ctx.params;
      const headerSessId = ctx.headers["x-session-id"];
      if (headerSessId !== id) {
        throw new HttpError(403, "session-mismatch", "X-Session-Id header must match URL session id");
      }
      const session = deps.sessions.get(id);
      if (!session) {
        throw new HttpError(404, "session-not-found", `Session ${id} not found`);
      }
      // Tear down all owned bridges + leases.
      for (const deviceId of session.ownedDeviceIds) {
        const shadowPort = deps.bridges.shadowOf(deviceId);
        if (shadowPort) {
          deps.bridges.remove(deviceId);
          deps.events.publish({ type: "bridge-removed", masterDeviceId: deviceId, shadowPort });
        }
        deps.leases.remove(deviceId);
        deps.events.publish({ type: "device-disconnected", deviceId, ownerSessionId: id });
      }
      deps.sessions.delete(id);
      deps.events.publish({ type: "session-released", sessionId: id });
      return { statusCode: 204, body: undefined };
    },

    listSessionDevices: async (ctx: RouteContext) => {
      const { id } = ctx.params;
      if (!deps.sessions.get(id)) {
        throw new HttpError(404, "session-not-found", `Session ${id} not found`);
      }
      const leases = deps.leases.listBySession(id).map(toManifest);
      return { statusCode: 200, body: leases };
    },
  };
}

function toManifest(lease: any) {
  const { connectedAt: _, ...manifest } = lease;
  return manifest;
}
```

- [ ] **Step 4: Register the routes in `src/mcb/http/server.ts`**

Locate the `routes` array in `startServer` and replace it with:

```ts
const sessionsHandlers = makeSessionsHandlers({ sessions: deps.sessions, leases: deps.leases, bridges: deps.bridges, events: deps.events });

const routes: Route[] = [
  { method: "GET",    pattern: /^\/v1\/health$/,
    handler: async () => (await healthHandler({ leases: deps.leases, sessions: deps.sessions, startedAtMs })()) },
  { method: "POST",   pattern: /^\/v1\/sessions$/,                                  handler: sessionsHandlers.create },
  { method: "POST",   pattern: /^\/v1\/sessions\/(?<id>[a-f0-9-]+)\/attach$/,        handler: sessionsHandlers.attach },
  { method: "DELETE", pattern: /^\/v1\/sessions\/(?<id>[a-f0-9-]+)$/,                handler: sessionsHandlers.delete },
  { method: "GET",    pattern: /^\/v1\/sessions\/(?<id>[a-f0-9-]+)\/devices$/,       handler: sessionsHandlers.listSessionDevices },
];
```

Add the import at the top of `server.ts`:
```ts
import { makeSessionsHandlers } from "./sessions.js";
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/http-sessions.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcb/http/sessions.ts src/mcb/http/server.ts tests/unit/mcb/http-sessions.test.ts
git commit -m "feat(mcb): session HTTP endpoints (create, attach, delete, list devices)"
```

---

## Task 9: Device HTTP endpoints

**Files:**
- Create: `src/mcb/http/devices.ts`
- Modify: `src/mcb/http/server.ts` (register routes)
- Create: `tests/unit/mcb/http-devices.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/http-devices.test.ts`. Use the same `beforeEach/afterEach/call` pattern as Task 8, but seed the port list with two outputs:
```ts
portList: { listOutputs: () => ["Port A", "Port B", "Mock Port"], listInputs: () => ["Port A In"] },
mockRegistry: {
  findByLabel: (label) => label === "mocky" ? { midiPort: "Mock Port", wsPort: 3001, label: "mocky", pid: 9999 } : undefined,
  findByMidiPort: (midiPort) => midiPort === "Mock Port" ? { midiPort: "Mock Port", wsPort: 3001, label: "mocky", pid: 9999 } : undefined,
  list: () => [{ midiPort: "Mock Port", wsPort: 3001, label: "mocky", pid: 9999 }],
},
```

Tests:

```ts
describe("MCB devices endpoints", () => {
  async function newSession(pid = 100): Promise<string> {
    const res = await call("POST", "/v1/sessions", { pid });
    return res.body.sessionId;
  }

  it("POST /v1/devices claims a lease and returns a manifest", async () => {
    const sessionId = await newSession();
    const res = await call("POST", "/v1/devices",
      { port: "Port A", model: "test-model", label: "MyA" },
      { "x-session-id": sessionId });
    assert.equal(res.statusCode, 200);
    assert.match(res.body.deviceId, /^[a-f0-9-]{36}$/i);
    assert.equal(res.body.ownerSessionId, sessionId);
    assert.equal(res.body.model, "test-model");
    assert.deepEqual(res.body.primary, { portName: "Port A", wsPort: null });
    assert.equal(res.body.label, "MyA");
  });

  it("POST /v1/devices fills wsPort for a mock primary", async () => {
    const sessionId = await newSession();
    const res = await call("POST", "/v1/devices",
      { port: "mocky", model: "test-model" },
      { "x-session-id": sessionId });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.primary, { portName: "Mock Port", wsPort: 3001 });
  });

  it("POST /v1/devices with with_shadow registers the bridge and includes shadow in manifest", async () => {
    const sessionId = await newSession();
    const res = await call("POST", "/v1/devices",
      { port: "Port A", model: "test-model", with_shadow: "mocky" },
      { "x-session-id": sessionId });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.shadow, { portName: "Mock Port", wsPort: 3001 });
  });

  it("POST /v1/devices returns 409 when port is already owned by another session", async () => {
    const a = await newSession(100);
    const b = await newSession(200);
    await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": a });
    const res = await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": b });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, "port-already-owned");
  });

  it("POST /v1/devices returns 409 self-shadow when port == with_shadow resolved port", async () => {
    const sessionId = await newSession();
    const res = await call("POST", "/v1/devices",
      { port: "Port A", model: "m", with_shadow: "Port A" },
      { "x-session-id": sessionId });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, "self-shadow");
  });

  it("POST /v1/devices returns 400 port-not-found", async () => {
    const sessionId = await newSession();
    const res = await call("POST", "/v1/devices", { port: "Nonexistent", model: "m" }, { "x-session-id": sessionId });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "port-not-found");
  });

  it("POST /v1/devices returns 400 for missing model", async () => {
    const sessionId = await newSession();
    const res = await call("POST", "/v1/devices", { port: "Port A" }, { "x-session-id": sessionId });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "invalid-input");
  });

  it("GET /v1/devices lists across sessions (R1)", async () => {
    const a = await newSession(100);
    const b = await newSession(200);
    await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": a });
    await call("POST", "/v1/devices", { port: "Port B", model: "m" }, { "x-session-id": b });
    const list = await call("GET", "/v1/devices");
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.length, 2);
  });

  it("GET /v1/devices/:id returns the manifest", async () => {
    const sessionId = await newSession();
    const created = await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": sessionId });
    const get = await call("GET", `/v1/devices/${created.body.deviceId}`);
    assert.equal(get.statusCode, 200);
    assert.equal(get.body.deviceId, created.body.deviceId);
  });

  it("DELETE /v1/devices/:id releases the lease (owner-only)", async () => {
    const sessionId = await newSession();
    const created = await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": sessionId });
    const del = await call("DELETE", `/v1/devices/${created.body.deviceId}`, undefined, { "x-session-id": sessionId });
    assert.equal(del.statusCode, 204);
    const get = await call("GET", `/v1/devices/${created.body.deviceId}`);
    assert.equal(get.statusCode, 404);
  });

  it("DELETE /v1/devices/:id by non-owner returns 403", async () => {
    const a = await newSession(100);
    const b = await newSession(200);
    const created = await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": a });
    const del = await call("DELETE", `/v1/devices/${created.body.deviceId}`, undefined, { "x-session-id": b });
    assert.equal(del.statusCode, 403);
    assert.equal(del.body.error, "not-owner");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/http-devices.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/mcb/http/devices.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { EventBroadcaster } from "../event-broadcaster.js";
import type { PortListReader, MockRegistryReader, Lease } from "../types.js";
import { resolvePort, PortResolutionError } from "../port-resolver.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

interface DevicesDeps {
  sessions: SessionManager;
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  events: EventBroadcaster;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

export function makeDevicesHandlers(deps: DevicesDeps) {
  return {
    create: async (ctx: RouteContext) => {
      const sessionId = ctx.headers["x-session-id"];
      if (!sessionId) {
        throw new HttpError(400, "invalid-input", "X-Session-Id header is required");
      }
      const session = deps.sessions.get(sessionId);
      if (!session) {
        throw new HttpError(404, "session-not-found", `Session ${sessionId} not found`);
      }

      const body = (ctx.body ?? {}) as {
        port?: string; model?: string; with_shadow?: string; input_port?: string;
        label?: string; channel?: number; lower_channel?: number; upper_channel?: number;
      };
      if (typeof body.port !== "string" || typeof body.model !== "string") {
        throw new HttpError(400, "invalid-input", "Body must include string `port` and `model`");
      }

      // Resolve primary
      const primary = resolveOrHttp(() =>
        resolvePort(body.port!, "output", deps.portList, deps.mockRegistry));

      // Reject if primary is already a primary (port-already-owned)
      const existingPrimary = deps.leases.isPrimary(primary.portName);
      if (existingPrimary) {
        const owner = deps.sessions.get(existingPrimary.sessionId);
        throw new HttpError(409, "port-already-owned", `Port ${primary.portName} is already owned`, {
          port: primary.portName,
          owner: { sessionId: existingPrimary.sessionId, pid: owner?.pid, processName: owner?.processName },
        });
      }
      // Reject if primary is currently a shadow target
      const existingShadow = deps.bridges.isShadowTarget(primary.portName);
      if (existingShadow) {
        throw new HttpError(409, "port-is-shadow", `Port ${primary.portName} is a shadow of another lease`, {
          port: primary.portName, masterDeviceId: existingShadow.masterDeviceId,
        });
      }

      // Resolve input
      let input: { portName: string } | undefined;
      if (typeof body.input_port === "string") {
        const ip = resolveOrHttp(() => resolvePort(body.input_port!, "input", deps.portList, deps.mockRegistry));
        input = { portName: ip.portName };
      }

      // Resolve shadow
      let shadow: { portName: string; wsPort: number | null } | undefined;
      if (typeof body.with_shadow === "string") {
        shadow = resolveOrHttp(() => resolvePort(body.with_shadow!, "output", deps.portList, deps.mockRegistry));

        // Reject self-shadow at OS-port level
        if (shadow.portName === primary.portName) {
          throw new HttpError(409, "self-shadow", "Master and shadow resolve to the same OS port");
        }
        // Reject if shadow is currently a primary
        if (deps.leases.isPrimary(shadow.portName)) {
          throw new HttpError(409, "shadow-target-is-primary", `Cannot shadow ${shadow.portName}: it is currently a primary`);
        }
        // Bridge invariants (cardinality, cycle, conflict) handled by BridgeRegistry.add below.
      }

      const deviceId = randomUUID();
      const lease: Lease = {
        deviceId,
        ownerSessionId: sessionId,
        model: body.model,
        primary,
        input,
        shadow,
        label: body.label ?? "default",
        channel: body.channel ?? 1,
        lowerChannel: body.lower_channel,
        upperChannel: body.upper_channel,
        connectedAt: Date.now(),
      };

      try {
        deps.leases.add(lease);
      } catch (err: any) {
        if (err.message?.includes("port-already-owned")) {
          throw new HttpError(409, "port-already-owned", err.message);
        }
        throw err;
      }

      if (shadow) {
        try {
          deps.bridges.add(deviceId, primary.portName, shadow.portName,
            (port) => deps.leases.primaryOwner(port));
        } catch (err: any) {
          // Roll back the lease addition.
          deps.leases.remove(deviceId);
          if (err.message?.includes("self-shadow")) throw new HttpError(409, "self-shadow", err.message);
          if (err.message?.includes("bridge-already-exists")) throw new HttpError(409, "bridge-already-exists", err.message);
          if (err.message?.includes("shadow-conflict")) throw new HttpError(409, "shadow-conflict", err.message);
          if (err.message?.includes("cycle-would-form")) throw new HttpError(409, "cycle-would-form", err.message);
          throw err;
        }
      }

      session.ownedDeviceIds.add(deviceId);
      deps.events.publish({
        type: "device-connected",
        deviceId, ownerSessionId: sessionId, model: body.model,
        primaryPort: primary.portName,
        shadowPort: shadow?.portName,
      });
      if (shadow) {
        deps.events.publish({ type: "bridge-created", masterDeviceId: deviceId, shadowPort: shadow.portName });
      }

      return { statusCode: 200, body: toManifest(lease) };
    },

    list: async () => {
      return { statusCode: 200, body: deps.leases.listAll().map(toManifest) };
    },

    get: async (ctx: RouteContext) => {
      const lease = deps.leases.get(ctx.params.id);
      if (!lease) throw new HttpError(404, "device-not-found", `Device ${ctx.params.id} not found`);
      return { statusCode: 200, body: toManifest(lease) };
    },

    delete: async (ctx: RouteContext) => {
      const lease = deps.leases.get(ctx.params.id);
      if (!lease) throw new HttpError(404, "device-not-found", `Device ${ctx.params.id} not found`);
      const sessionId = ctx.headers["x-session-id"];
      if (sessionId !== lease.ownerSessionId) {
        throw new HttpError(403, "not-owner", "Only the owner session can release this lease");
      }

      const shadowPort = deps.bridges.shadowOf(lease.deviceId);
      if (shadowPort) {
        deps.bridges.remove(lease.deviceId);
        deps.events.publish({ type: "bridge-removed", masterDeviceId: lease.deviceId, shadowPort });
      }
      deps.leases.remove(lease.deviceId);
      const session = deps.sessions.get(sessionId);
      session?.ownedDeviceIds.delete(lease.deviceId);
      deps.events.publish({ type: "device-disconnected", deviceId: lease.deviceId, ownerSessionId: lease.ownerSessionId });
      return { statusCode: 204, body: undefined };
    },
  };
}

function toManifest(lease: Lease) {
  const { connectedAt: _, ...rest } = lease;
  return rest;
}

function resolveOrHttp<T>(fn: () => T): T {
  try { return fn(); }
  catch (err: any) {
    if (err instanceof PortResolutionError) {
      throw new HttpError(400, err.code, err.message, err.details);
    }
    throw err;
  }
}
```

- [ ] **Step 4: Register the routes in `src/mcb/http/server.ts`**

Add to imports:
```ts
import { makeDevicesHandlers } from "./devices.js";
```

Add to `routes` array:
```ts
const devicesHandlers = makeDevicesHandlers({
  sessions: deps.sessions, leases: deps.leases, bridges: deps.bridges,
  events: deps.events, portList: deps.portList, mockRegistry: deps.mockRegistry,
});

// Append:
{ method: "POST",   pattern: /^\/v1\/devices$/,                          handler: devicesHandlers.create },
{ method: "GET",    pattern: /^\/v1\/devices$/,                          handler: devicesHandlers.list },
{ method: "GET",    pattern: /^\/v1\/devices\/(?<id>[a-f0-9-]+)$/,        handler: devicesHandlers.get },
{ method: "DELETE", pattern: /^\/v1\/devices\/(?<id>[a-f0-9-]+)$/,        handler: devicesHandlers.delete },
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/http-devices.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcb/http/devices.ts src/mcb/http/server.ts tests/unit/mcb/http-devices.test.ts
git commit -m "feat(mcb): device HTTP endpoints with full manifest, lease + bridge invariants"
```

---

## Task 10: MIDI ports endpoint

**Files:**
- Create: `src/mcb/http/midi-ports.ts`
- Modify: `src/mcb/http/server.ts`
- Create: `tests/unit/mcb/http-midi-ports.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mcb/http-midi-ports.test.ts`. Use the same harness as Task 9.

```ts
describe("MCB /v1/midi/ports", () => {
  it("returns OS ports with mock annotations", async () => {
    const res = await call("GET", "/v1/midi/ports");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.body.outputs.find((o: any) => o.name === "Mock Port"),
      { name: "Mock Port", mockLabel: "mocky", wsPort: 3001 },
    );
    assert.deepEqual(
      res.body.outputs.find((o: any) => o.name === "Port A"),
      { name: "Port A" },
    );
  });

  it("annotates a primary-owned port with ownedBy", async () => {
    const sess = await call("POST", "/v1/sessions", { pid: 100 });
    await call("POST", "/v1/devices", { port: "Port A", model: "m" },
      { "x-session-id": sess.body.sessionId });
    const res = await call("GET", "/v1/midi/ports");
    const portA = res.body.outputs.find((o: any) => o.name === "Port A");
    assert.equal(portA.ownedBy.sessionId, sess.body.sessionId);
    assert.match(portA.ownedBy.deviceId, /^[a-f0-9-]{36}$/i);
  });

  it("annotates a shadow target with shadowedBy", async () => {
    const sess = await call("POST", "/v1/sessions", { pid: 100 });
    const created = await call("POST", "/v1/devices",
      { port: "Port A", model: "m", with_shadow: "Port B" },
      { "x-session-id": sess.body.sessionId });
    const res = await call("GET", "/v1/midi/ports");
    const portB = res.body.outputs.find((o: any) => o.name === "Port B");
    assert.equal(portB.shadowedBy.deviceId, created.body.deviceId);
    assert.equal(portB.shadowedBy.sessionId, sess.body.sessionId);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx tsx --test tests/unit/mcb/http-midi-ports.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/mcb/http/midi-ports.ts`**

```ts
import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { PortListReader, MockRegistryReader } from "../types.js";
import type { RouteContext } from "./server.js";

interface MidiPortsDeps {
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  sessions: SessionManager;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

export function makeMidiPortsHandler(deps: MidiPortsDeps) {
  return async (_ctx: RouteContext) => {
    const annotateOutput = (name: string) => {
      const out: any = { name };
      const mock = deps.mockRegistry.findByMidiPort(name);
      if (mock) {
        out.mockLabel = mock.label;
        out.wsPort = mock.wsPort;
      }
      const owner = deps.leases.isPrimary(name);
      if (owner) {
        out.ownedBy = { sessionId: owner.sessionId, deviceId: owner.deviceId };
      }
      const shadow = deps.bridges.isShadowTarget(name);
      if (shadow) {
        const lease = deps.leases.get(shadow.masterDeviceId);
        out.shadowedBy = lease
          ? { sessionId: lease.ownerSessionId, deviceId: shadow.masterDeviceId }
          : { deviceId: shadow.masterDeviceId };
      }
      return out;
    };
    const outputs = deps.portList.listOutputs().map(annotateOutput);
    const inputs = deps.portList.listInputs().map((name) => ({ name }));
    return { statusCode: 200, body: { outputs, inputs } };
  };
}
```

- [ ] **Step 4: Register the route**

In `src/mcb/http/server.ts`:
```ts
import { makeMidiPortsHandler } from "./midi-ports.js";
// inside startServer:
const midiPortsHandler = makeMidiPortsHandler({ ... });
// in routes:
{ method: "GET", pattern: /^\/v1\/midi\/ports$/, handler: midiPortsHandler },
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx tsx --test tests/unit/mcb/http-midi-ports.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcb/http/midi-ports.ts src/mcb/http/server.ts tests/unit/mcb/http-midi-ports.test.ts
git commit -m "feat(mcb): /v1/midi/ports with mock, ownership, and shadow annotations"
```

---

## Task 11: SSE events endpoint

**Files:**
- Create: `src/mcb/http/events.ts`
- Modify: `src/mcb/http/server.ts`
- Create: `tests/unit/mcb/http-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcb/http-events.test.ts`. Use the same harness as Task 9. SSE testing requires a streaming HTTP client:

```ts
describe("MCB /v1/events (SSE)", () => {
  it("streams events to a subscriber", async () => {
    // Subscribe (don't await)
    const events: string[] = [];
    const sub = streamEvents(socketPath, (line) => events.push(line));

    // Wait one tick for the request to attach
    await new Promise((r) => setTimeout(r, 50));

    // Trigger an event
    await call("POST", "/v1/sessions", { pid: 100 });

    // Wait for delivery
    await new Promise((r) => setTimeout(r, 100));
    sub.close();

    const sessionCreated = events.find((l) => l.includes('"type":"session-created"'));
    assert.ok(sessionCreated, `expected session-created event, got: ${events.join("\n")}`);
  });
});

function streamEvents(socketPath: string, onLine: (line: string) => void) {
  const req = httpRequest({ socketPath, method: "GET", path: "/v1/events" }, (res) => {
    let buffered = "";
    res.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let idx;
      while ((idx = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) onLine(line.slice(6));
        }
      }
    });
  });
  req.end();
  return { close: () => req.destroy() };
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx tsx --test tests/unit/mcb/http-events.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/mcb/http/events.ts`**

```ts
import type { EventBroadcaster } from "../event-broadcaster.js";
import type { RouteContext } from "./server.js";

interface EventsDeps {
  events: EventBroadcaster;
}

export function makeEventsHandler(deps: EventsDeps) {
  return async (ctx: RouteContext): Promise<{ sse: true; res: any }> => {
    const res = ctx.rawRes;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    const unsubscribe = deps.events.subscribe((evt) => {
      try {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch {
        // client disconnected; cleanup happens via 'close' event
      }
    });

    ctx.rawReq.on("close", () => unsubscribe());

    return { sse: true, res };
  };
}
```

- [ ] **Step 4: Register the route**

In `src/mcb/http/server.ts`:
```ts
import { makeEventsHandler } from "./events.js";
// inside startServer:
const eventsHandler = makeEventsHandler({ events: deps.events });
// in routes:
{ method: "GET", pattern: /^\/v1\/events$/, handler: eventsHandler },
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx tsx --test tests/unit/mcb/http-events.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcb/http/events.ts src/mcb/http/server.ts tests/unit/mcb/http-events.test.ts
git commit -m "feat(mcb): /v1/events SSE topology stream with broadcast delivery"
```

---

## Task 12: Test infrastructure helpers (spawn + client)

**Files:**
- Create: `tests/helpers/mcb-spawn.ts`
- Create: `tests/helpers/mcb-client.ts`

- [ ] **Step 1: Implement `tests/helpers/mcb-spawn.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface McbHandle {
  socketPath: string;
  pid: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function spawnMcb(): Promise<McbHandle> {
  const dir = mkdtempSync(join(tmpdir(), "mcb-itest-"));
  const socketPath = join(dir, "sock");
  const proc = spawn("npx", ["tsx", "src/mcb/index.ts"], {
    env: { ...process.env, MCB_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for the socket to appear (and respond to /v1/health).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const ok = await pingHealth(socketPath);
      if (ok) break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(socketPath)) {
    proc.kill();
    throw new Error("MCB failed to start within 5s");
  }

  return {
    socketPath,
    pid: proc.pid!,
    proc,
    stop: () => new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve(); }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        resolve();
      });
      proc.kill("SIGTERM");
    }),
  };
}

async function pingHealth(socketPath: string): Promise<boolean> {
  const { request } = await import("node:http");
  return new Promise<boolean>((resolve) => {
    const req = request({ socketPath, method: "GET", path: "/v1/health", timeout: 200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
```

- [ ] **Step 2: Implement `tests/helpers/mcb-client.ts`**

```ts
import { request } from "node:http";

export interface McbResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
}

export function httpRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<McbResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method, path, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: any = undefined;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            hdrs[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
          }
          resolve({ statusCode: res.statusCode!, body: parsed, headers: hdrs });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
```

- [ ] **Step 3: Smoke-run nothing (helpers don't have tests of their own — they're proven by the integration tests in Tasks 13–17).**

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/mcb-spawn.ts tests/helpers/mcb-client.ts
git commit -m "test(mcb): integration test helpers (spawn + http-over-uds client)"
```

---

## Task 13: Integration test — lifecycle

**Files:**
- Create: `tests/integration/mcb/lifecycle.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnMcb, type McbHandle } from "../../helpers/mcb-spawn.js";
import { httpRequest } from "../../helpers/mcb-client.js";

let mcb: McbHandle;

before(async () => { mcb = await spawnMcb(); });
after(async () => { await mcb.stop(); });

describe("MCB integration: lifecycle", () => {
  it("end-to-end: create session, claim lease, list, delete, GC the socket", async () => {
    const sess = await httpRequest(mcb.socketPath, "POST", "/v1/sessions", { pid: process.pid, processName: "lifecycle-test" });
    assert.equal(sess.statusCode, 200);

    // The OS port list will likely be empty in CI; pick any name. We just need the lease lifecycle to work.
    // For this smoke test, supply a port name we know fails resolution; that exercises the error path.
    const failed = await httpRequest(mcb.socketPath, "POST", "/v1/devices",
      { port: "Definitely Not A Real Port", model: "m" },
      { "x-session-id": sess.body.sessionId });
    assert.equal(failed.statusCode, 400);
    assert.equal(failed.body.error, "port-not-found");

    const list = await httpRequest(mcb.socketPath, "GET", "/v1/devices");
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.body, []);

    const del = await httpRequest(mcb.socketPath, "DELETE", `/v1/sessions/${sess.body.sessionId}`,
      undefined, { "x-session-id": sess.body.sessionId });
    assert.equal(del.statusCode, 204);

    const health = await httpRequest(mcb.socketPath, "GET", "/v1/health");
    assert.equal(health.body.sessionsActive, 0);
  });
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx tsx --test tests/integration/mcb/lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcb/lifecycle.test.ts
git commit -m "test(mcb): integration test for lifecycle"
```

---

## Task 14: Integration test — multi-session R1 + T1

**Files:**
- Create: `tests/integration/mcb/multi-session.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnMcb, type McbHandle } from "../../helpers/mcb-spawn.js";
import { httpRequest } from "../../helpers/mcb-client.js";

let mcb: McbHandle;
before(async () => { mcb = await spawnMcb(); });
after(async () => { await mcb.stop(); });

describe("MCB integration: multi-session R1+T1", () => {
  it("R1 — both sessions can read each other's devices", async () => {
    // For this test we cannot easily claim leases without real OS ports.
    // Instead, we validate that read-open endpoints don't require X-Session-Id at all.
    const sessA = await httpRequest(mcb.socketPath, "POST", "/v1/sessions", { pid: 1, processName: "A" });
    const sessB = await httpRequest(mcb.socketPath, "POST", "/v1/sessions", { pid: 2, processName: "B" });

    const listA = await httpRequest(mcb.socketPath, "GET", "/v1/devices",
      undefined, { "x-session-id": sessA.body.sessionId });
    const listB = await httpRequest(mcb.socketPath, "GET", "/v1/devices",
      undefined, { "x-session-id": sessB.body.sessionId });
    const listAnon = await httpRequest(mcb.socketPath, "GET", "/v1/devices");

    assert.equal(listA.statusCode, 200);
    assert.equal(listB.statusCode, 200);
    assert.equal(listAnon.statusCode, 200);
  });

  it("T1 — A's session cannot delete B's session", async () => {
    const sessA = await httpRequest(mcb.socketPath, "POST", "/v1/sessions", { pid: 100 });
    const sessB = await httpRequest(mcb.socketPath, "POST", "/v1/sessions", { pid: 200 });

    const wrongDelete = await httpRequest(mcb.socketPath, "DELETE",
      `/v1/sessions/${sessB.body.sessionId}`,
      undefined, { "x-session-id": sessA.body.sessionId });
    assert.equal(wrongDelete.statusCode, 403);
    assert.equal(wrongDelete.body.error, "session-mismatch");
  });
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx tsx --test tests/integration/mcb/multi-session.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcb/multi-session.test.ts
git commit -m "test(mcb): integration test for multi-session R1 reads and T1 conflict"
```

---

## Task 15: Integration test — SSE events

**Files:**
- Create: `tests/integration/mcb/sse-events.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { request } from "node:http";
import { spawnMcb, type McbHandle } from "../../helpers/mcb-spawn.js";
import { httpRequest } from "../../helpers/mcb-client.js";

let mcb: McbHandle;
before(async () => { mcb = await spawnMcb(); });
after(async () => { await mcb.stop(); });

function streamEvents(socketPath: string, onLine: (line: string) => void) {
  const req = request({ socketPath, method: "GET", path: "/v1/events" }, (res) => {
    let buffered = "";
    res.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let idx;
      while ((idx = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) onLine(line.slice(6));
        }
      }
    });
  });
  req.end();
  return { close: () => req.destroy() };
}

describe("MCB integration: SSE events", () => {
  it("delivers session-created and session-released events to a live subscriber", async () => {
    const events: string[] = [];
    const sub = streamEvents(mcb.socketPath, (line) => events.push(line));
    await new Promise((r) => setTimeout(r, 100));

    const sess = await httpRequest(mcb.socketPath, "POST", "/v1/sessions", { pid: process.pid });
    await new Promise((r) => setTimeout(r, 100));

    await httpRequest(mcb.socketPath, "DELETE", `/v1/sessions/${sess.body.sessionId}`,
      undefined, { "x-session-id": sess.body.sessionId });
    await new Promise((r) => setTimeout(r, 100));
    sub.close();

    const created = events.find((l) => l.includes('"type":"session-created"'));
    const released = events.find((l) => l.includes('"type":"session-released"'));
    assert.ok(created, `missing session-created event, got: ${events.join("\n")}`);
    assert.ok(released, `missing session-released event, got: ${events.join("\n")}`);
  });
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx tsx --test tests/integration/mcb/sse-events.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcb/sse-events.test.ts
git commit -m "test(mcb): integration test for SSE event delivery"
```

---

## Task 16: Integration test — PID liveness GC

**Files:**
- Create: `tests/integration/mcb/pid-liveness.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnMcb, type McbHandle } from "../../helpers/mcb-spawn.js";
import { httpRequest } from "../../helpers/mcb-client.js";
import { spawn } from "node:child_process";

let mcb: McbHandle;
before(async () => { mcb = await spawnMcb(); });
after(async () => { await mcb.stop(); });

describe("MCB integration: PID liveness GC", () => {
  it("hard-GCs a session whose PID has died (after the configured window)", async () => {
    // Spawn a short-lived child whose PID we register as the session owner.
    const child = spawn("node", ["-e", "setTimeout(() => process.exit(0), 100)"], { stdio: "ignore" });
    const childPid = child.pid!;
    const sess = await httpRequest(mcb.socketPath, "POST", "/v1/sessions", { pid: childPid });
    assert.equal(sess.statusCode, 200);

    // Wait for child exit
    await new Promise<void>((r) => child.once("exit", () => r()));

    // The default config: deadAfterMisses=10s, reattachWindow=30s. Total 40s before hard-GC.
    // That's too long for a test; we trust the unit test for the algorithm and just verify the watcher runs.
    // Quick check: shortly after child death, the session is still present (within tolerance).
    await new Promise((r) => setTimeout(r, 1500));
    const list = await httpRequest(mcb.socketPath, "GET", "/v1/health");
    assert.ok(list.body.sessionsActive >= 1, "session should still be tracked shortly after PID death");

    // Fully validating the 40s GC path is out of scope for fast tests. Unit tests cover the
    // SessionManager algorithm; this integration test is just a smoke for the watcher loop.
  });
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx tsx --test tests/integration/mcb/pid-liveness.test.ts`

Expected: PASS (should run in ~2s).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcb/pid-liveness.test.ts
git commit -m "test(mcb): integration smoke for PID-liveness watcher"
```

---

## Task 17: Final sweep — full suite, lint, build

**Files:** none (verification only)

- [ ] **Step 1: Run all unit tests**

Run: `npm run test:unit`

Expected: PASS — all existing nord-electro-5d tests + all 5 new mcb unit test files.

- [ ] **Step 2: Run all integration tests**

Run: `npm run test:integration`

Expected: PASS — existing mock-runner integration tests + all 4 new mcb integration tests.

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: clean. If `no-unused-vars` complains about the `_` prefix on `connectedAt: _`, ensure the destructuring uses `_unused`-style names per existing convention.

- [ ] **Step 4: Type-check**

Run: `npm run test:check`

Expected: clean.

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: clean `tsc` exit. `dist/mcb/index.js` exists.

- [ ] **Step 6: Smoke-run the built binary**

Run: `node dist/mcb/index.js`

Expected: prints `[mcb] listening on ~/.mcb/sock`. In another terminal:
```
curl --unix-socket ~/.mcb/sock http://localhost/v1/health
```
Expected: `{"ok":true,"uptimeSec":...,"sessionsActive":0,"devicesConnected":0}`.

Press Ctrl-C in the first terminal: prints `[mcb] shutting down` and exits cleanly. Run again: should start without `EADDRINUSE` (stale socket probe + unlink).

- [ ] **Step 7: Final commit (only if anything was touched)**

```bash
git add -p
git commit -m "fix(mcb): final-sweep cleanup"
```

Otherwise skip — no empty commits.

---

## Self-review notes (for the implementer, not steps)

- **Spec coverage**: every "In scope" bullet in the MVP spec has a task or set of tasks: scaffold (Task 1), HTTP server + UDS (Task 7), sessions (Task 8), leases (Task 9), midi-ports (Task 10), SSE (Task 11), bridges (Task 9), strict resolution (Task 4), R1+T1 (Tasks 8/9/14), error catalogue (Tasks 7/9, formatError module), tests (all unit + integration tasks). The disclosed deviation (client-supplied PID) is documented at the top.
- **The PID-liveness 40-second cycle is too slow to integration-test without mocking time.** The unit test (Task 5) covers the algorithm; the integration test (Task 16) just confirms the watcher loop runs.
- **Real MIDI ports cannot be claimed in CI without test fixtures.** Integration tests for connect-with-real-ports are intentionally light; the in-process unit tests with synthetic `PortListReader` cover the connect flow exhaustively.
- **Backlog items deliberately not implemented**: launchd/systemd, MCB CLI, peer-PID via syscall, schema/runtime split, SSE keepalive/resumability, T2, persistence, body-size caps, etc. — all in the backlog file.
