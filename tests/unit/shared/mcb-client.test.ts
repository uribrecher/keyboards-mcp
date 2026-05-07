import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../../../src/mcb/http/server.js";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";
import { SessionManager } from "../../../src/mcb/session-manager.js";
import {
  claimLease,
  releaseLease,
  listMyDevices,
  resetSession,
  MCBError,
  MCBSessionLostError,
  setOnSessionLost,
  getCachedSessionId,
  getMcbHealth,
  __testing,
} from "../../../src/shared/mcb-client.js";

let server: StartedServer;
let sessions: SessionManager;
let socketDir: string;
let socketPath: string;
let prevSocket: string | undefined;

async function startServerWithFreshState(): Promise<StartedServer> {
  sessions = new SessionManager();
  return startServer({
    socketPath,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions,
    portList: { listOutputs: () => ["Port A", "Port B"], listInputs: () => [] },
    mockRegistry: { findByLabel: () => undefined, findByMidiPort: () => undefined, list: () => [], listAllWithStale: () => [] },
  });
}

beforeEach(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "mcp-mcb-"));
  socketPath = join(socketDir, "sock");
  prevSocket = process.env.MCB_SOCKET;
  process.env.MCB_SOCKET = socketPath;
  resetSession();
  server = await startServerWithFreshState();
});

afterEach(async () => {
  await server.stop();
  rmSync(socketDir, { recursive: true, force: true });
  if (prevSocket === undefined) delete process.env.MCB_SOCKET; else process.env.MCB_SOCKET = prevSocket;
  resetSession();
});

describe("mcb-client", () => {
  it("claims and releases a lease end-to-end", async () => {
    const manifest = await claimLease({ port: "Port A", model: "test-model" });
    assert.equal(manifest.primary.portName, "Port A");
    assert.equal(manifest.model, "test-model");
    assert.match(manifest.deviceId, /^[a-f0-9-]{36}$/i);
    await releaseLease(manifest.deviceId);
  });

  it("listMyDevices returns this session's leases only", async () => {
    const m1 = await claimLease({ port: "Port A", model: "x" });
    const m2 = await claimLease({ port: "Port B", model: "x" });
    const mine = await listMyDevices();
    assert.equal(mine.length, 2);
    const ids = mine.map((m) => m.deviceId).sort();
    assert.deepEqual(ids, [m1.deviceId, m2.deviceId].sort());
  });

  it("surfaces MCB errors as MCBError with code", async () => {
    try {
      await claimLease({ port: "Nonexistent Port", model: "x" });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof MCBError);
      assert.equal((err as MCBError).code, "port-not-found");
      assert.equal((err as MCBError).statusCode, 400);
    }
  });

  it("MCB unreachable surfaces mcb-unreachable code", async () => {
    process.env.MCB_SOCKET = join(socketDir, "definitely-not-a-real-socket");
    resetSession();
    try {
      await claimLease({ port: "Port A", model: "x" });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof MCBError);
      assert.equal((err as MCBError).code, "mcb-unreachable");
    }
  });

  it("listMyDevices returns [] without minting a session when none cached", async () => {
    assert.equal(getCachedSessionId(), null);
    const mine = await listMyDevices();
    assert.deepEqual(mine, []);
    // Verify the read did NOT mint a session.
    assert.equal(getCachedSessionId(), null);
  });

  it("session-not-found drops the cache, fires onSessionLost, and throws MCBSessionLostError", async () => {
    // Mint a session by claiming, capture the id, then wipe the broker's
    // session table to force session-not-found on the next claim.
    await claimLease({ port: "Port A", model: "x" });
    const sidBefore = getCachedSessionId();
    assert.ok(sidBefore, "expected a cached session after first claim");
    for (const s of sessions.listAll()) sessions.delete(s.sessionId);

    let cbCalls = 0;
    setOnSessionLost(() => {
      cbCalls += 1;
      return 3;  // Pretend three local leases were torn down.
    });

    try {
      await claimLease({ port: "Port B", model: "x" });
      assert.fail("expected MCBSessionLostError");
    } catch (err) {
      assert.ok(err instanceof MCBSessionLostError, `expected MCBSessionLostError, got ${err}`);
      const sl = err as MCBSessionLostError;
      assert.equal(sl.code, "session-lost");
      assert.equal(sl.statusCode, 404);
      assert.equal(sl.droppedLeaseCount, 3);
      assert.equal(sl.lostSessionId, sidBefore);
    }
    assert.equal(cbCalls, 1, "onSessionLost should fire exactly once");
    assert.equal(getCachedSessionId(), null, "cache must be dropped after session-lost");
  });

  it("a follow-up claim after session-lost mints a fresh session", async () => {
    await claimLease({ port: "Port A", model: "x" });
    const sidBefore = getCachedSessionId();
    for (const s of sessions.listAll()) sessions.delete(s.sessionId);
    setOnSessionLost(() => 0);

    await assert.rejects(
      claimLease({ port: "Port B", model: "x" }),
      (err: unknown) => err instanceof MCBSessionLostError,
    );

    // Next claim must succeed by minting a fresh session.
    const m = await claimLease({ port: "Port B", model: "x" });
    assert.equal(m.primary.portName, "Port B");
    const sidAfter = getCachedSessionId();
    assert.ok(sidAfter);
    assert.notEqual(sidAfter, sidBefore, "fresh session id expected after session-lost");
  });

  it("getMcbHealth returns broker payload when reachable, null when not", async () => {
    const h = await getMcbHealth();
    assert.ok(h);
    assert.equal(h.ok, true);
    assert.equal(typeof h.uptimeSec, "number");
    assert.equal(typeof h.sessionsActive, "number");
    assert.equal(typeof h.devicesConnected, "number");

    process.env.MCB_SOCKET = join(socketDir, "definitely-not-a-real-socket");
    const h2 = await getMcbHealth();
    assert.equal(h2, null);
  });

  it("heartbeat is not running before any session is minted", () => {
    assert.equal(__testing.isHeartbeatRunning(), false);
    assert.equal(getCachedSessionId(), null);
  });

  it("heartbeat starts after the first claim and tolerates a 200 OK tick", async () => {
    await claimLease({ port: "Port A", model: "x" });
    assert.equal(__testing.isHeartbeatRunning(), true);
    const sidBefore = getCachedSessionId();
    let cbCalls = 0;
    setOnSessionLost(() => { cbCalls += 1; return 0; });

    // Broker still has the session — tick is a no-op.
    await __testing.triggerHeartbeat();
    assert.equal(cbCalls, 0);
    assert.equal(getCachedSessionId(), sidBefore);
    assert.equal(__testing.isHeartbeatRunning(), true);
  });

  it("heartbeat detects session-not-found and drops the cache + fires onSessionLost + stops itself", async () => {
    await claimLease({ port: "Port A", model: "x" });
    assert.equal(__testing.isHeartbeatRunning(), true);

    let cbCalls = 0;
    setOnSessionLost(() => { cbCalls += 1; return 7; });

    // Wipe the session table broker-side. Next heartbeat tick must surface
    // it as session-not-found and drop the local cache.
    for (const s of sessions.listAll()) sessions.delete(s.sessionId);

    await __testing.triggerHeartbeat();

    assert.equal(cbCalls, 1, "onSessionLost should fire exactly once");
    assert.equal(getCachedSessionId(), null);
    assert.equal(__testing.isHeartbeatRunning(), false, "heartbeat stops when the cache is dropped");
  });

  it("heartbeat tolerates broker-unreachable transparently — no drop, callback not fired", async () => {
    await claimLease({ port: "Port A", model: "x" });
    const sidBefore = getCachedSessionId();
    let cbCalls = 0;
    setOnSessionLost(() => { cbCalls += 1; return 0; });

    // Stop the broker mid-flight. Next tick will fail with mcb-unreachable —
    // by spec we treat that as transient and leave the cache alone.
    await server.stop();
    await __testing.triggerHeartbeat();

    assert.equal(cbCalls, 0, "broker-unreachable on heartbeat must NOT fire onSessionLost");
    assert.equal(getCachedSessionId(), sidBefore, "cache survives a transient broker outage");
    assert.equal(__testing.isHeartbeatRunning(), true, "heartbeat keeps running across transient errors");

    // Bring broker back up so afterEach's server.stop() doesn't try to close
    // a stopped server (no-op is fine, but matches the lifecycle expected by
    // other tests in the file).
    server = await startServerWithFreshState();
  });
});
