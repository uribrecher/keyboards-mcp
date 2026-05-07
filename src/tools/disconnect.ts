import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";
import { releaseLease, MCBError, MCBSessionLostError } from "../shared/mcb-client.js";

export function registerDisconnect(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "disconnect_from_keyboard",
    {
      description: "Disconnect a connected MIDI device. " +
        "If multiple devices are connected, pass `device` (1-based index from is_connected). " +
        "If only one device is connected, the index can be omitted.",
      inputSchema: {
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("1-based device index from is_connected. Required when more than one device is connected."),
      },
    },
    async ({ device }) => {
      let entry;
      try {
        entry = pool.resolve(device);
      } catch (err) {
        if (pool.size() === 0) {
          return {
            content: [{ type: "text", text: "No device was connected" }],
          };
        }
        return {
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        };
      }

      const { index, device: kdev } = entry;
      const modelName = kdev.model.info.displayName;
      const labelStr = kdev.label ? ` "${kdev.label}"` : "";
      const mcbDeviceId = entry.ports?.mcbDeviceId;
      pool.disconnect(index);

      // Release the MCB lease (if any). Tolerate failure — local cleanup already happened
      // and MCB will GC the lease eventually anyway.
      let mcbNote = "";
      if (mcbDeviceId) {
        try {
          await releaseLease(mcbDeviceId);
          mcbNote = ` (lease ${mcbDeviceId} released)`;
        } catch (err) {
          if (err instanceof MCBSessionLostError) {
            // The session-lost callback already disconnected every other device
            // in the pool. Surface that to the caller — it is not a normal release.
            mcbNote = ` (session-lost: dropped ${err.droppedLeaseCount} local lease(s))`;
          } else if (err instanceof MCBError) {
            console.warn(`[mcp] MCB release failed (non-fatal): ${err.code}: ${err.message}`);
            mcbNote = ` (warning: lease release failed: ${err.code})`;
          } else {
            throw err;
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Disconnected device ${index}: ${modelName}${labelStr}${mcbNote}`,
          },
        ],
      };
    },
  );
}
