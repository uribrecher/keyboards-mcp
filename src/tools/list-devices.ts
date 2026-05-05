import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listOutputPorts, listInputPorts } from "../midi/midi-manager.js";
import type { DevicePool } from "../shared/device-pool.js";
import { readAllWithStaleFlag, type MockRegistryEntry } from "../shared/mock-registry.js";
import { listAllDevices, MCBError, type Manifest } from "../mcp-client/mcb-client.js";

export function registerListDevices(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "list_midi_devices",
    {
      description: "List all available MIDI output and input ports. " +
        "Each output port that belongs to a running mock-runner mock is annotated with " +
        "the mock's label and WebSocket port. Pool-bound ports also carry the pool device index. " +
        "Stale registry entries (process gone or no recent heartbeat) are tagged with `(stale)`. " +
        "Ports currently leased by any MCB session are annotated with `leased_by`/`shadowed_by` and the owning session id.",
    },
    async () => {
      const outputs = listOutputPorts();
      const inputs = listInputPorts();

      // Mock registry annotations (per-port).
      const registryByPort = new Map<string, MockRegistryEntry & { stale: boolean }>();
      for (const entry of readAllWithStaleFlag()) registryByPort.set(entry.midiPort, entry);

      // MCP-local pool markers (per output / forward / input).
      const outputMarkers = new Map<string, string[]>();
      const inputMarkers = new Map<string, string[]>();
      for (const entry of pool.list()) {
        const labelStr = entry.device.label ? ` "${entry.device.label}"` : "";
        const tag = `device ${entry.index}: ${entry.device.model.info.displayName}${labelStr}`;
        const ports = entry.ports;
        if (!ports) continue;
        if (ports.output) {
          const arr = outputMarkers.get(ports.output) ?? [];
          arr.push(`${tag} (output)`);
          outputMarkers.set(ports.output, arr);
        }
        if (ports.forward && ports.forward !== ports.output) {
          const arr = outputMarkers.get(ports.forward) ?? [];
          arr.push(`${tag} (forward)`);
          outputMarkers.set(ports.forward, arr);
        }
        if (ports.input) {
          const arr = inputMarkers.get(ports.input) ?? [];
          arr.push(`${tag} (input)`);
          inputMarkers.set(ports.input, arr);
        }
      }

      // MCB lease annotations across ALL sessions. Graceful-degrade when MCB is unreachable.
      const leaseByPort = new Map<string, { kind: "primary" | "shadow"; sessionId: string; deviceId: string; model: string; label: string }>();
      let mcbWarning: string | null = null;
      if (!process.env.MOCK_WS_URL) {
        try {
          const all: Manifest[] = await listAllDevices();
          for (const m of all) {
            leaseByPort.set(m.primary.portName, {
              kind: "primary", sessionId: m.ownerSessionId, deviceId: m.deviceId, model: m.model, label: m.label,
            });
            if (m.shadow) {
              leaseByPort.set(m.shadow.portName, {
                kind: "shadow", sessionId: m.ownerSessionId, deviceId: m.deviceId, model: m.model, label: m.label,
              });
            }
          }
        } catch (err) {
          mcbWarning = err instanceof MCBError
            ? `(MCB unreachable: ${err.code}; lease annotations unavailable)`
            : `(MCB query failed; lease annotations unavailable)`;
        }
      }

      const formatLine = (port: { index: number; name: string }, markers: Map<string, string[]>) => {
        const reg = registryByPort.get(port.name);
        const tags = markers.get(port.name);
        const lease = leaseByPort.get(port.name);
        let regTag = "";
        if (reg) {
          regTag = `[${reg.label}] ws:${reg.wsPort}`;
          if (reg.stale) regTag += " (stale)";
          regTag += " ";
        }
        const poolTag = tags && tags.length > 0 ? ` ← ${tags.join(", ")}` : "";
        let leaseTag = "";
        if (lease) {
          const verb = lease.kind === "primary" ? "leased_by" : "shadowed_by";
          leaseTag = `  {${verb}: session ${lease.sessionId.slice(0, 8)}, model "${lease.model}"${lease.label && lease.label !== "default" ? `, label "${lease.label}"` : ""}}`;
        }
        return `  ${port.index}: ${port.name}  ${regTag}${poolTag}${leaseTag}`.trimEnd();
      };

      let text = "## MIDI Output Ports\n";
      if (outputs.length === 0) {
        text += "No MIDI output ports found. Is the keyboard connected via USB?\n";
      } else {
        text += outputs.map((p) => formatLine(p, outputMarkers)).join("\n") + "\n";
      }

      text += "\n## MIDI Input Ports\n";
      if (inputs.length === 0) {
        text += "No MIDI input ports found.\n";
      } else {
        text += inputs.map((p) => formatLine(p, inputMarkers)).join("\n") + "\n";
      }

      if (mcbWarning) text += `\n${mcbWarning}\n`;

      return { content: [{ type: "text", text }] };
    },
  );
}
