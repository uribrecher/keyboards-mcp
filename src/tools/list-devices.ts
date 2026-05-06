import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";
import { listMidiPorts, MCBError } from "../shared/mcb-client.js";

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
        "Fails fast when MCB is unreachable — there is no graceful-degradation path.",
      outputSchema: ListMidiDevicesOutputSchema,
    },
    async () => {
      // Source of truth: MCB's GET /v1/midi/ports — it owns OS port
      // enumeration, mock-registry annotation, and lease join. The MCP
      // only adds local pool markers (which MCB doesn't know about).
      let ports;
      try {
        ports = await listMidiPorts();
      } catch (err) {
        if (err instanceof MCBError) {
          return {
            content: [{ type: "text", text: `list_midi_devices failed: ${err.code}: ${err.message}` }],
            isError: true,
          };
        }
        throw err;
      }

      // MCP-local pool markers — keyed by port name, layered on top of MCB's view.
      const outputMarkers = new Map<string, Array<z.infer<typeof PoolMarkerSchema>>>();
      const inputMarkers = new Map<string, Array<z.infer<typeof PoolMarkerSchema>>>();
      const pushMarker = (
        map: Map<string, Array<z.infer<typeof PoolMarkerSchema>>>,
        port: string,
        marker: z.infer<typeof PoolMarkerSchema>,
      ) => {
        const arr = map.get(port) ?? [];
        arr.push(marker);
        map.set(port, arr);
      };
      for (const entry of pool.list()) {
        const eports = entry.ports;
        if (!eports) continue;
        const baseMarker = { index: entry.index, model: entry.device.model.info.displayName, label: entry.device.label };
        if (eports.output) pushMarker(outputMarkers, eports.output, { ...baseMarker, role: "output" });
        if (eports.forward && eports.forward !== eports.output) {
          pushMarker(outputMarkers, eports.forward, { ...baseMarker, role: "forward" });
        }
        if (eports.input) pushMarker(inputMarkers, eports.input, { ...baseMarker, role: "input" });
      }

      const structuredContent = {
        outputs: ports.outputs.map((p, index) => ({
          index,
          name: p.name,
          mock: p.mock,
          poolMarkers: outputMarkers.get(p.name) ?? [],
          lease: p.lease,
        })),
        inputs: ports.inputs.map((p, index) => ({
          index,
          name: p.name,
          poolMarkers: inputMarkers.get(p.name) ?? [],
        })),
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
