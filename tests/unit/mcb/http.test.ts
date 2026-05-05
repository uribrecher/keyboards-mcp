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
