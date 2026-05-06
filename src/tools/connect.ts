import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MidiManager } from "../midi/midi-manager.js";
import type { DevicePool } from "../shared/device-pool.js";
import { loadModelById } from "../shared/model-registry.js";
import { WsMidiConnection } from "../midi/ws-midi-connection.js";
import type { KeyboardModel, KeyboardDevice } from "../shared/keyboard-model.js";
import { findByMidiPort } from "../shared/mock-registry.js";
import { claimLease, MCBError } from "../shared/mcb-client.js";

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
      description:
        "Connect to a MIDI keyboard. Claims a lease via midi-connections-broker (MCB) before opening MIDI/WS, " +
        "so concurrent agent sessions cannot step on each other.\n\n" +
        "Required: `port` (exact OS port name or registered mock label) and `model` (e.g. nord-electro-5d). " +
        "Optional: `with_shadow` (a mock label or OS port to mirror MIDI to — typical pattern is real hw + mock UI), " +
        "`input_port` (the OS port the keyboard sends from), `label`, channel options.\n\n" +
        "MCB must be running for this tool to work (npm run mcb).",
      inputSchema: {
        port: z
          .string()
          .describe("Exact OS port name or registered mock label (e.g. 'Nord Electro 5 MIDI Input' or 'nordi')."),
        model: z
          .string()
          .describe("Model id (e.g. 'nord-electro-5d', 'roland-juno-x', 'prophet-6')."),
        with_shadow: z
          .string()
          .optional()
          .describe("Optional shadow port — every outgoing MIDI is teed to this port. Typical: a mock label so the UI mirrors a real hardware connection."),
        input_port: z
          .string()
          .optional()
          .describe("OS input port name (the keyboard's MIDI Output). Required for physical-knob mirroring to a shadow."),
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
      },
    },
    async ({ port, model: modelId, with_shadow, input_port, channel, lower_channel, upper_channel, label }) => {
      try {
        // WS transport mode (CI / Docker — no real MIDI, no MCB).
        const wsUrl = process.env.MOCK_WS_URL;
        if (wsUrl) {
          if (pool.size() > 0) {
            return {
              content: [{ type: "text", text: "WebSocket transport mode (MOCK_WS_URL) only supports one connected device per MCP server process." }],
              isError: true,
            };
          }
          const wsModelId = process.env.MOCK_MODEL_ID ?? modelId;
          const model = await loadModelById(wsModelId);
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

        // Real-MIDI path: claim lease via MCB.
        let manifest;
        try {
          manifest = await claimLease({
            port,
            model: modelId,
            with_shadow,
            input_port,
            label,
            channel,
            lower_channel,
            upper_channel,
          });
        } catch (err) {
          if (err instanceof MCBError) {
            return {
              content: [{ type: "text", text: `Connection failed: ${err.code}: ${err.message}` }],
              isError: true,
            };
          }
          throw err;
        }

        const model = await loadModelById(manifest.model);

        // If the user didn't pass a label and the primary resolves to a registered mock,
        // adopt the mock's label so backup caches line up.
        let effectiveLabel = label;
        if (effectiveLabel === undefined) {
          const mockEntry = findByMidiPort(manifest.primary.portName);
          if (mockEntry) effectiveLabel = mockEntry.label;
        }
        const device = createDeviceForModel(model, effectiveLabel);

        const midi = new MidiManager();

        // MIDI channels
        if (manifest.channel !== undefined) {
          midi.setChannel((manifest.channel - 1) as Parameters<typeof midi.setChannel>[0]);
        }
        if (manifest.lowerChannel !== undefined || manifest.upperChannel !== undefined) {
          midi.setPartChannels(
            ((manifest.lowerChannel ?? 2) - 1) as Parameters<typeof midi.setPartChannels>[0],
            ((manifest.upperChannel ?? 3) - 1) as Parameters<typeof midi.setPartChannels>[1],
          );
        }

        // Wire mock-label callback BEFORE opening the WS so we don't miss the first message.
        if (label === undefined) {
          midi.setOnMockLabel((newLabel) => { device.label = newLabel; });
        }

        // Open primary MIDI output (and status WS if primary is a mock).
        midi.connect(manifest.primary.portName, manifest.primary.wsPort);

        // Optional input listener.
        let inputResult = "";
        if (manifest.input) {
          try {
            const res = midi.connectInput(manifest.input.portName);
            inputResult = `, input: ${res.portName}`;
          } catch { /* explicit port: best-effort */ }
        }

        // Optional bridge to shadow port (and its mock-status WS if shadow is a mock).
        let forwardResult = "";
        if (manifest.shadow) {
          const res = midi.connectForward(manifest.shadow.portName, manifest.shadow.wsPort);
          forwardResult = `, shadow: ${res.portName}`;
        }

        device.attach(midi);
        const index = pool.connect(
          device,
          () => { midi.disconnect(); },
          {
            output: manifest.primary.portName,
            input: manifest.input?.portName,
            forward: manifest.shadow?.portName,
            mcbDeviceId: manifest.deviceId,
          },
        );

        // If the mock disappears, drop only this device — leave others alone.
        midi.setOnMockDisconnect(() => {
          const entry = pool.get(index);
          if (entry) {
            try { pool.disconnect(index); } catch { /* already gone */ }
          }
        });

        const labelTag = device.label ? ` "${device.label}"` : "";
        return {
          content: [{
            type: "text",
            text: `Detected model: ${model.info.displayName}\n` +
              `Connected to: ${manifest.primary.portName} (global ch ${midi.getChannel() + 1}, lower ch ${midi.getLowerChannel() + 1}, upper ch ${midi.getUpperChannel() + 1}${inputResult}${forwardResult})\n` +
              `Assigned device ${index}${labelTag}. MCB lease: ${manifest.deviceId}.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Connection failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
