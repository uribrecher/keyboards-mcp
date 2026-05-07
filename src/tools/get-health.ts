import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";
import { getCachedSessionId, getMcbHealth } from "../shared/mcb-client.js";

const McbHealthSchema = z.object({
  ok: z.boolean(),
  uptimeSec: z.number(),
  sessionsActive: z.number(),
  devicesConnected: z.number(),
});

const GetHealthOutputSchema = {
  mcbReachable: z.boolean(),
  mcbHealth: McbHealthSchema.nullable(),
  sessionId: z.string().nullable(),
  deviceCount: z.number(),
};

export function registerGetHealth(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "get_health",
    {
      description:
        "Report this MCP's broker connectivity, current MCB session id, and " +
        "local device-pool size. " +
        "`mcbReachable` is true when GET /v1/health returned 200; `mcbHealth` " +
        "is the broker payload verbatim when reachable, otherwise null. " +
        "`sessionId` is the MCP's current cached MCB session id, or null if " +
        "no session has been minted yet (the session is created lazily on the " +
        "first connect_to_keyboard call) or was dropped after a session-lost " +
        "event. `deviceCount` is the number of devices in the local pool.",
      outputSchema: GetHealthOutputSchema,
    },
    async () => {
      const mcbHealth = await getMcbHealth();
      const structuredContent = {
        mcbReachable: mcbHealth !== null,
        mcbHealth,
        sessionId: getCachedSessionId(),
        deviceCount: pool.size(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );
}
