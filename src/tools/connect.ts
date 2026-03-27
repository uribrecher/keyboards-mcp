import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";

export function registerConnect(server: McpServer, midi: MidiManager): void {
  server.tool(
    "connect_to_nord",
    "Connect to the Nord Electro 5D via MIDI. Auto-detects the Nord if no port specified. " +
      "You can also specify a port name or index from list_midi_devices.",
    {
      port: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Port name (substring match) or index number. Omit to auto-detect Nord."),
      channel: z
        .number()
        .min(1)
        .max(16)
        .optional()
        .describe("Global MIDI channel (1-16, default 1)"),
      lower_channel: z
        .number()
        .min(1)
        .max(16)
        .optional()
        .describe("MIDI channel for Lower part (1-16, default 2)"),
      upper_channel: z
        .number()
        .min(1)
        .max(16)
        .optional()
        .describe("MIDI channel for Upper part (1-16, default 3)"),
    },
    async ({ port, channel, lower_channel, upper_channel }) => {
      try {
        if (channel !== undefined) {
          midi.setChannel((channel - 1) as any);
        }
        if (lower_channel !== undefined || upper_channel !== undefined) {
          midi.setPartChannels(
            ((lower_channel ?? 2) - 1) as any,
            ((upper_channel ?? 3) - 1) as any
          );
        }

        let result;
        if (port !== undefined) {
          result = midi.connect(port);
        } else {
          result = midi.autoConnect();
        }

        return {
          content: [
            {
              type: "text",
              text: `Connected to: ${result.portName} (global ch ${midi.getChannel() + 1}, lower ch ${midi.getLowerChannel() + 1}, upper ch ${midi.getUpperChannel() + 1})`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "disconnect_from_nord",
    "Disconnect from the currently connected MIDI device.",
    {},
    async () => {
      const was = midi.getConnectedPort();
      midi.disconnect();
      return {
        content: [
          {
            type: "text",
            text: was ? `Disconnected from ${was}` : "No device was connected",
          },
        ],
      };
    }
  );
}
