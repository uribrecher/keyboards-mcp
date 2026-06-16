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
  /**
   * Per-boot UUID for this mock instance. Never recycled — a fresh tab at
   * the same wsPort / label / port name gets a new instanceId. The agent
   * can compare against `lease.mockInstanceId` to tell "same mock, still
   * up" from "different mock at the same port name."
   */
  instanceId: z.string(),
  startedAt: z.string(),
  lastTouched: z.string(),
  stale: z.boolean(),
});

// A pool marker is a *reference* to a pool entry, not a copy of its fields.
// Consumers needing label/model resolve via `index` against `is_connected`'s
// device list. Keeping the marker minimal avoids sync issues (e.g. label
// drift when MidiManager.connectMockWs gets reset by connectForward).
const PoolMarkerSchema = z.object({
  index: z.number(),
  role: z.enum(["output", "input", "forward"]),
});

const LeaseSchema = z.object({
  kind: z.enum(["primary", "shadow"]),
  sessionId: z.string(),
  deviceId: z.string(),
  model: z.string(),
  /**
   * For mock-backed leases, the `instanceId` of the mock active at claim
   * time. `null` for real-keyboard leases. If `mock.instanceId` on the same
   * port differs from this, the lease is bound to a closed mock and the
   * broker's safety net will reap it on the next read.
   */
  mockInstanceId: z.string().nullable(),
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
        "Each output port carries optional `mock` (registry metadata for ports that belong to a running mock-runner mock, including `instanceId` and `stale` flag), " +
        "`poolMarkers` (entries from this MCP's local pool that bind to the port), " +
        "and `lease` (annotation from MCB if any session currently holds a lease on that port as primary or shadow, including `mockInstanceId`). " +
        "Use `mock.instanceId` vs `lease.mockInstanceId` to diagnose connection loss: if they differ, the lease is bound to a closed mock and the agent should reconnect manually. " +
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
        if (eports.output) pushMarker(outputMarkers, eports.output, { index: entry.index, role: "output" });
        if (eports.forward && eports.forward !== eports.output) {
          pushMarker(outputMarkers, eports.forward, { index: entry.index, role: "forward" });
        }
        if (eports.input) pushMarker(inputMarkers, eports.input, { index: entry.index, role: "input" });
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
