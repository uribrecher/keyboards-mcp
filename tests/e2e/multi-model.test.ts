import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let nextPort = 5500;

const MODELS = [
  { id: "nord-electro-5d", portPattern: "Nord Electro 5D Mock" },
  { id: "roland-juno-x", portPattern: "Roland JUNO-X Mock" },
  { id: "sequential-prophet-6", portPattern: "Prophet-6 Mock" },
];

describe("E2E: multi-model regression", { concurrency: 1 }, () => {
  for (const { id, portPattern } of MODELS) {
    it(`${id}: connect + list_parameters + get_state`, async () => {
      const port = nextPort++;
      const h = await TestHarness.start({ model: id, wsPort: port });
      try {
        // Connect
        const connectResult = await h.callTool("connect_to_keyboard", { port: portPattern });
        assert.ok(!connectResult.isError, `connect failed: ${connectResult.content[0].text}`);

        // List parameters
        const listResult = await h.callTool("list_parameters");
        assert.ok(!listResult.isError, `list_parameters failed: ${listResult.content[0].text}`);
        const listText = listResult.content[0].text;
        assert.ok(listText.length > 100, `list_parameters returned suspiciously short response`);

        // Get state
        const stateResult = await h.callTool("get_current_state");
        assert.ok(!stateResult.isError, `get_current_state failed: ${stateResult.content[0].text}`);
      } finally {
        await h.stop();
      }
    });
  }
});
