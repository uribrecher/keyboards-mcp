import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";
import { listMyDevices, MCBError, type Manifest } from "../shared/mcb-client.js";

export function registerIsConnected(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "is_connected",
    {
      description: "List all connected MIDI keyboards with their indices, models, labels, and shadow ports. " +
        "Source of truth is midi-connections-broker (MCB); the local pool provides 1-based indices. " +
        "Use the returned indices in other tools' optional `device` parameter.",
    },
    async () => {
      const entries = pool.list();
      if (entries.length === 0) {
        return {
          content: [
            { type: "text", text: "Not connected. Call connect_to_keyboard to establish a MIDI connection." },
          ],
        };
      }

      // WS-transport mode (CI/Docker) doesn't go through MCB; render the local pool only.
      if (process.env.MOCK_WS_URL) {
        const lines = entries.map((entry) => {
          const labelStr = entry.device.label ? ` "${entry.device.label}"` : "";
          return `  device ${entry.index}: ${entry.device.model.info.displayName}${labelStr}`;
        });
        const summary = entries.length === 1 ? "1 device connected" : `${entries.length} devices connected`;
        return { content: [{ type: "text", text: `${summary} (WS-transport mode):\n${lines.join("\n")}` }] };
      }

      // MCB-managed: query for canonical lease state, then join with local pool indexing.
      let mcbDevices: Manifest[];
      try {
        mcbDevices = await listMyDevices();
      } catch (err) {
        if (err instanceof MCBError) {
          return {
            content: [{ type: "text", text: `Cannot reach MCB (${err.code}: ${err.message})` }],
            isError: true,
          };
        }
        throw err;
      }
      const mcbById = new Map(mcbDevices.map((m) => [m.deviceId, m]));

      const lines = entries.map((entry) => {
        const id = entry.ports?.mcbDeviceId;
        if (!id) {
          const labelStr = entry.device.label ? ` "${entry.device.label}"` : "";
          return `  device ${entry.index}: ${entry.device.model.info.displayName}${labelStr} (local-only, no MCB lease)`;
        }
        const m = mcbById.get(id);
        if (!m) return `  device ${entry.index}: ⚠ stale — MCB no longer has lease ${id}`;
        const shadow = m.shadow ? `, shadows: ${m.shadow.portName}` : "";
        const labelStr = entry.device.label ? ` "${entry.device.label}"` : "";
        return `  device ${entry.index}: ${m.model}${labelStr} on ${m.primary.portName}${shadow}`;
      });

      const summary = entries.length === 1 ? "1 device connected" : `${entries.length} devices connected`;
      return { content: [{ type: "text", text: `${summary}:\n${lines.join("\n")}` }] };
    },
  );
}
