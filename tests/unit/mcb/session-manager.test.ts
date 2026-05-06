import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { SessionManager } from "../../../src/mcb/session-manager.js";

let mgr: SessionManager;
let alivePids: Set<number>;

beforeEach(() => {
  alivePids = new Set([100, 200]);
  mgr = new SessionManager({
    livenessChecker: (pid) => alivePids.has(pid),
    deadAfterMissesAtMs: 10_000,
    reattachWindowMs: 30_000,
  });
});

describe("SessionManager", () => {
  it("creates and reads a session", () => {
    const s = mgr.create({ pid: 100, processName: "test" });
    assert.match(s.sessionId, /^[a-f0-9-]{36}$/i);
    assert.equal(s.pid, 100);
    assert.equal(s.markedDeadAt, null);
    assert.equal(mgr.get(s.sessionId)!.pid, 100);
  });

  it("delete removes the session", () => {
    const s = mgr.create({ pid: 100 });
    mgr.delete(s.sessionId);
    assert.equal(mgr.get(s.sessionId), undefined);
  });

  it("listAll returns all sessions", () => {
    mgr.create({ pid: 100 });
    mgr.create({ pid: 200 });
    assert.equal(mgr.listAll().length, 2);
  });

  describe("attach (MCB-crash recovery)", () => {
    it("creates a session with the given id when MCB doesn't know it (post-restart)", () => {
      const id = "abcd1234-abcd-1234-abcd-123456789012";
      const s = mgr.attach(id, { pid: 100, processName: "client" });
      assert.equal(s.sessionId, id);
      assert.equal(s.pid, 100);
      assert.equal(s.processName, "client");
      assert.equal(mgr.get(id)?.pid, 100);
    });

    it("refreshes pid on a known session (idempotent attach)", () => {
      const s = mgr.create({ pid: 100, processName: "old" });
      const r = mgr.attach(s.sessionId, { pid: 200, processName: "new" });
      assert.equal(r.sessionId, s.sessionId);
      assert.equal(r.pid, 200);
      assert.equal(r.processName, "new");
      assert.equal(mgr.get(s.sessionId)?.pid, 200);
    });

    it("clears markedDeadAt and miss state so an attach mid-sweep is not reaped", () => {
      const s = mgr.create({ pid: 100 });
      alivePids.delete(100);
      mgr.runLivenessSweep(0);
      mgr.runLivenessSweep(10_001);
      assert.ok(mgr.get(s.sessionId)?.markedDeadAt !== null);
      alivePids.add(200);
      mgr.attach(s.sessionId, { pid: 200 });
      assert.equal(mgr.get(s.sessionId)?.markedDeadAt, null);
      // Subsequent sweep with the new (alive) PID stays clean.
      mgr.runLivenessSweep(15_000);
      assert.ok(mgr.get(s.sessionId));
    });
  });

  describe("PID-liveness GC", () => {
    it("does not GC a live PID", () => {
      const s = mgr.create({ pid: 100 });
      const dead = mgr.runLivenessSweep(0);
      assert.deepEqual(dead, []);
      assert.ok(mgr.get(s.sessionId));
    });

    it("requires sustained absence before marking dead", () => {
      const s = mgr.create({ pid: 100 });
      alivePids.delete(100);
      mgr.runLivenessSweep(0);
      assert.equal(mgr.get(s.sessionId)?.markedDeadAt, null);
      mgr.runLivenessSweep(10_001);
      assert.ok(mgr.get(s.sessionId)?.markedDeadAt !== null);
    });

    it("hard-GCs after the reattach window expires", () => {
      const s = mgr.create({ pid: 100 });
      alivePids.delete(100);
      mgr.runLivenessSweep(0);
      mgr.runLivenessSweep(10_001);
      mgr.runLivenessSweep(10_001 + 30_001);
      assert.equal(mgr.get(s.sessionId), undefined);
    });

    it("returns hard-GCed sessions from runLivenessSweep", () => {
      const a = mgr.create({ pid: 100 });
      const b = mgr.create({ pid: 200 });
      alivePids.clear();
      mgr.runLivenessSweep(0);
      mgr.runLivenessSweep(10_001);
      const dead = mgr.runLivenessSweep(10_001 + 30_001);
      assert.equal(dead.length, 2);
      const ids = dead.map((s) => s.sessionId).sort();
      assert.deepEqual(ids, [a.sessionId, b.sessionId].sort());
    });

    it("recovers if PID becomes alive again before mark-dead", () => {
      const s = mgr.create({ pid: 100 });
      alivePids.delete(100);
      mgr.runLivenessSweep(0);
      alivePids.add(100);
      mgr.runLivenessSweep(5_000);
      assert.equal(mgr.get(s.sessionId)?.markedDeadAt, null);
    });

    it("recovers a dead-but-still-tracked session if PID returns within reattach window", () => {
      const s = mgr.create({ pid: 100 });
      alivePids.delete(100);
      mgr.runLivenessSweep(0);
      mgr.runLivenessSweep(10_001);
      assert.ok(mgr.get(s.sessionId)?.markedDeadAt !== null);
      alivePids.add(100);
      mgr.runLivenessSweep(15_000);
      assert.equal(mgr.get(s.sessionId)?.markedDeadAt, null);
    });
  });
});
