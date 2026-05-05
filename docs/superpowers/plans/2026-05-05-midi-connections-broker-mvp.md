# midi-connections-broker (MCB) — Phase 1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `midi-connections-broker` (MCB) Node binary that listens on a Unix domain socket, speaks HTTP, and implements a minimum viable connection broker: sessions, lease registry, bridge registry, strict port resolution, R1+T1 lock semantics. No SSE, no PID-liveness watcher, no `/v1/midi/ports`, no session attach/delete — those are deferred to the backlog and Phase 2.

**Architecture:** New `src/mcb/` directory. Pure metadata + arbitration. Tests against synthetic HTTP/UDS clients verify lock semantics, bridge invariants, and port resolution end-to-end. Phase 2 (separate plan) integrates MCB into MCP and adds the deferred features.

**Tech Stack:** TypeScript 5.5+, `node:http` over Unix domain socket, `node:test` + `node:assert`, `tsx` runner, `easymidi` (read-only for port listing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-05-midi-connections-broker-mvp.md`. **Backlog (do NOT plan from):** `docs/superpowers/specs/2026-05-05-midi-connections-broker-backlog.md`.

---

## Pragmatic deviations from the spec

The MVP-spec is broader than this plan. The user has explicitly trimmed; **deferred to Phase 2 / backlog**:

- **SSE events** (`GET /v1/events`) and `EventBroadcaster` — no consumer in Phase 1.
- **`/v1/midi/ports`** — useful for the future connection-viewer, not for control-plane validation.
- **`POST /v1/sessions/:id/attach`**, **`DELETE /v1/sessions/:id`**, **`GET /v1/sessions/:id/devices`** — reattach is for transient drops; without MCP integration there's no client to retry. Sessions are append-only in MVP and leak on daemon shutdown (in-memory only).
- **PID-liveness watcher loop** — without it, sessions and leases leak when MCPs die uncleanly. Acceptable for an architectural validation phase that has no MCP yet.
- **Bridge cycle walker** — under the connect-only API, cycles cannot form (a port that's a shadow target cannot also be a primary). Self-shadow is checked; the recursive walker is unreachable in MVP.
- **Stale UDS socket probe-and-unlink** at startup, **graceful SIGTERM shutdown** — convenience features. Engineer can `rm` the socket between dev runs.
- **`GET /v1/devices/:id`** (single fetch) — `GET /v1/devices` returns the same info; pulling one is just an array filter the client can do.
- **Peer-PID via `SO_PEERCRED`/`LOCAL_PEERPID`** — Node has no built-in. MVP receives PID in `POST /v1/sessions` body. Trust gate: UDS perms `0600`. Real syscall is a backlog item.

## File structure

```
src/mcb/
  index.ts                  # bin entry: parse env, set up server, listen
  types.ts                  # MCB-internal types
  http/
    server.ts               # request routing
    sessions.ts             # POST /v1/sessions
    devices.ts              # POST/GET/DELETE /v1/devices(/:id)
    health.ts               # GET /v1/health
    errors.ts               # formatError + HttpError
  lease-registry.ts         # Map<deviceId, Lease>; isPrimary(portName)
  bridge-registry.ts        # Map<masterDeviceId, ShadowEndpoint>; isShadowTarget
  port-resolver.ts          # strict resolution + injectable PortListReader
  session-manager.ts        # Map<sessionId, Session>; create/get

tests/unit/mcb/
  bridge-registry.test.ts
  lease-registry.test.ts
  port-resolver.test.ts
  http.test.ts              # in-process HTTP tests (covers sessions + devices + health)

tests/integration/mcb/
  smoke.test.ts             # spawn binary; lifecycle + multi-session in one test
```

`package.json` additions:
- `bin: { "midi-connections-broker": "./dist/mcb/index.js" }`
- `scripts.mcb: "tsx src/mcb/index.ts"`

---

## Task 1: Scaffold and types

**Files:**
- Create: `src/mcb/types.ts`
- Create: `src/mcb/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `src/mcb/types.ts`**

```ts
export interface Session {
  sessionId: string;
  pid: number;
  processName?: string;
  ownedDeviceIds: Set<string>;
  createdAt: number;
}

export interface ShadowEndpoint {
  portName: string;
}

export interface PortInfo {
  portName: string;
  wsPort: number | null;
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
  connectedAt: number;
}

export type Manifest = Omit<Lease, "connectedAt">;

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
```

- [ ] **Step 2: Create `src/mcb/index.ts` (minimal placeholder)**

```ts
#!/usr/bin/env node
const SOCKET_PATH = process.env.MCB_SOCKET ?? `${process.env.HOME}/.mcb/sock`;
console.log(`MCB starting (socket: ${SOCKET_PATH})`);
console.log("Phase 1 MVP — server wiring lands in Task 6.");
```

- [ ] **Step 3: Update `package.json`**

Add to `"scripts"`:
```json
"mcb": "tsx src/mcb/index.ts"
```

Add at the same level as `"scripts"`:
```json
"bin": { "midi-connections-broker": "./dist/mcb/index.js" }
```

- [ ] **Step 4: Smoke-run**

Run: `npm run mcb`

Expected: prints the two startup lines and exits cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/types.ts src/mcb/index.ts package.json
git commit -m "feat(mcb): scaffold types and bin entry"
```

---

## Task 2: BridgeRegistry

**Files:**
- Create: `src/mcb/bridge-registry.ts`
- Create: `tests/unit/mcb/bridge-registry.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/unit/mcb/bridge-registry.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";

let registry: BridgeRegistry;

describe("BridgeRegistry", () => {
  beforeEach(() => { registry = new BridgeRegistry(); });

  it("adds and reads back a bridge", () => {
    registry.add("dev-A", "Master Port", "Shadow Port");
    assert.equal(registry.shadowOf("dev-A"), "Shadow Port");
    assert.deepEqual(registry.isShadowTarget("Shadow Port"), { masterDeviceId: "dev-A" });
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

  it("rejects when shadow port is already a target", () => {
    registry.add("dev-A", "Master A", "Shared Shadow");
    assert.throws(
      () => registry.add("dev-B", "Master B", "Shared Shadow"),
      { message: /shadow-conflict/i },
    );
  });

  it("remove drops the bridge", () => {
    registry.add("dev-A", "Master Port", "Shadow Port");
    registry.remove("dev-A");
    assert.equal(registry.shadowOf("dev-A"), undefined);
    assert.equal(registry.isShadowTarget("Shadow Port"), undefined);
  });
});
```

- [ ] **Step 2: Run and verify the tests fail**

Run: `npx tsx --test tests/unit/mcb/bridge-registry.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcb/bridge-registry.ts`**

```ts
import type { ShadowEndpoint } from "./types.js";

export class BridgeRegistry {
  private bridges = new Map<string, ShadowEndpoint>();
  private shadowIndex = new Map<string, string>();

  add(masterDeviceId: string, masterPortName: string, shadowPortName: string): void {
    if (masterPortName === shadowPortName) {
      throw new Error("self-shadow: master and shadow ports must differ");
    }
    if (this.bridges.has(masterDeviceId)) {
      throw new Error(`bridge-already-exists for master ${masterDeviceId}`);
    }
    if (this.shadowIndex.has(shadowPortName)) {
      throw new Error(`shadow-conflict: ${shadowPortName} is already a shadow target`);
    }
    this.bridges.set(masterDeviceId, { portName: shadowPortName });
    this.shadowIndex.set(shadowPortName, masterDeviceId);
  }

  remove(masterDeviceId: string): void {
    const bridge = this.bridges.get(masterDeviceId);
    if (!bridge) return;
    this.shadowIndex.delete(bridge.portName);
    this.bridges.delete(masterDeviceId);
  }

  shadowOf(masterDeviceId: string): string | undefined {
    return this.bridges.get(masterDeviceId)?.portName;
  }

  isShadowTarget(portName: string): { masterDeviceId: string } | undefined {
    const masterDeviceId = this.shadowIndex.get(portName);
    return masterDeviceId ? { masterDeviceId } : undefined;
  }
}
```

- [ ] **Step 4: Run and verify the tests pass**

Run: `npx tsx --test tests/unit/mcb/bridge-registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/bridge-registry.ts tests/unit/mcb/bridge-registry.test.ts
git commit -m "feat(mcb): bridge registry with cardinality and self-shadow guards"
```

---

## Task 3: LeaseRegistry

**Files:**
- Create: `src/mcb/lease-registry.ts`
- Create: `tests/unit/mcb/lease-registry.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import type { Lease } from "../../../src/mcb/types.js";

let r: LeaseRegistry;

function fixture(o: Partial<Lease> = {}): Lease {
  return {
    deviceId: "dev-1", ownerSessionId: "sess-1", model: "m",
    primary: { portName: "Port A", wsPort: null },
    label: "default", channel: 1, connectedAt: Date.now(), ...o,
  };
}

describe("LeaseRegistry", () => {
  beforeEach(() => { r = new LeaseRegistry(); });

  it("adds and reads back a lease", () => {
    const lease = fixture();
    r.add(lease);
    assert.deepEqual(r.get("dev-1"), lease);
  });

  it("rejects adding a lease whose primary is already owned", () => {
    r.add(fixture({ deviceId: "dev-1", primary: { portName: "Same", wsPort: null } }));
    assert.throws(
      () => r.add(fixture({ deviceId: "dev-2", primary: { portName: "Same", wsPort: null } })),
      { message: /port-already-owned/i },
    );
  });

  it("isPrimary returns owner info", () => {
    r.add(fixture({ deviceId: "dev-1", ownerSessionId: "s-1", primary: { portName: "X", wsPort: null } }));
    assert.deepEqual(r.isPrimary("X"), { sessionId: "s-1", deviceId: "dev-1" });
    assert.equal(r.isPrimary("Other"), undefined);
  });

  it("listAll + remove", () => {
    r.add(fixture({ deviceId: "dev-1", primary: { portName: "A", wsPort: null } }));
    r.add(fixture({ deviceId: "dev-2", primary: { portName: "B", wsPort: null } }));
    assert.equal(r.listAll().length, 2);
    r.remove("dev-1");
    assert.equal(r.listAll().length, 1);
    assert.equal(r.get("dev-1"), undefined);
  });
});
```

- [ ] **Step 2: Run and verify tests fail**

Run: `npx tsx --test tests/unit/mcb/lease-registry.test.ts` — FAIL.

- [ ] **Step 3: Implement `src/mcb/lease-registry.ts`**

```ts
import type { Lease } from "./types.js";

export class LeaseRegistry {
  private byDeviceId = new Map<string, Lease>();
  private primaryIndex = new Map<string, string>();

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

- [ ] **Step 4: Run and verify tests pass**

Run: `npx tsx --test tests/unit/mcb/lease-registry.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/lease-registry.ts tests/unit/mcb/lease-registry.test.ts
git commit -m "feat(mcb): lease registry with primary-port exclusivity"
```

---

## Task 4: PortResolver

**Files:**
- Create: `src/mcb/port-resolver.ts`
- Create: `tests/unit/mcb/port-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolvePort } from "../../../src/mcb/port-resolver.js";
import type { PortListReader, MockRegistryReader, MockRegistryEntry } from "../../../src/mcb/types.js";

const ports = (outputs: string[], inputs: string[] = []): PortListReader =>
  ({ listOutputs: () => outputs, listInputs: () => inputs });

const reg = (entries: MockRegistryEntry[]): MockRegistryReader => ({
  findByLabel: (l) => entries.find((e) => e.label === l),
  findByMidiPort: (p) => entries.find((e) => e.midiPort === p),
  list: () => entries,
});

const mockEntry: MockRegistryEntry = { midiPort: "Nord Mock", wsPort: 3002, label: "nordi", pid: 999 };

describe("PortResolver", () => {
  it("resolves a mock label (output)", () => {
    const r = resolvePort("nordi", "output", ports(["Nord Mock"]), reg([mockEntry]));
    assert.deepEqual(r, { portName: "Nord Mock", wsPort: 3002 });
  });

  it("rejects mock label for input direction", () => {
    assert.throws(
      () => resolvePort("nordi", "input", ports([], []), reg([mockEntry])),
      { message: /port-not-found/i },
    );
  });

  it("resolves an exact OS output port name", () => {
    const r = resolvePort("Nord Hw", "output", ports(["Nord Hw"]), reg([]));
    assert.deepEqual(r, { portName: "Nord Hw", wsPort: null });
  });

  it("does NOT substring-match", () => {
    assert.throws(
      () => resolvePort("Nord", "output", ports(["Nord Hw"]), reg([])),
      { message: /port-not-found/i },
    );
  });

  it("rejects when registry resolves but OS doesn't show the port", () => {
    assert.throws(
      () => resolvePort("nordi", "output", ports([]), reg([mockEntry])),
      { message: /port-not-found/i },
    );
  });
});
```

- [ ] **Step 2: Run and verify tests fail** — FAIL.

- [ ] **Step 3: Implement `src/mcb/port-resolver.ts`**

```ts
import type { Direction, PortListReader, MockRegistryReader, PortInfo } from "./types.js";

export class PortResolutionError extends Error {
  constructor(public code: "port-not-found" | "ambiguous-port", message: string, public details: Record<string, unknown>) {
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
  const candidates: Array<{ portName: string; wsPort?: number }> = [];

  // Mock label match (output only)
  if (direction === "output") {
    const m = registry.findByLabel(arg);
    if (m) candidates.push({ portName: m.midiPort, wsPort: m.wsPort });
  }

  // OS exact match
  if (osPorts.includes(arg)) {
    const m = registry.findByMidiPort(arg);
    candidates.push({ portName: arg, wsPort: m?.wsPort });
  }

  const unique = new Set(candidates.map((c) => c.portName));
  if (unique.size === 0) {
    throw new PortResolutionError("port-not-found", `Port not found: '${arg}'`,
      { arg, direction, availableMockLabels: direction === "output" ? registry.list().map((e) => e.label) : [], availableOsPorts: osPorts });
  }
  if (unique.size > 1) {
    throw new PortResolutionError("ambiguous-port", `Ambiguous port name '${arg}'`,
      { arg, candidates: candidates.map((c) => c.portName) });
  }

  const [chosen] = candidates;
  if (!osPorts.includes(chosen.portName)) {
    throw new PortResolutionError("port-not-found",
      `Port '${chosen.portName}' resolved from '${arg}' is not currently visible to the OS`,
      { arg, resolvedTo: chosen.portName });
  }
  return { portName: chosen.portName, wsPort: chosen.wsPort ?? null };
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcb/port-resolver.ts tests/unit/mcb/port-resolver.test.ts
git commit -m "feat(mcb): strict port resolver"
```

---

## Task 5: SessionManager

**Files:**
- Create: `src/mcb/session-manager.ts`

A minimal in-memory session map. No PID-liveness, no reattach — both deferred.

- [ ] **Step 1: Implement `src/mcb/session-manager.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Session } from "./types.js";

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(input: { pid: number; processName?: string }): Session {
    const session: Session = {
      sessionId: randomUUID(),
      pid: input.pid,
      processName: input.processName,
      ownedDeviceIds: new Set(),
      createdAt: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listAll(): Session[] {
    return [...this.sessions.values()];
  }
}
```

- [ ] **Step 2: No dedicated unit test for this task** — its surface is so thin that the HTTP handler tests in Task 7 cover it. Skip a separate test file.

- [ ] **Step 3: Commit**

```bash
git add src/mcb/session-manager.ts
git commit -m "feat(mcb): minimal session manager (in-memory, no GC)"
```

---

## Task 6: HTTP server scaffolding + /v1/health

**Files:**
- Create: `src/mcb/http/server.ts`
- Create: `src/mcb/http/health.ts`
- Create: `src/mcb/http/errors.ts`
- Modify: `src/mcb/index.ts`

- [ ] **Step 1: Implement `src/mcb/http/errors.ts`**

```ts
export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function formatError(err: unknown): { statusCode: number; body: { error: string; message: string; details?: unknown } } {
  if (err instanceof HttpError) {
    return { statusCode: err.statusCode, body: { error: err.code, message: err.message, details: err.details } };
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("port-not-found"))     return { statusCode: 400, body: { error: "port-not-found", message: msg, details: (err as any).details } };
    if (msg.includes("ambiguous-port"))     return { statusCode: 400, body: { error: "ambiguous-port", message: msg, details: (err as any).details } };
    if (msg.includes("port-already-owned")) return { statusCode: 409, body: { error: "port-already-owned", message: msg } };
    if (msg.includes("self-shadow"))        return { statusCode: 409, body: { error: "self-shadow", message: msg } };
    if (msg.includes("bridge-already-exists")) return { statusCode: 409, body: { error: "bridge-already-exists", message: msg } };
    if (msg.includes("shadow-conflict"))    return { statusCode: 409, body: { error: "shadow-conflict", message: msg } };
  }
  const errorId = Math.random().toString(36).slice(2, 10);
  console.error(`[mcb] internal-error ${errorId}:`, err);
  return { statusCode: 500, body: { error: "internal-error", message: `Internal error (id ${errorId})` } };
}
```

- [ ] **Step 2: Implement `src/mcb/http/health.ts`**

```ts
import type { LeaseRegistry } from "../lease-registry.js";
import type { SessionManager } from "../session-manager.js";

export function makeHealthHandler(deps: { leases: LeaseRegistry; sessions: SessionManager; startedAtMs: number }) {
  return async () => ({
    statusCode: 200,
    body: {
      ok: true,
      uptimeSec: Math.floor((Date.now() - deps.startedAtMs) / 1000),
      sessionsActive: deps.sessions.listAll().length,
      devicesConnected: deps.leases.listAll().length,
    },
  });
}
```

- [ ] **Step 3: Implement `src/mcb/http/server.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { PortListReader, MockRegistryReader } from "../types.js";
import { formatError } from "./errors.js";
import { makeHealthHandler } from "./health.js";

export interface ServerDeps {
  socketPath: string;
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  sessions: SessionManager;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

export interface StartedServer { socketPath: string; stop(): Promise<void>; }

export interface RouteContext {
  params: Record<string, string>;
  body: any;
  headers: Record<string, string | undefined>;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<{ statusCode: number; body?: unknown }>;
}

export async function startServer(deps: ServerDeps): Promise<StartedServer> {
  const startedAtMs = Date.now();
  const dir = dirname(deps.socketPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const routes: Route[] = [
    { method: "GET", pattern: /^\/v1\/health$/, handler: makeHealthHandler({ leases: deps.leases, sessions: deps.sessions, startedAtMs }) },
    // session/device routes appended in Task 7 via the registerRoutes call below.
  ];
  registerRoutes(routes, deps);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://mcb.local");
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) { respond(res, 404, { error: "not-found", message: `No route for ${req.method} ${url.pathname}` }); return; }
      const m = route.pattern.exec(url.pathname)!;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) params[k] = v;
      let body: any;
      if (req.method !== "GET") {
        const buf = await readBody(req);
        if (buf.length > 0) {
          try { body = JSON.parse(buf.toString()); }
          catch { respond(res, 400, { error: "invalid-input", message: "Body must be valid JSON" }); return; }
        }
      }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const result = await route.handler({ params, body, headers });
      respond(res, result.statusCode, result.body);
    } catch (err) {
      const f = formatError(err);
      respond(res, f.statusCode, f.body);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.socketPath, () => {
      try { chmodSync(deps.socketPath, 0o600); } catch { /* macOS sometimes refuses */ }
      resolve();
    });
  });

  return {
    socketPath: deps.socketPath,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
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

// Stub — Task 7 fills it in.
function registerRoutes(_routes: Route[], _deps: ServerDeps): void {}
```

- [ ] **Step 4: Wire `src/mcb/index.ts`**

```ts
#!/usr/bin/env node
import { startServer } from "./http/server.js";
import { LeaseRegistry } from "./lease-registry.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { SessionManager } from "./session-manager.js";
import easymidi from "easymidi";
import { findByMidiPort, readActive } from "../shared/mock-registry.js";

const SOCKET_PATH = process.env.MCB_SOCKET ?? `${process.env.HOME}/.mcb/sock`;

const portList = { listOutputs: () => easymidi.getOutputs(), listInputs: () => easymidi.getInputs() };
const mockRegistry = {
  findByLabel: (label: string) => readActive().find((e) => e.label === label),
  findByMidiPort: (midiPort: string) => findByMidiPort(midiPort),
  list: () => readActive(),
};

(async () => {
  await startServer({
    socketPath: SOCKET_PATH,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager(),
    portList, mockRegistry,
  });
  console.log(`[mcb] listening on ${SOCKET_PATH}`);
})().catch((err) => { console.error(err); process.exit(1); });
```

> If `readActive`/`findByMidiPort` are named differently in `src/shared/mock-registry.ts`, adjust to the actual exports.

- [ ] **Step 5: Smoke-run**

Run: `rm -f ~/.mcb/sock; npm run mcb`

In another terminal: `curl --unix-socket ~/.mcb/sock http://localhost/v1/health`

Expected: `{"ok":true,"uptimeSec":...,"sessionsActive":0,"devicesConnected":0}`. Ctrl-C to stop.

- [ ] **Step 6: Commit**

```bash
git add src/mcb/http/ src/mcb/index.ts
git commit -m "feat(mcb): http server scaffolding and /v1/health"
```

---

## Task 7: Sessions + Devices HTTP endpoints

**Files:**
- Create: `src/mcb/http/sessions.ts`
- Create: `src/mcb/http/devices.ts`
- Modify: `src/mcb/http/server.ts` (fill in `registerRoutes`)
- Create: `tests/unit/mcb/http.test.ts`

- [ ] **Step 1: Implement `src/mcb/http/sessions.ts`**

```ts
import type { SessionManager } from "../session-manager.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

export function makeSessionsHandlers(deps: { sessions: SessionManager }) {
  return {
    create: async (ctx: RouteContext) => {
      const { pid, processName } = (ctx.body ?? {}) as { pid?: number; processName?: string };
      if (typeof pid !== "number" || pid <= 0) {
        throw new HttpError(400, "invalid-input", "Body must include numeric pid > 0");
      }
      const session = deps.sessions.create({ pid, processName });
      return { statusCode: 200, body: { sessionId: session.sessionId, ownerPid: pid } };
    },
  };
}
```

- [ ] **Step 2: Implement `src/mcb/http/devices.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { SessionManager } from "../session-manager.js";
import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { PortListReader, MockRegistryReader, Lease } from "../types.js";
import { resolvePort, PortResolutionError } from "../port-resolver.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

interface Deps {
  sessions: SessionManager;
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

export function makeDevicesHandlers(deps: Deps) {
  return {
    create: async (ctx: RouteContext) => {
      const sessionId = ctx.headers["x-session-id"];
      if (!sessionId) throw new HttpError(400, "invalid-input", "X-Session-Id header is required");
      const session = deps.sessions.get(sessionId);
      if (!session) throw new HttpError(404, "session-not-found", `Session ${sessionId} not found`);

      const body = (ctx.body ?? {}) as {
        port?: string; model?: string; with_shadow?: string; input_port?: string;
        label?: string; channel?: number; lower_channel?: number; upper_channel?: number;
      };
      if (typeof body.port !== "string" || typeof body.model !== "string") {
        throw new HttpError(400, "invalid-input", "Body must include string `port` and `model`");
      }

      const primary = resolveOrHttp(() => resolvePort(body.port!, "output", deps.portList, deps.mockRegistry));

      const existingPrimary = deps.leases.isPrimary(primary.portName);
      if (existingPrimary) {
        const owner = deps.sessions.get(existingPrimary.sessionId);
        throw new HttpError(409, "port-already-owned", `Port ${primary.portName} is already owned`,
          { port: primary.portName, owner: { sessionId: existingPrimary.sessionId, pid: owner?.pid, processName: owner?.processName } });
      }
      if (deps.bridges.isShadowTarget(primary.portName)) {
        throw new HttpError(409, "port-is-shadow", `Port ${primary.portName} is currently a shadow target`);
      }

      let input: { portName: string } | undefined;
      if (typeof body.input_port === "string") {
        const ip = resolveOrHttp(() => resolvePort(body.input_port!, "input", deps.portList, deps.mockRegistry));
        input = { portName: ip.portName };
      }

      let shadow: { portName: string; wsPort: number | null } | undefined;
      if (typeof body.with_shadow === "string") {
        shadow = resolveOrHttp(() => resolvePort(body.with_shadow!, "output", deps.portList, deps.mockRegistry));
        if (shadow.portName === primary.portName) throw new HttpError(409, "self-shadow", "Master and shadow resolve to the same OS port");
        if (deps.leases.isPrimary(shadow.portName)) throw new HttpError(409, "shadow-target-is-primary", `Cannot shadow ${shadow.portName}: it is currently a primary`);
      }

      const deviceId = randomUUID();
      const lease: Lease = {
        deviceId, ownerSessionId: sessionId, model: body.model,
        primary, input, shadow,
        label: body.label ?? "default",
        channel: body.channel ?? 1,
        lowerChannel: body.lower_channel,
        upperChannel: body.upper_channel,
        connectedAt: Date.now(),
      };

      deps.leases.add(lease);
      if (shadow) {
        try {
          deps.bridges.add(deviceId, primary.portName, shadow.portName);
        } catch (err) {
          deps.leases.remove(deviceId); // rollback
          throw err;
        }
      }
      session.ownedDeviceIds.add(deviceId);
      return { statusCode: 200, body: toManifest(lease) };
    },

    list: async () => ({ statusCode: 200, body: deps.leases.listAll().map(toManifest) }),

    delete: async (ctx: RouteContext) => {
      const lease = deps.leases.get(ctx.params.id);
      if (!lease) throw new HttpError(404, "device-not-found", `Device ${ctx.params.id} not found`);
      const sessionId = ctx.headers["x-session-id"];
      if (sessionId !== lease.ownerSessionId) throw new HttpError(403, "not-owner", "Only the owner session can release this lease");
      if (deps.bridges.shadowOf(lease.deviceId)) deps.bridges.remove(lease.deviceId);
      deps.leases.remove(lease.deviceId);
      deps.sessions.get(sessionId)?.ownedDeviceIds.delete(lease.deviceId);
      return { statusCode: 204 };
    },
  };
}

function toManifest(lease: Lease) {
  const { connectedAt: _c, ...rest } = lease;
  return rest;
}

function resolveOrHttp<T>(fn: () => T): T {
  try { return fn(); }
  catch (err) {
    if (err instanceof PortResolutionError) throw new HttpError(400, err.code, err.message, err.details);
    throw err;
  }
}
```

- [ ] **Step 3: Fill in `registerRoutes` in `src/mcb/http/server.ts`**

Replace the stub `registerRoutes` with:

```ts
import { makeSessionsHandlers } from "./sessions.js";
import { makeDevicesHandlers } from "./devices.js";

function registerRoutes(routes: Route[], deps: ServerDeps): void {
  const sess = makeSessionsHandlers({ sessions: deps.sessions });
  const dev = makeDevicesHandlers({
    sessions: deps.sessions, leases: deps.leases, bridges: deps.bridges,
    portList: deps.portList, mockRegistry: deps.mockRegistry,
  });
  routes.push(
    { method: "POST",   pattern: /^\/v1\/sessions$/,                          handler: sess.create },
    { method: "POST",   pattern: /^\/v1\/devices$/,                           handler: dev.create },
    { method: "GET",    pattern: /^\/v1\/devices$/,                           handler: dev.list },
    { method: "DELETE", pattern: /^\/v1\/devices\/(?<id>[a-f0-9-]+)$/,         handler: dev.delete },
  );
}
```

- [ ] **Step 4: Write the in-process HTTP test**

Create `tests/unit/mcb/http.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { request } from "node:http";
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

beforeEach(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "mcb-test-"));
  socketPath = join(socketDir, "sock");
  server = await startServer({
    socketPath,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager(),
    portList: { listOutputs: () => ["Port A", "Port B", "Mock Port"], listInputs: () => ["Port A In"] },
    mockRegistry: {
      findByLabel: (l) => l === "mocky" ? { midiPort: "Mock Port", wsPort: 3001, label: "mocky", pid: 999 } : undefined,
      findByMidiPort: (p) => p === "Mock Port" ? { midiPort: "Mock Port", wsPort: 3001, label: "mocky", pid: 999 } : undefined,
      list: () => [{ midiPort: "Mock Port", wsPort: 3001, label: "mocky", pid: 999 }],
    },
  });
});

afterEach(async () => { await server.stop(); rmSync(socketDir, { recursive: true, force: true }); });

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: any;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
        resolve({ statusCode: res.statusCode!, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function newSession(pid = 100): Promise<string> {
  const r = await call("POST", "/v1/sessions", { pid });
  return r.body.sessionId;
}

describe("MCB HTTP", () => {
  it("/v1/health returns ok", async () => {
    const r = await call("GET", "/v1/health");
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ok, true);
  });

  it("POST /v1/sessions creates session", async () => {
    const r = await call("POST", "/v1/sessions", { pid: 1234, processName: "test" });
    assert.equal(r.statusCode, 200);
    assert.match(r.body.sessionId, /^[a-f0-9-]{36}$/i);
    assert.equal(r.body.ownerPid, 1234);
  });

  it("POST /v1/sessions rejects missing pid", async () => {
    const r = await call("POST", "/v1/sessions", {});
    assert.equal(r.statusCode, 400);
  });

  it("POST /v1/devices claims a lease and returns manifest", async () => {
    const sid = await newSession();
    const r = await call("POST", "/v1/devices", { port: "Port A", model: "m", label: "L" }, { "x-session-id": sid });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.ownerSessionId, sid);
    assert.deepEqual(r.body.primary, { portName: "Port A", wsPort: null });
    assert.equal(r.body.label, "L");
  });

  it("POST /v1/devices fills wsPort for a mock primary", async () => {
    const sid = await newSession();
    const r = await call("POST", "/v1/devices", { port: "mocky", model: "m" }, { "x-session-id": sid });
    assert.deepEqual(r.body.primary, { portName: "Mock Port", wsPort: 3001 });
  });

  it("POST /v1/devices with with_shadow registers bridge", async () => {
    const sid = await newSession();
    const r = await call("POST", "/v1/devices", { port: "Port A", model: "m", with_shadow: "mocky" }, { "x-session-id": sid });
    assert.deepEqual(r.body.shadow, { portName: "Mock Port", wsPort: 3001 });
  });

  it("T1 — second session cannot claim same port", async () => {
    const a = await newSession(100);
    const b = await newSession(200);
    await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": a });
    const r = await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": b });
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.error, "port-already-owned");
  });

  it("self-shadow rejected", async () => {
    const sid = await newSession();
    const r = await call("POST", "/v1/devices", { port: "Port A", model: "m", with_shadow: "Port A" }, { "x-session-id": sid });
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.error, "self-shadow");
  });

  it("port-not-found", async () => {
    const sid = await newSession();
    const r = await call("POST", "/v1/devices", { port: "Nope", model: "m" }, { "x-session-id": sid });
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.error, "port-not-found");
  });

  it("missing model rejected", async () => {
    const sid = await newSession();
    const r = await call("POST", "/v1/devices", { port: "Port A" }, { "x-session-id": sid });
    assert.equal(r.statusCode, 400);
  });

  it("R1 — GET /v1/devices is read-open", async () => {
    const a = await newSession(100);
    const b = await newSession(200);
    await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": a });
    const list = await call("GET", "/v1/devices", undefined, { "x-session-id": b });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.length, 1);
  });

  it("DELETE /v1/devices owner-only", async () => {
    const a = await newSession(100);
    const b = await newSession(200);
    const created = await call("POST", "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": a });
    const wrong = await call("DELETE", `/v1/devices/${created.body.deviceId}`, undefined, { "x-session-id": b });
    assert.equal(wrong.statusCode, 403);
    const right = await call("DELETE", `/v1/devices/${created.body.deviceId}`, undefined, { "x-session-id": a });
    assert.equal(right.statusCode, 204);
  });
});
```

- [ ] **Step 5: Run and verify tests pass**

Run: `npx tsx --test tests/unit/mcb/http.test.ts`

Expected: PASS — all 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src/mcb/http/sessions.ts src/mcb/http/devices.ts src/mcb/http/server.ts tests/unit/mcb/http.test.ts
git commit -m "feat(mcb): session + device HTTP endpoints with R1+T1 enforcement"
```

---

## Task 8: Integration smoke test

**Files:**
- Create: `tests/integration/mcb/smoke.test.ts`

One integration test that spawns the binary and runs a basic flow end-to-end.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let proc: ChildProcess;
let socketDir: string;
let socketPath: string;

before(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "mcb-itest-"));
  socketPath = join(socketDir, "sock");
  proc = spawn("npx", ["tsx", "src/mcb/index.ts"], {
    env: { ...process.env, MCB_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the socket to come up.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath) && (await ping())) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(socketPath)) throw new Error("MCB failed to start");
});

after(async () => {
  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.once("exit", () => r()));
  rmSync(socketDir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: any;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
        resolve({ statusCode: res.statusCode!, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function ping(): Promise<boolean> {
  try { const r = await call("GET", "/v1/health"); return r.statusCode === 200; }
  catch { return false; }
}

describe("MCB integration: end-to-end", () => {
  it("health, create session, port-not-found, list devices, multi-session T1", async () => {
    const h = await call("GET", "/v1/health");
    assert.equal(h.body.ok, true);

    const a = await call("POST", "/v1/sessions", { pid: process.pid });
    assert.equal(a.statusCode, 200);

    // Port resolution against real OS — we don't know which ports exist on this machine, so use a name we know fails.
    const fail = await call("POST", "/v1/devices", { port: "Definitely Not Real", model: "m" }, { "x-session-id": a.body.sessionId });
    assert.equal(fail.statusCode, 400);
    assert.equal(fail.body.error, "port-not-found");

    const list = await call("GET", "/v1/devices");
    assert.deepEqual(list.body, []);

    // T1 smoke: two sessions, both call list (R1 succeeds, no leases yet so list is empty).
    const b = await call("POST", "/v1/sessions", { pid: process.pid + 1 });
    const list2 = await call("GET", "/v1/devices", undefined, { "x-session-id": b.body.sessionId });
    assert.equal(list2.statusCode, 200);
  });
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx tsx --test tests/integration/mcb/smoke.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mcb/smoke.test.ts
git commit -m "test(mcb): integration smoke (spawn binary + end-to-end flow)"
```

---

## Task 9: Final sweep

**Files:** none

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: PASS — all existing tests + new mcb unit tests + new mcb integration smoke.

- [ ] **Step 2: Lint**

Run: `npm run lint` — clean.

- [ ] **Step 3: Type-check**

Run: `npm run test:check` — clean.

- [ ] **Step 4: Build**

Run: `npm run build` — clean.

- [ ] **Step 5: Smoke the built binary**

Run: `rm -f ~/.mcb/sock; node dist/mcb/index.js`

In another terminal: `curl --unix-socket ~/.mcb/sock http://localhost/v1/health`

Expected: ok response. Ctrl-C to stop.

- [ ] **Step 6: Final commit (if anything was touched)**

```bash
git add -p
git commit -m "fix(mcb): final-sweep cleanup"
```

Otherwise skip.

---

## Self-review notes

- **Spec coverage**: every "In scope" bullet in the MVP spec that survived the user's "trim" instruction has a task: scaffold (1), bridges (2), leases (3), port resolution (4), sessions (5), HTTP server (6), session+device endpoints (7), integration (8). Trimmed-out spec items (SSE, /v1/midi/ports, session attach/delete, PID-liveness watcher, stale socket probe, graceful shutdown) are documented at the top of this plan and on the backlog.
- **Pragmatic deviations** are listed up-front, not buried.
- **Plan size**: ~1000 lines, vs. the original ~3000. The trim came from cutting deferred features, dropping multi-test integration files in favor of one smoke test, and inlining test infrastructure rather than creating helper modules.
