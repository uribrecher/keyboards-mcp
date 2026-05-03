/**
 * Headless mock runner entry point.
 * Plain Node (no Electron) — for test automation and CI.
 *
 * Usage: tsx src/mock-runner/cli.ts --model nord-electro-5d [--ws-port 3000]
 */

import { parseArgs } from "node:util";
import { loadModelById } from "../shared/model-registry.js";
import { MockEngine } from "./engine.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", short: "m" },
    "ws-port": { type: "string", default: "3000" },
    "lower-channel": { type: "string", default: "0" },
    "upper-channel": { type: "string", default: "1" },
    "no-midi": { type: "boolean", default: false },
    label: { type: "string" },
  },
  strict: true,
});

if (!values.model) {
  console.error("Usage: --model <model-id> [--ws-port <port>] [--lower-channel <ch>] [--upper-channel <ch>] [--label <label>]");
  process.exit(1);
}

const model = await loadModelById(values.model);
const handler = model.createMockHandler?.();
if (!handler) {
  console.error(`Model ${model.info.displayName} does not provide a mock handler.`);
  process.exit(1);
}

const engine = new MockEngine(handler, {
  lowerChannel: parseInt(values["lower-channel"]!),
  upperChannel: parseInt(values["upper-channel"]!),
  wsPort: parseInt(values["ws-port"]!),
  portName: `${model.info.displayName} Mock`,
  label: values.label,
  noMidi: values["no-midi"],
});

await engine.start();
console.log("MOCK_READY");

process.on("SIGTERM", async () => {
  await engine.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await engine.stop();
  process.exit(0);
});
