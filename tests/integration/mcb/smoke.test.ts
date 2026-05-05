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
