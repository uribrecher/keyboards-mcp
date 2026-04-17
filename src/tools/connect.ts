import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import type { ModelHolder } from "../shared/model-holder.js";
import { autoDetectModel } from "../shared/model-registry.js";

export function registerConnect(server: McpServer, midi: MidiManager, holder: ModelHolder): void {
  server.registerTool(
    "connect_to_keyboard",
    {
      description: "Connect to a MIDI keyboard. Auto-detects the keyboard model from MIDI port names. " +
        "You can also specify a port name or index from list_midi_devices.",
      inputSchema: {
        port: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Port name (substring match) or index number. Omit to auto-detect."),
        input_port: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Input port name or index to listen on (keyboard's MIDI Output). Omit to auto-detect."),
        forward_port: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Forward port name or index to send passthrough MIDI to (mock device). Omit to auto-detect."),
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
    },
    async ({ port, input_port, forward_port, channel, lower_channel, upper_channel }) => {
      try {
        // Auto-detect keyboard model from MIDI port names
        // If a specific port was given, prioritize it for model detection
        const outputPorts = midi.listOutputPorts();
        const portNames = port !== undefined
          ? [typeof port === "number" ? outputPorts[port]?.name : port].filter(Boolean) as string[]
          : outputPorts.map((p) => p.name);
        const model = await autoDetectModel(portNames);

        if (!model) {
          const portList = portNames.length > 0
            ? portNames.map((n, i) => `  ${i}: ${n}`).join("\n")
            : "  (no MIDI ports found)";
          return {
            content: [
              {
                type: "text",
                text: `Could not auto-detect keyboard model from available MIDI ports:\n${portList}\n\nNo registered keyboard model matches these port names.`,
              },
            ],
            isError: true,
          };
        }

        // Unload any previously loaded model
        holder.unload();

        // Load the detected model
        holder.load(model);

        // Unload model if mock device disconnects
        midi.setOnMockDisconnect(() => {
          holder.unload();
        });

        // Set MIDI channels
        if (channel !== undefined) {
          midi.setChannel((channel - 1) as any);
        }
        if (lower_channel !== undefined || upper_channel !== undefined) {
          midi.setPartChannels(
            ((lower_channel ?? 2) - 1) as any,
            ((upper_channel ?? 3) - 1) as any,
          );
        }

        // Connect MIDI output
        let result;
        if (port !== undefined) {
          result = midi.connect(port);
        } else {
          result = midi.autoConnect(model.info.midiPortPatterns);
        }

        // Auto-connect input
        let inputResult = "";
        try {
          if (input_port !== undefined) {
            const res = midi.connectInput(input_port);
            inputResult = `, input: ${res.portName}`;
          } else {
            const res = midi.autoConnectInput(model.info.midiPortPatterns);
            inputResult = `, input: ${res.portName}`;
          }
        } catch {
          // Input connection is optional
        }

        // Connect forward (passthrough to mock)
        let forwardResult = "";
        try {
          if (forward_port !== undefined) {
            const res = midi.connectForward(forward_port);
            forwardResult = `, forward: ${res.portName}`;
          } else {
            const res = midi.autoConnectForward();
            forwardResult = `, forward: ${res.portName}`;
          }
        } catch (err) {
          if (midi.hasMockPort()) {
            throw new Error(
              `Connected to real hardware but failed to connect forward to mock device: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Attach MIDI connection to device instance
        if (holder.device) {
          holder.device.attach(midi);
        }

        return {
          content: [
            {
              type: "text",
              text: `Detected model: ${model.info.displayName}\n` +
                `Connected to: ${result.portName} (global ch ${midi.getChannel() + 1}, lower ch ${midi.getLowerChannel() + 1}, upper ch ${midi.getUpperChannel() + 1}${inputResult}${forwardResult})`,
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
    },
  );

  server.registerTool(
    "disconnect_from_keyboard",
    {
      description: "Disconnect from the currently connected MIDI device.",
    },
    async () => {
      const modelName = holder.model?.info.displayName;
      const was = midi.getConnectedPort();
      const wasInput = midi.getConnectedInputPort();
      const wasForward = midi.getConnectedForwardPort();
      midi.disconnect();
      holder.unload();
      const parts = [
        was ? `output: ${was}` : null,
        wasInput ? `input: ${wasInput}` : null,
        wasForward ? `forward: ${wasForward}` : null,
      ].filter(Boolean);
      return {
        content: [
          {
            type: "text",
            text: parts.length > 0
              ? `Disconnected from ${parts.join(", ")}${modelName ? ` (${modelName} model unloaded)` : ""}`
              : "No device was connected",
          },
        ],
      };
    },
  );
}
