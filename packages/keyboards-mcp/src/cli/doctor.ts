import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { getMcbHealth, type McbHealth } from "../shared/mcb-client.js";
import { plistPath } from "./plist.js";

export type BrokerState = "not-installed" | "loaded-but-unreachable" | "healthy";

/**
 * Classify broker state from a snapshot. A reachable healthy broker is
 * "healthy" regardless of the plist (it may be run by hand); otherwise an
 * installed plist means it's loaded-but-unreachable; with no plist it's
 * not-installed.
 */
export function classifyBrokerState(input: {
  plistExists: boolean;
  health: McbHealth | null;
}): BrokerState {
  if (input.health?.ok) return "healthy";
  if (input.plistExists) return "loaded-but-unreachable";
  return "not-installed";
}

const REMEDIATION: Record<BrokerState, string> = {
  "healthy": "Broker daemon is running. You're good to go.",
  "loaded-but-unreachable":
    "The daemon is installed but not answering. Check the broker log (usually " +
    "~/.mcb/mcb.log), then reinstall with `keyboards-mcp install`.",
  "not-installed":
    "The broker daemon is not installed. Run `keyboards-mcp install`.",
};

export interface DoctorDeps {
  home?: string;
  fetchHealth?: () => Promise<McbHealth | null>;
  log?: (msg: string) => void;
}

/** Gather broker state and print remediation. Returns the classified state. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<BrokerState> {
  const home = deps.home ?? homedir();
  const fetchHealth = deps.fetchHealth ?? getMcbHealth;
  const log = deps.log ?? console.log;

  const plistExists = existsSync(plistPath(home));
  // A reachable-but-sick broker (5xx / malformed health) must not crash the
  // doctor command — that's the exact case doctor exists to diagnose. Any
  // probe failure degrades to "not healthy".
  let health: McbHealth | null;
  try {
    health = await fetchHealth();
  } catch {
    health = null;
  }
  const state = classifyBrokerState({ plistExists, health });

  log(`Broker state: ${state}`);
  log(REMEDIATION[state]);
  return state;
}
