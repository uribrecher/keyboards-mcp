#!/usr/bin/env node
import { startServer } from "./http/server.js";
import { LeaseRegistry } from "./lease-registry.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { SessionManager } from "./session-manager.js";
import easymidi from "easymidi";
import { findByMidiPort, readActive } from "../shared/mock-registry.js";
import type { MockRegistryReader } from "./types.js";

const SOCKET_PATH = process.env.MCB_SOCKET ?? `${process.env.HOME}/.mcb/sock`;

const portList = { listOutputs: () => easymidi.getOutputs(), listInputs: () => easymidi.getInputs() };
const mockRegistry: MockRegistryReader = {
  findByLabel: (label) => readActive().find((e) => e.label === label),
  findByMidiPort: (midiPort) => findByMidiPort(midiPort),
  list: () => readActive(),
};

(async () => {
  await startServer({
    socketPath: SOCKET_PATH,
    leases: new LeaseRegistry(),
    bridges: new BridgeRegistry(),
    sessions: new SessionManager(),
    portList, mockRegistry,
  });
  console.log(`[mcb] listening on ${SOCKET_PATH}`);
})().catch((err) => { console.error(err); process.exit(1); });
