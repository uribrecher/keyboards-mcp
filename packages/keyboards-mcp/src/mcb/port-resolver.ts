import type { Direction, PortListReader, MockRegistryReader, PortInfo } from "./types.js";

export class PortResolutionError extends Error {
  constructor(public code: "port-not-found" | "ambiguous-port", message: string, public details: Record<string, unknown>) {
    super(`${code}: ${message}`);
  }
}

export function resolvePort(
  arg: string,
  direction: Direction,
  ports: PortListReader,
  registry: MockRegistryReader,
): PortInfo {
  const osPorts = direction === "output" ? ports.listOutputs() : ports.listInputs();
  const candidates: Array<{ portName: string; wsPort?: number }> = [];

  // Mock label match (output only)
  if (direction === "output") {
    const m = registry.findByLabel(arg);
    if (m) candidates.push({ portName: m.midiPort, wsPort: m.wsPort });
  }

  // OS exact match
  if (osPorts.includes(arg)) {
    const m = registry.findByMidiPort(arg);
    candidates.push({ portName: arg, wsPort: m?.wsPort });
  }

  const unique = new Set(candidates.map((c) => c.portName));
  if (unique.size === 0) {
    throw new PortResolutionError("port-not-found", `Port not found: '${arg}'`,
      { arg, direction, availableMockLabels: direction === "output" ? registry.list().map((e) => e.label) : [], availableOsPorts: osPorts });
  }
  if (unique.size > 1) {
    throw new PortResolutionError("ambiguous-port", `Ambiguous port name '${arg}'`,
      { arg, candidates: candidates.map((c) => c.portName) });
  }

  const [chosen] = candidates;
  if (!osPorts.includes(chosen.portName)) {
    throw new PortResolutionError("port-not-found",
      `Port '${chosen.portName}' resolved from '${arg}' is not currently visible to the OS`,
      { arg, resolvedTo: chosen.portName });
  }
  return { portName: chosen.portName, wsPort: chosen.wsPort ?? null };
}
