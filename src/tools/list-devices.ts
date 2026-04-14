import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";

export function registerListDevices(server: McpServer, midi: MidiManager): void {
  server.registerTool(
    "list_midi_devices",
    {
      description: "List all available MIDI output ports. Use this to find your keyboard before connecting.",
    },
    async () => {
      const outputs = midi.listOutputPorts();
      const inputs = midi.listInputPorts();
      const connected = midi.getConnectedPort();
      const forward = midi.getConnectedForwardPort();
      const input = midi.getConnectedInputPort();

      let text = "## MIDI Output Ports\n";
      if (outputs.length === 0) {
        text += "No MIDI output ports found. Is the keyboard connected via USB?\n";
      } else {
        for (const port of outputs) {
          const marker = port.name === connected ? " ← connected"
            : port.name === forward ? " ← forwarding"
            : "";
          text += `  ${port.index}: ${port.name}${marker}\n`;
        }
      }

      text += "\n## MIDI Input Ports\n";
      if (inputs.length === 0) {
        text += "No MIDI input ports found.\n";
      } else {
        for (const port of inputs) {
          const marker = port.name === input ? " ← listening" : "";
          text += `  ${port.index}: ${port.name}${marker}\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    },
  );
}
