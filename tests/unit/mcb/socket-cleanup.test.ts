import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeExistingSocket, prepareSocketPath } from "../../../src/mcb/socket-cleanup.js";

let dir: string;

before(() => { dir = mkdtempSync(join(tmpdir(), "mcb-cleanup-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe("probeExistingSocket", () => {
  it("returns 'absent' when no socket file exists", async () => {
    const path = join(dir, "absent.sock");
    assert.equal(await probeExistingSocket(path), "absent");
  });

  it("returns 'stale' when the file exists but nothing listens", async () => {
    const path = join(dir, "stale.sock");
    writeFileSync(path, ""); // regular file at the path; connect refused
    assert.equal(await probeExistingSocket(path), "stale");
    rmSync(path);
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
  beforeEach(() => {
    // Each test owns its own filename to avoid cross-test contamination.
  });

  it("no-ops when the path is absent", async () => {
    const path = join(dir, "prep-absent.sock");
    await prepareSocketPath(path);
    assert.equal(existsSync(path), false);
  });

  it("unlinks a stale socket file", async () => {
    const path = join(dir, "prep-stale.sock");
    writeFileSync(path, "");
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
});
