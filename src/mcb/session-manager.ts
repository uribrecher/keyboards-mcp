import { randomUUID } from "node:crypto";
import type { Session } from "./types.js";

export interface SessionManagerOptions {
  /** Returns true if the given PID is alive. Production: `process.kill(pid, 0)` with try/catch. */
  livenessChecker?: (pid: number) => boolean;
  /** ms after the first PID-miss at which the session is marked dead. Default 10_000. */
  deadAfterMissesAtMs?: number;
  /** ms after marked-dead at which the session is hard-GCed. Default 30_000. */
  reattachWindowMs?: number;
  /** Optional clock override for tests. Defaults to Date.now. */
  nowMs?: () => number;
}

const DEFAULT_LIVENESS = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process → actually dead.
    // EPERM: process exists but caller lacks permission → alive (e.g., MCB running as a
    // different user from the MCP). Treat as alive to avoid reaping live sessions.
    // Anything else: best-effort treat as dead so we don't pin leases on truly broken state.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
};

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** sessionId → { firstMissAt: ms | null }  */
  private missState = new Map<string, { firstMissAt: number | null }>();

  private readonly livenessChecker: (pid: number) => boolean;
  private readonly deadAfterMissesAtMs: number;
  private readonly reattachWindowMs: number;
  private readonly nowMs: () => number;

  constructor(opts: SessionManagerOptions = {}) {
    this.livenessChecker = opts.livenessChecker ?? DEFAULT_LIVENESS;
    this.deadAfterMissesAtMs = opts.deadAfterMissesAtMs ?? 10_000;
    this.reattachWindowMs = opts.reattachWindowMs ?? 30_000;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  create(input: { pid: number; processName?: string }): Session {
    const session: Session = {
      sessionId: randomUUID(),
      pid: input.pid,
      processName: input.processName,
      ownedDeviceIds: new Set(),
      createdAt: this.nowMs(),
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

  listAll(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Run one liveness sweep. Returns sessions that are hard-GCed by this sweep
   * (caller is responsible for tearing down their leases / bridges).
   */
  runLivenessSweep(now: number = this.nowMs()): Session[] {
    const hardGCed: Session[] = [];
    for (const [sessionId, session] of this.sessions) {
      const alive = this.livenessChecker(session.pid);
      const ms = this.missState.get(sessionId)!;

      if (alive) {
        ms.firstMissAt = null;
        session.markedDeadAt = null;
        continue;
      }

      // PID is gone.
      if (ms.firstMissAt === null) {
        ms.firstMissAt = now;
        continue;
      }

      const sinceFirstMiss = now - ms.firstMissAt;
      if (session.markedDeadAt === null && sinceFirstMiss >= this.deadAfterMissesAtMs) {
        session.markedDeadAt = now;
        continue;
      }

      if (session.markedDeadAt !== null) {
        const sinceMarkedDead = now - session.markedDeadAt;
        if (sinceMarkedDead >= this.reattachWindowMs) {
          hardGCed.push(session);
          this.delete(sessionId);
        }
      }
    }
    return hardGCed;
  }
}
