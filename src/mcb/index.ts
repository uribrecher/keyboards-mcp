#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "./http/server.js";
import { LeaseRegistry } from "./lease-registry.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { SessionManager } from "./session-manager.js";
import { findByMidiPort, readActive } from "../shared/mock-registry.js";
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
};

(async () => {
  const portList = await buildPortListReader();
  await startServer({
    socketPath: SOCKET_PATH,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager(),
    portList, mockRegistry,
  });
  console.log(`[mcb] listening on ${SOCKET_PATH}`);
})().catch((err) => { console.error(err); process.exit(1); });
