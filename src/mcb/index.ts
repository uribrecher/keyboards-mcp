#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { startServer, type StartedServer } from "./http/server.js";
import { LeaseRegistry } from "./lease-registry.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { SessionManager } from "./session-manager.js";
import { prepareSocketPath } from "./socket-cleanup.js";
import { findByMidiPort, readActive, readAllWithStaleFlag } from "../shared/mock-registry.js";
import type { MockRegistryReader, PortListReader } from "./types.js";

const SOCKET_PATH = process.env.MCB_SOCKET ?? join(homedir(), ".mcb", "sock");

// Lazy easymidi loading. When MIDI_TRANSPORT=ws (CI / containers without ALSA),
// easymidi is never imported; OS port lists are empty.
async function buildPortListReader(): Promise<PortListReader> {
  if (process.env.MIDI_TRANSPORT === "ws") {
    return { listOutputs: () => [], listInputs: () => [] };
  }
  try {
    const easymidi = (await import("easymidi")).default;
    return { listOutputs: () => easymidi.getOutputs(), listInputs: () => easymidi.getInputs() };
  } catch (err) {
    console.warn("[mcb] easymidi not available, OS port list will be empty:", (err as Error).message);
    return { listOutputs: () => [], listInputs: () => [] };
  }
}

const mockRegistry: MockRegistryReader = {
  findByLabel: (label) => readActive().find((e) => e.label === label),
  findByMidiPort: (midiPort) => findByMidiPort(midiPort),
  list: () => readActive(),
  listAllWithStale: () => readAllWithStaleFlag(),
};

const LIVENESS_SWEEP_INTERVAL_MS = 1000;

(async () => {
  await prepareSocketPath(SOCKET_PATH);

  const leases = new LeaseRegistry();
  const bridges = new BridgeRegistry();
  const sessions = new SessionManager();

  const portList = await buildPortListReader();
  const server = await startServer({
    socketPath: SOCKET_PATH,
    leases, bridges, sessions,
    portList, mockRegistry,
  });
  console.log(`[mcb] listening on ${SOCKET_PATH}`);

  installShutdownHandlers(server, SOCKET_PATH);

  // Periodic PID-liveness sweep. Hard-GCed sessions get their leases + bridges
  // released so subsequent claims on the same port aren't blocked forever.
  setInterval(() => {
    const reaped = sessions.runLivenessSweep();
    for (const session of reaped) {
      for (const deviceId of session.ownedDeviceIds) {
        if (bridges.shadowOf(deviceId)) bridges.remove(deviceId);
        leases.remove(deviceId);
      }
      console.log(
        `[mcb] reaped session ${session.sessionId} ` +
        `(pid ${session.pid}${session.processName ? ` ${session.processName}` : ""}, ` +
        `${session.ownedDeviceIds.size} lease(s) released)`,
      );
    }
  }, LIVENESS_SWEEP_INTERVAL_MS).unref();
})().catch((err) => { console.error(err); process.exit(1); });

function installShutdownHandlers(server: StartedServer, socketPath: string): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[mcb] received ${signal}, shutting down`);
    // Unlink BEFORE awaiting server.stop() so a successor MCB starting in the
    // shutdown window doesn't have its fresh socket clobbered by our cleanup.
    // The OS-level binding is held by the open server until close completes,
    // so existing connections drain unaffected; new clients get ENOENT and can
    // reach a successor's socket once it binds.
    try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* best-effort */ }
    void server.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}
