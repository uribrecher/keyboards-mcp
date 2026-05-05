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
