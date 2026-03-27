import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";

export function registerListDevices(server: McpServer, midi: MidiManager): void {
  server.tool(
    "list_midi_devices",
    "List all available MIDI output ports. Use this to find the Nord Electro 5D before connecting.",
    {},
    async () => {
      const outputs = midi.listOutputPorts();
      const inputs = midi.listInputPorts();
      const connected = midi.getConnectedPort();

      let text = "## MIDI Output Ports\n";
      if (outputs.length === 0) {
        text += "No MIDI output ports found. Is the Nord connected via USB?\n";
      } else {
        for (const port of outputs) {
          const marker = port.name === connected ? " ← connected" : "";
          text += `  ${port.index}: ${port.name}${marker}\n`;
        }
      }

      text += "\n## MIDI Input Ports\n";
      if (inputs.length === 0) {
        text += "No MIDI input ports found.\n";
      } else {
        for (const port of inputs) {
          text += `  ${port.index}: ${port.name}\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    }
  );
}
