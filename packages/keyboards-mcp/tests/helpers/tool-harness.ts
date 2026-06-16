/**
 * Lightweight harness for unit-testing MCP tool wrappers without the SDK
 * transport or a live MCB. A `FakeMcpServer` captures each tool's handler so
 * tests can invoke it directly with already-parsed args.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DevicePool } from "../../src/shared/device-pool.js";
import type { KeyboardDevice } from "../../src/shared/keyboard-model.js";
import nordModel from "../../src/keyboard_models/nord/electro_5d/index.js";
import { FakeMidiConnection } from "./nord-backup-fixture.js";

export interface ToolResultShape {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type CapturedHandler = (args?: Record<string, unknown>) => Promise<ToolResultShape> | ToolResultShape;

/** Captures tools registered via `server.registerTool(name, config, handler)`. */
export class FakeMcpServer {
  readonly handlers = new Map<string, CapturedHandler>();

  registerTool(name: string, _config: unknown, handler: CapturedHandler): void {
    this.handlers.set(name, handler);
  }

  /** Invoke a captured tool handler with parsed args. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResultShape> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Tool "${name}" was not registered`);
    return handler(args);
  }

  /** Cast to the SDK type for passing into `register*` functions. */
  get asMcpServer(): McpServer {
    return this as unknown as McpServer;
  }
}

/** Create a fresh fake server + empty device pool. */
export function makeHarness(): { server: FakeMcpServer; pool: DevicePool } {
  return { server: new FakeMcpServer(), pool: new DevicePool() };
}

/**
 * Add a Nord Electro 5D device to the pool. By default it is "connected"
 * (a recording FakeMidiConnection is attached). Returns its index + device.
 */
export function connectNord(
  pool: DevicePool,
  opts: { label?: string; connect?: boolean } = {},
): { index: number; device: KeyboardDevice; conn: FakeMidiConnection } {
  const device = nordModel.createDevice!();
  if (opts.label) device.label = opts.label;
  const conn = new FakeMidiConnection();
  if (opts.connect !== false) device.attach!(conn);
  const index = pool.connect(device);
  return { index, device, conn };
}
