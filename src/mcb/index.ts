#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./http/server.js";
import { LeaseRegistry } from "./lease-registry.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { SessionManager } from "./session-manager.js";
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
  const leases = new LeaseRegistry();
  const bridges = new BridgeRegistry();
  const sessions = new SessionManager();

  const portList = await buildPortListReader();
  await startServer({
    socketPath: SOCKET_PATH,
    leases, bridges, sessions,
    portList, mockRegistry,
  });
  console.log(`[mcb] listening on ${SOCKET_PATH}`);

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
