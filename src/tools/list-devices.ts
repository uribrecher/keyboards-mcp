import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listOutputPorts, listInputPorts } from "../midi/midi-manager.js";
import type { DevicePool } from "../shared/device-pool.js";
import { readAllWithStaleFlag, type MockRegistryEntry } from "../shared/mock-registry.js";
import { listAllDevices, MCBError, type Manifest } from "../shared/mcb-client.js";

const MockRegistrySchema = z.object({
  midiPort: z.string(),
  wsPort: z.number(),
  modelId: z.string(),
  displayName: z.string(),
  label: z.string(),
  pid: z.number(),
  startedAt: z.string(),
  lastTouched: z.string(),
  stale: z.boolean(),
});

const PoolMarkerSchema = z.object({
  index: z.number(),
  model: z.string(),
  label: z.string().optional(),
  role: z.enum(["output", "input", "forward"]),
});

const LeaseSchema = z.object({
  kind: z.enum(["primary", "shadow"]),
  sessionId: z.string(),
  deviceId: z.string(),
  model: z.string(),
  label: z.string(),
});

const OutputPortSchema = z.object({
  index: z.number(),
  name: z.string(),
  mock: MockRegistrySchema.optional(),
  poolMarkers: z.array(PoolMarkerSchema),
  lease: LeaseSchema.optional(),
});

const InputPortSchema = z.object({
  index: z.number(),
  name: z.string(),
  poolMarkers: z.array(PoolMarkerSchema),
});

const ListMidiDevicesOutputSchema = {
  outputs: z.array(OutputPortSchema),
  inputs: z.array(InputPortSchema),
  mcb: z.object({
    queried: z.boolean(),
    reachable: z.boolean(),
    error: z.string().optional(),
  }),
};

export function registerListDevices(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "list_midi_devices",
    {
      description:
        "List all MIDI output and input ports as structured data. " +
        "Each output port carries optional `mock` (registry metadata for ports that belong to a running mock-runner mock, including stale flag), " +
        "`poolMarkers` (entries from this MCP's local pool that bind to the port), " +
        "and `lease` (annotation from MCB if any session currently holds a lease on that port as primary or shadow). " +
        "The `mcb` object reports whether MCB was queried and reachable.",
      outputSchema: ListMidiDevicesOutputSchema,
    },
    async () => {
      const outputs = listOutputPorts();
      const inputs = listInputPorts();

      // Mock-registry annotations.
      const registryByPort = new Map<string, MockRegistryEntry & { stale: boolean }>();
      for (const entry of readAllWithStaleFlag()) registryByPort.set(entry.midiPort, entry);

      // MCP-local pool markers (per output / forward / input).
      const outputMarkers = new Map<string, Array<z.infer<typeof PoolMarkerSchema>>>();
      const inputMarkers = new Map<string, Array<z.infer<typeof PoolMarkerSchema>>>();
      const pushMarker = (map: Map<string, Array<z.infer<typeof PoolMarkerSchema>>>, port: string, marker: z.infer<typeof PoolMarkerSchema>) => {
        const arr = map.get(port) ?? [];
        arr.push(marker);
        map.set(port, arr);
      };
      for (const entry of pool.list()) {
        const ports = entry.ports;
        if (!ports) continue;
        const baseMarker = { index: entry.index, model: entry.device.model.info.displayName, label: entry.device.label };
        if (ports.output) pushMarker(outputMarkers, ports.output, { ...baseMarker, role: "output" });
        if (ports.forward && ports.forward !== ports.output) {
          pushMarker(outputMarkers, ports.forward, { ...baseMarker, role: "forward" });
        }
        if (ports.input) pushMarker(inputMarkers, ports.input, { ...baseMarker, role: "input" });
      }

      // MCB lease annotations across ALL sessions. Graceful-degrade when MCB is unreachable.
      const leaseByPort = new Map<string, z.infer<typeof LeaseSchema>>();
      let mcbReachable = true;
      let mcbError: string | undefined;
      const mcbQueried = !process.env.MOCK_WS_URL;
      if (mcbQueried) {
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
          mcbReachable = false;
          mcbError = err instanceof MCBError ? `${err.code}: ${err.message}` : String(err);
        }
      } else {
        mcbReachable = false;
      }

      const structuredContent = {
        outputs: outputs.map((p) => {
          const reg = registryByPort.get(p.name);
          return {
            index: p.index,
            name: p.name,
            mock: reg ? {
              midiPort: reg.midiPort, wsPort: reg.wsPort,
              modelId: reg.modelId, displayName: reg.displayName,
              label: reg.label, pid: reg.pid,
              startedAt: reg.startedAt, lastTouched: reg.lastTouched,
              stale: reg.stale,
            } : undefined,
            poolMarkers: outputMarkers.get(p.name) ?? [],
            lease: leaseByPort.get(p.name),
          };
        }),
        inputs: inputs.map((p) => ({
          index: p.index,
          name: p.name,
          poolMarkers: inputMarkers.get(p.name) ?? [],
        })),
        mcb: { queried: mcbQueried, reachable: mcbReachable, error: mcbError },
      };

      // SDK type requires `content`; structuredContent is the canonical payload.
      // Stringified JSON serves as a fallback for clients that don't read structuredContent.
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );
}
