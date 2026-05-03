import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listOutputPorts, listInputPorts } from "../midi/midi-manager.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerListDevices(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "list_midi_devices",
    {
      description: "List all available MIDI output and input ports. Use this to find your keyboard before connecting. " +
        "Ports already bound to a connected device show that device's pool index and label.",
    },
    async () => {
      const outputs = listOutputPorts();
      const inputs = listInputPorts();

      // Build reverse lookup: port name -> "(device N: model [label])"
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

      const formatLine = (port: { index: number; name: string }, markers: Map<string, string[]>) => {
        const tags = markers.get(port.name);
        const suffix = tags && tags.length > 0 ? `  ← ${tags.join(", ")}` : "";
        return `  ${port.index}: ${port.name}${suffix}`;
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

      return { content: [{ type: "text", text }] };
    },
  );
}
