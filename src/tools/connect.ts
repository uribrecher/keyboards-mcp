import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MidiManager, listOutputPorts } from "../midi/midi-manager.js";
import type { DevicePool } from "../shared/device-pool.js";
import { autoDetectModel, loadModelById } from "../shared/model-registry.js";
import { WsMidiConnection } from "../midi/ws-midi-connection.js";
import type { KeyboardModel, KeyboardDevice } from "../shared/keyboard-model.js";
import { findByMidiPort } from "../shared/mock-registry.js";

/** Same sanitizer as the model-level backup-cache. */
function sanitizeLabelForCache(label: string | undefined | null): string {
  if (!label) return "_default";
  let slug = label.trim().toLowerCase();
  slug = slug.replace(/\s+/g, "-");
  slug = slug.replace(/[^a-z0-9._-]/g, "");
  if (slug === "" || slug === "." || slug === ".." || slug.includes("..")) {
    return "_default";
  }
  return slug;
}

function createDeviceForModel(model: KeyboardModel, label?: string): KeyboardDevice {
  if (!model.createDevice) {
    throw new Error(`Model ${model.info.displayName} does not provide a device factory.`);
  }
  const cacheLabel = sanitizeLabelForCache(label);
  model.backupCache?.load(cacheLabel);
  const device = model.createDevice();
  if (label) device.label = label;
  const backupData = model.backupCache?.get(cacheLabel);
  if (backupData) {
    device.backupData = backupData;
  }
  return device;
}

export function registerConnect(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "connect_to_keyboard",
    {
      description: "Connect to a MIDI keyboard. Auto-detects the keyboard model from MIDI port names. " +
        "You can also specify a port name or index from list_midi_devices. " +
        "Multiple devices can be connected simultaneously — each gets a 1-based index returned in the response. " +
        "Use that index in other tools' optional `device` parameter to target a specific keyboard. " +
        "\n\nTwo connection patterns:\n" +
        "  1) Synced pair (one pool entry, real hw + its mock): pass `port` (real hw) and let " +
        "`forward_port` auto-detect (or set explicitly). Leave `auto_input` and `auto_forward` " +
        "at default true — the input listener is what mirrors physical knob/button changes from " +
        "the real keyboard to the mock UI.\n" +
        "  2) Standalone pool member (each device owns its own ports): set `auto_input: false` " +
        "and `auto_forward: false` so devices don't share an input port name or accidentally " +
        "forward into another pool entry's primary output.",
      inputSchema: {
        port: z
          .union([z.string(), z.coerce.number()])
          .optional()
          .describe("Port name (substring match) or index number. Omit to auto-detect."),
        input_port: z
          .union([z.string(), z.coerce.number()])
          .optional()
          .describe("Input port name or index to listen on (keyboard's MIDI Output). Omit to auto-detect."),
        forward_port: z
          .union([z.string(), z.coerce.number()])
          .optional()
          .describe("Forward port name or index to send passthrough MIDI to (mock device). Omit to auto-detect."),
        channel: z.coerce.number()
          .min(1)
          .max(16)
          .optional()
          .describe("Global MIDI channel (1-16, default 1)"),
        lower_channel: z.coerce.number()
          .min(1)
          .max(16)
          .optional()
          .describe("MIDI channel for Lower part (1-16, default 2)"),
        upper_channel: z.coerce.number()
          .min(1)
          .max(16)
          .optional()
          .describe("MIDI channel for Upper part (1-16, default 3)"),
        label: z
          .string()
          .optional()
          .describe("Optional user-assigned label for this device instance (e.g. 'studio Nord')."),
        mock_ws_port: z.coerce.number()
          .optional()
          .describe("WebSocket port for this device's mock (overrides MOCK_WS_PORT env). Useful when running multiple mocks simultaneously."),
        auto_input: z
          .union([z.boolean(), z.enum(["true", "false"])])
          .optional()
          .describe("Auto-detect a matching MIDI input port (default: true). Set to false ONLY for standalone pool members — synced pairs need this true so physical changes mirror to the mock."),
        auto_forward: z
          .union([z.boolean(), z.enum(["true", "false"])])
          .optional()
          .describe("Auto-detect a mock port to forward outgoing MIDI to (default: true). Set to false ONLY for standalone pool members or when connecting directly to a mock — synced pairs need this true."),
      },
    },
    async ({ port, input_port, forward_port, channel, lower_channel, upper_channel, label, mock_ws_port, auto_input, auto_forward }) => {
      const coerceBool = (v: boolean | "true" | "false" | undefined): boolean | undefined => {
        if (v === undefined) return undefined;
        return typeof v === "boolean" ? v : v === "true";
      };
      const autoInput = coerceBool(auto_input);
      const autoForward = coerceBool(auto_forward);
      try {
        // WS transport mode (for CI/Docker — no real MIDI)
        const wsUrl = process.env.MOCK_WS_URL;
        if (wsUrl) {
          // WS mode is single-device: env vars MOCK_WS_URL and MOCK_MODEL_ID
          // are set once at MCP server startup, so a second connect would
          // bind another pool entry to the same model/url. Block it explicitly
          // so the caller gets a useful error instead of a confusing duplicate.
          if (pool.size() > 0) {
            return {
              content: [{ type: "text", text: "WebSocket transport mode (MOCK_WS_URL) only supports one connected device per MCP server process. Use a separate MCP server (with its own MOCK_WS_URL/MOCK_MODEL_ID env) for each additional device." }],
              isError: true,
            };
          }
          const modelId = process.env.MOCK_MODEL_ID;
          if (!modelId) {
            return {
              content: [{ type: "text", text: "MOCK_WS_URL is set but MOCK_MODEL_ID is missing." }],
              isError: true,
            };
          }
          const model = await loadModelById(modelId);
          const device = createDeviceForModel(model, label);
          const wsConn = await WsMidiConnection.connect(wsUrl);
          device.attach(wsConn);
          const index = pool.connect(device, () => { wsConn.close?.(); });
          return {
            content: [{
              type: "text",
              text: `Detected model: ${model.info.displayName}\n` +
                `Connected via WebSocket: ${wsUrl}\n` +
                `Assigned device ${index}${label ? ` "${label}"` : ""}.`,
            }],
          };
        }

        // Auto-detect keyboard model from MIDI port names
        // If a specific port was given, prioritize it for model detection
        const outputPorts = listOutputPorts();
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

        // Resolve the primary port name we'll bind to so we can look it up
        // in the runtime mock registry (label discovery, plan #7).
        const candidatePortName: string | undefined = port !== undefined
          ? (typeof port === "number" ? outputPorts[port]?.name : port)
          : outputPorts.find((p) =>
              model!.info.midiPortPatterns.some((pat) =>
                p.name.toLowerCase().includes(pat.toLowerCase())))?.name;
        const registryEntry = candidatePortName ? findByMidiPort(candidatePortName) : undefined;

        // Effective label: explicit `label` arg > running mock's advertised label > undefined.
        const effectiveLabel = label ?? registryEntry?.label;
        // Effective mock WS port: explicit > registry > env/default (handled inside MidiManager).
        const effectiveMockWsPort = mock_ws_port ?? registryEntry?.wsPort;

        // Per-device MidiManager owns this device's output, input, forward, and mock WS
        const midi = new MidiManager();
        if (effectiveMockWsPort !== undefined) midi.setMockWsPort(effectiveMockWsPort);
        const device = createDeviceForModel(model, effectiveLabel);

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

        // Connect input — explicit port wins; auto-detect only if autoInput !== false
        let inputResult = "";
        if (input_port !== undefined) {
          try {
            const res = midi.connectInput(input_port);
            inputResult = `, input: ${res.portName}`;
          } catch { /* explicit port: best-effort */ }
        } else if (autoInput !== false) {
          try {
            const res = midi.autoConnectInput(model.info.midiPortPatterns);
            inputResult = `, input: ${res.portName}`;
          } catch { /* auto-input optional */ }
        }

        // Connect forward — explicit port wins; auto-detect only if autoForward !== false
        // AND the primary output is not itself a mock port. Skipping auto-forward
        // when primary is a mock prevents cross-mock leakage: e.g., connecting
        // to "Prophet-6 Mock" must not forward every CC into "Nord ... Mock"
        // just because that's the first port matching "mock".
        let forwardResult = "";
        const primaryOutputName = midi.getConnectedPort() ?? "";
        const primaryOutputIsMock = primaryOutputName.toLowerCase().includes("mock");
        if (forward_port !== undefined) {
          try {
            const res = midi.connectForward(forward_port);
            forwardResult = `, forward: ${res.portName}`;
          } catch (err) {
            throw new Error(
              `Failed to connect to forward port ${forward_port}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else if (autoForward !== false && !primaryOutputIsMock) {
          try {
            const res = midi.autoConnectForward();
            forwardResult = `, forward: ${res.portName}`;
          } catch (err) {
            if (midi.hasMockPort()) {
              throw new Error(
                `Connected to real hardware but failed to connect forward to mock device: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        // If the primary output is itself a mock port and we didn't open a
        // forward (which would have opened the status WS), attach a status-only
        // WebSocket so the mock UI shows "MCP connected".
        const primaryName = midi.getConnectedPort() ?? "";
        const primaryIsMock = primaryName.toLowerCase().includes("mock");
        if (primaryIsMock && !midi.getConnectedForwardPort()) {
          midi.attachMockStatusWs();
        }

        device.attach(midi);
        const index = pool.connect(
          device,
          () => { midi.disconnect(); },
          {
            output: midi.getConnectedPort() ?? undefined,
            input: midi.getConnectedInputPort() ?? undefined,
            forward: midi.getConnectedForwardPort() ?? undefined,
          },
        );

        // Live-track label changes from the mock (plan #7). When the user
        // renames a tab in the mock-runner, the engine relabels and starts
        // broadcasting the new label; the MidiManager picks it up and we
        // update the pool entry's device.label so subsequent
        // `is_connected` and `extract_backup` calls see the new label.
        midi.setOnMockLabel((newLabel) => {
          const entry = pool.get(index);
          if (entry) entry.device.label = newLabel;
        });

        // If the mock disappears, drop only this device — leave others alone
        midi.setOnMockDisconnect(() => {
          const entry = pool.get(index);
          if (entry) {
            try { pool.disconnect(index); } catch { /* already gone */ }
          }
        });

        const adoptedLabel = effectiveLabel ?? device.label;
        const labelTag = adoptedLabel ? ` "${adoptedLabel}"` : "";
        const labelSrc = label
          ? "user-provided"
          : registryEntry
            ? "auto-adopted from running mock"
            : "_default";

        return {
          content: [
            {
              type: "text",
              text: `Detected model: ${model.info.displayName}\n` +
                `Connected to: ${result.portName} (global ch ${midi.getChannel() + 1}, lower ch ${midi.getLowerChannel() + 1}, upper ch ${midi.getUpperChannel() + 1}${inputResult}${forwardResult})\n` +
                `Assigned device ${index}${labelTag}. Label: ${labelSrc}.`,
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
}
