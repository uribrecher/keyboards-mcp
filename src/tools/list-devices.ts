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
      // Source of truth: MCB's GET /v1/midi/ports — it owns OS port
      // enumeration, mock-registry annotation, and lease join. The MCP
      // only adds local pool markers (which MCB doesn't know about).
      const mcbQueried = !process.env.MOCK_WS_URL;
      let outputs: Array<{ name: string; mock?: z.infer<typeof MockRegistrySchema>; lease?: z.infer<typeof LeaseSchema> }> = [];
      let inputs: Array<{ name: string }> = [];
      let mcbReachable = mcbQueried;
      let mcbError: string | undefined;
      if (mcbQueried) {
        try {
          const ports = await listMidiPorts();
          outputs = ports.outputs;
          inputs = ports.inputs;
        } catch (err) {
          mcbReachable = false;
          mcbError = err instanceof MCBError ? `${err.code}: ${err.message}` : String(err);
        }
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
        const ports = entry.ports;
        if (!ports) continue;
        const baseMarker = { index: entry.index, model: entry.device.model.info.displayName, label: entry.device.label };
        if (ports.output) pushMarker(outputMarkers, ports.output, { ...baseMarker, role: "output" });
        if (ports.forward && ports.forward !== ports.output) {
          pushMarker(outputMarkers, ports.forward, { ...baseMarker, role: "forward" });
        }
        if (ports.input) pushMarker(inputMarkers, ports.input, { ...baseMarker, role: "input" });
      }

      const structuredContent = {
        outputs: outputs.map((p, index) => ({
          index,
          name: p.name,
          mock: p.mock,
          poolMarkers: outputMarkers.get(p.name) ?? [],
          lease: p.lease,
        })),
        inputs: inputs.map((p, index) => ({
          index,
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
