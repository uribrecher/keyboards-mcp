import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeExistingSocket, prepareSocketPath } from "../../../src/mcb/socket-cleanup.js";

let dir: string;

before(() => { dir = mkdtempSync(join(tmpdir(), "mcb-cleanup-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * Create a genuine orphan UDS file: a child process binds the path, then we
 * SIGKILL it. Node's graceful close() removes the file, so we have to crash
 * the child to leave a real socket inode behind (the failure mode this code
 * defends against).
 */
async function makeOrphanSocketFile(path: string): Promise<void> {
  // Helper child writes "ready" to a pipe on stdout, then we SIGKILL it.
  // After the kill we drain stdout so the read-end FD doesn't leak into
  // node:test's event loop and keep the process alive after the test passes.
  const child = spawn(process.execPath, ["-e", `
    const net = require("node:net");
    const s = net.createServer();
    s.listen(${JSON.stringify(path)}, () => process.stdout.write("ready\\n"));
  `], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("orphan helper child failed to listen")), 5000);
    child.stdout!.on("data", (b) => { if (String(b).includes("ready")) { clearTimeout(t); resolve(); } });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise<void>((r) => child.once("close", () => r()));
  if (!existsSync(path) || !lstatSync(path).isSocket()) {
    throw new Error(`orphan helper failed: path=${path} exists=${existsSync(path)}`);
  }
}

describe("probeExistingSocket", () => {
  it("returns 'absent' when no socket file exists", async () => {
    const path = join(dir, "absent.sock");
    assert.equal(await probeExistingSocket(path), "absent");
  });

  it("returns 'stale' for an orphan UDS file with no listener", async () => {
    const path = join(dir, "stale.sock");
    await makeOrphanSocketFile(path);
    try {
      assert.equal(await probeExistingSocket(path), "stale");
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });

  it("returns 'alive' when an HTTP listener responds at /v1/health", async () => {
    const path = join(dir, "alive.sock");
    const server: Server = createServer((_req, res) => { res.statusCode = 200; res.end("{}"); });
    await new Promise<void>((r) => server.listen(path, () => r()));
    try {
      assert.equal(await probeExistingSocket(path), "alive");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (existsSync(path)) rmSync(path);
    }
  });
});

describe("prepareSocketPath", () => {
  it("no-ops when the path is absent", async () => {
    const path = join(dir, "prep-absent.sock");
    await prepareSocketPath(path);
    assert.equal(existsSync(path), false);
  });

  it("unlinks an orphan socket file", async () => {
    const path = join(dir, "prep-stale.sock");
    await makeOrphanSocketFile(path);
    await prepareSocketPath(path);
    assert.equal(existsSync(path), false);
  });

  it("throws when another MCB is alive on the path", async () => {
    const path = join(dir, "prep-alive.sock");
    const server: Server = createServer((_req, res) => { res.statusCode = 200; res.end("{}"); });
    await new Promise<void>((r) => server.listen(path, () => r()));
    try {
      await assert.rejects(
        prepareSocketPath(path),
        { message: /another-instance-alive/i },
      );
      assert.equal(existsSync(path), true, "live socket must NOT be unlinked");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (existsSync(path)) rmSync(path);
    }
  });

  it("refuses to unlink a non-socket file (misconfigured MCB_SOCKET safety)", async () => {
    const path = join(dir, "prep-regular.sock");
    writeFileSync(path, "important user data");
    try {
      await assert.rejects(
        prepareSocketPath(path),
        { message: /not-a-socket-file/i },
      );
      assert.equal(existsSync(path), true, "non-socket file must NOT be unlinked");
    } finally {
      if (existsSync(path)) rmSync(path);
    }
  });

});
