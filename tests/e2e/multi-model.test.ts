// PRECONDITION: requires an external MCB broker reachable by the MCP server.
// Default is UDS at MCB_SOCKET (~/.mcb/sock); CI/docker uses TCP via
// MCB_TCP=<host>:<port>. Start one locally with `npm run mcb`. Tests in this
// file use TestHarness, which spawns the MCP server only — it connects to MCB
// as a client and fails with `mcb-unreachable` if no broker is listening.
// Self-provisioning E2Es live under tests/e2e/mcb/ and are run by
// `npm run test:e2e:mcb` (no external prerequisite).

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

const isDocker = !!process.env.MOCK_WS_URL;

// In Docker mode, only Nord mock is running. Locally, test all models.
const MODELS = isDocker
  ? [{ id: "nord-electro-5d", portPattern: "Nord Electro 5D Mock", port: 5500 }]
  : [
      { id: "nord-electro-5d", portPattern: "Nord Electro 5D Mock", port: 5500 },
      { id: "roland-juno-x", portPattern: "Roland JUNO-X Mock", port: 5501 },
      { id: "sequential-prophet-6", portPattern: "Prophet-6 Mock", port: 5502 },
    ];

describe("E2E: multi-model regression", { concurrency: 1 }, () => {
  for (const { id, portPattern, port } of MODELS) {
    it(`${id}: connect + list_parameters + get_state`, async () => {
      const h = await TestHarness.start({ model: id, wsPort: port });
      try {
        const connectResult = await h.callTool("connect_to_keyboard", { port: portPattern, model: id });
        assert.ok(!connectResult.isError, `connect failed: ${connectResult.content[0].text}`);

        const listResult = await h.callTool("list_parameters");
        assert.ok(!listResult.isError, `list_parameters failed: ${listResult.content[0].text}`);
        assert.ok(listResult.content[0].text.length > 100, "suspiciously short response");

        const stateResult = await h.callTool("get_current_state");
        assert.ok(!stateResult.isError, `get_current_state failed: ${stateResult.content[0].text}`);
      } finally {
        await h.stop();
      }
    });
  }
});
