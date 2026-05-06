import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../../../src/mcb/http/server.js";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";
import { SessionManager } from "../../../src/mcb/session-manager.js";
import { claimLease, releaseLease, listMyDevices, resetSession, MCBError } from "../../../src/shared/mcb-client.js";

let server: StartedServer;
let socketDir: string;
let socketPath: string;
let prevSocket: string | undefined;

beforeEach(async () => {
  socketDir = mkdtempSync(join(tmpdir(), "mcp-mcb-"));
  socketPath = join(socketDir, "sock");
  prevSocket = process.env.MCB_SOCKET;
  process.env.MCB_SOCKET = socketPath;
  resetSession();
  server = await startServer({
    socketPath,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager(),
    portList: { listOutputs: () => ["Port A", "Port B"], listInputs: () => [] },
    mockRegistry: { findByLabel: () => undefined, findByMidiPort: () => undefined, list: () => [], listAllWithStale: () => [] },
  });
});

afterEach(async () => {
  await server.stop();
  rmSync(socketDir, { recursive: true, force: true });
  if (prevSocket === undefined) delete process.env.MCB_SOCKET; else process.env.MCB_SOCKET = prevSocket;
  resetSession();
});

describe("mcb-client", () => {
  it("claims and releases a lease end-to-end", async () => {
    const manifest = await claimLease({ port: "Port A", model: "test-model", label: "L" });
    assert.equal(manifest.primary.portName, "Port A");
    assert.match(manifest.deviceId, /^[a-f0-9-]{36}$/i);
    assert.equal(manifest.label, "L");
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
});
