import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Always invoke MCB via tsx against the source tree. dist/ may be stale during
// dev iteration; npx would interpose another process that swallows SIGTERM.
// npm workspaces hoist tsx to the repo-root node_modules, so resolve it from
// there (relative to this file) rather than the package-local node_modules.
const tsxCli = new URL("../../../../../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname;
const cmd = process.execPath;
const args = [tsxCli, "src/mcb/index.ts"];

function spawnMcb(socketPath: string): ChildProcess {
  // Default stdio to "ignore". When the child is SIGKILL'd, "pipe" stdio
  // leaves read-end FDs open in the parent until Node happens to drain them,
  // which keeps node:test's event loop alive after the test passes.
  const debug = !!process.env.MCB_TEST_DEBUG;
  const proc = spawn(cmd, args, {
    env: { ...process.env, MCB_SOCKET: socketPath },
    stdio: debug ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
  });
  if (debug) {
    proc.stdout?.on("data", (b) => process.stderr.write(`[mcb-out ${proc.pid}] ${b}`));
    proc.stderr?.on("data", (b) => process.stderr.write(`[mcb-err ${proc.pid}] ${b}`));
  }
  return proc;
}

async function waitForHealth(socketPath: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          const req = request({ socketPath, method: "GET", path: "/v1/health" }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          });
          req.on("error", () => resolve(false));
          req.end();
        });
        if (ok) return true;
      } catch { /* keep polling */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function waitForExit(proc: ChildProcess, timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { proc.kill("SIGKILL"); resolve({ code: null, signal: null }); }, timeoutMs);
    proc.once("exit", (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}

function postJson(socketPath: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: unknown }> {
  return udsCall(socketPath, "POST", path, body, headers);
}

function udsCall(socketPath: string, method: string, path: string, body: unknown | undefined, headers: Record<string, string>): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: unknown;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
        resolve({ statusCode: res.statusCode!, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("MCB lifecycle", () => {
  it("SIGTERM closes the listener and unlinks the socket file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-lifecycle-"));
    const path = join(dir, "sock");
    const proc = spawnMcb(path);
    try {
      assert.equal(await waitForHealth(path), true, "MCB failed to come up");
      proc.kill("SIGTERM");
      const { code } = await waitForExit(proc);
      assert.equal(code, 0, "expected clean exit on SIGTERM");
      assert.equal(existsSync(path), false, "socket file should be unlinked on graceful shutdown");
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts cleanly when a SIGKILL'd predecessor left an orphan socket file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-lifecycle-"));
    const path = join(dir, "sock");
    // Simulate an ungraceful exit by spawning MCB and SIGKILLing it once it's
    // healthy. Node's graceful close() removes the UDS file, so SIGKILL is
    // required to produce the real "stale socket inode" failure mode.
    const dead = spawnMcb(path);
    try {
      assert.equal(await waitForHealth(path), true, "predecessor MCB failed to come up");
      dead.kill("SIGKILL");
      await waitForExit(dead);
      assert.equal(existsSync(path), true, "SIGKILL should leave the socket file behind");
    } finally {
      if (dead.exitCode === null && dead.signalCode === null) dead.kill("SIGKILL");
    }
    const proc = spawnMcb(path);
    try {
      assert.equal(await waitForHealth(path), true, "successor MCB failed to recover from orphan socket file");
      proc.kill("SIGTERM");
      await waitForExit(proc);
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not persist sessions across an MCB restart — old session id returns 404, client must mint a fresh one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-lifecycle-"));
    const path = join(dir, "sock");
    let mcb1: ChildProcess | undefined;
    let mcb2: ChildProcess | undefined;
    try {
      mcb1 = spawnMcb(path);
      assert.equal(await waitForHealth(path), true, "first MCB failed to come up");

      const create1 = await postJson(path, "/v1/sessions", { pid: process.pid, processName: "test" });
      assert.equal(create1.statusCode, 200);
      const oldSessionId = (create1.body as { sessionId: string }).sessionId;

      // SIGTERM (graceful shutdown) — the broker unlinks the socket and
      // exits cleanly. SIGKILL on the tsx wrapper PID does not propagate to
      // the broker child, so the listener stays bound and the successor
      // refuses to start (another-instance-alive).
      mcb1.kill("SIGTERM");
      await waitForExit(mcb1);

      mcb2 = spawnMcb(path);
      assert.equal(await waitForHealth(path), true, "second MCB failed to come up");

      // MCB is the source of truth for sessions; restarting it discards the
      // session table. Using the old sessionId on a session-bearing call must
      // return session-not-found — clients are expected to mint a fresh one.
      const claim = await postJson(path, "/v1/devices", { port: "Port A", model: "m" }, { "x-session-id": oldSessionId });
      assert.equal(claim.statusCode, 404, `expected 404 session-not-found, got ${claim.statusCode}: ${JSON.stringify(claim.body)}`);
      assert.equal((claim.body as { error: string }).error, "session-not-found");

      const create2 = await postJson(path, "/v1/sessions", { pid: process.pid, processName: "test" });
      assert.equal(create2.statusCode, 200);
      const freshSessionId = (create2.body as { sessionId: string }).sessionId;
      assert.notEqual(freshSessionId, oldSessionId, "a freshly minted session must not reuse the old id");
    } finally {
      if (mcb1 && mcb1.exitCode === null && mcb1.signalCode === null) mcb1.kill("SIGKILL");
      if (mcb2 && mcb2.exitCode === null && mcb2.signalCode === null) mcb2.kill("SIGTERM");
      if (mcb2) await waitForExit(mcb2);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start when another live MCB is already listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-lifecycle-"));
    const path = join(dir, "sock");
    const first = spawnMcb(path);
    let second: ChildProcess | undefined;
    try {
      assert.equal(await waitForHealth(path), true, "first MCB failed to come up");
      second = spawnMcb(path);
      const { code } = await waitForExit(second);
      assert.notEqual(code, 0, "second MCB should exit non-zero when path is owned");
      // First MCB should still be healthy and the socket intact.
      assert.equal(await waitForHealth(path, 1_000), true, "first MCB must survive second's collision");
    } finally {
      if (second && second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
      first.kill("SIGTERM");
      await waitForExit(first);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
