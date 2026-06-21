/**
 * Headless mock entry point for Sounds and Recreation.
 * Plain Node (no Electron) — for test automation and CI.
 *
 * Usage: tsx src/cli.ts --model nord-electro-5d [--ws-port 3000] [--ws-out-port 3001]
 */

import { parseArgs } from "node:util";
import { loadModelById } from "keyboards-mcp/shared/model-registry";
import { MockTransport } from "./transport.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", short: "m" },
    "ws-port": { type: "string", default: "3000" },
    // Optional second WS server for outgoing-from-mock MIDI (#109). Lets a
    // WS-only MCP receive the RQ1→DT1 round-trip. Omit to disable the out lane.
    "ws-out-port": { type: "string" },
    "lower-channel": { type: "string", default: "0" },
    "upper-channel": { type: "string", default: "1" },
    "no-midi": { type: "boolean", default: false },
    label: { type: "string" },
  },
  strict: true,
});

if (!values.model) {
  console.error("Usage: --model <model-id> [--ws-port <port>] [--ws-out-port <port>] [--lower-channel <ch>] [--upper-channel <ch>] [--label <label>]");
  process.exit(1);
}

const model = await loadModelById(values.model);
const handler = model.createMockHandler?.();
if (!handler) {
  console.error(`Model ${model.info.displayName} does not provide a mock handler.`);
  process.exit(1);
}

const transport = new MockTransport(handler, {
  lowerChannel: parseInt(values["lower-channel"]!),
  upperChannel: parseInt(values["upper-channel"]!),
  wsPort: parseInt(values["ws-port"]!),
  wsOutPort: values["ws-out-port"] !== undefined ? parseInt(values["ws-out-port"]) : undefined,
  portName: `${model.info.displayName} Mock`,
  modelId: model.info.id,
  displayName: model.info.displayName,
  label: values.label,
  noMidi: values["no-midi"],
});

await transport.start();
console.log("MOCK_READY");

process.on("SIGTERM", async () => {
  await transport.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await transport.stop();
  process.exit(0);
});
