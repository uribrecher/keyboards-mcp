import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { registerSetParameters } from "../../../src/tools/set-parameters.js";
import { registerGetState } from "../../../src/tools/get-state.js";
import { registerLoadProgram } from "../../../src/tools/load-program.js";
import { registerLoadSong } from "../../../src/tools/load-song.js";
import { registerListPrograms } from "../../../src/tools/list-programs.js";
import { registerListSongs } from "../../../src/tools/list-songs.js";
import { registerListParameters } from "../../../src/tools/list-parameters.js";
import { registerSystemPrompt } from "../../../src/tools/system-prompt.js";
import { registerDisconnect } from "../../../src/tools/disconnect.js";
import { registerIsConnected } from "../../../src/tools/is-connected.js";
import { registerGetHealth } from "../../../src/tools/get-health.js";
import { makeHarness, connectNord, type FakeMcpServer } from "../../helpers/tool-harness.js";
import type { DevicePool } from "../../../src/shared/device-pool.js";

let server: FakeMcpServer;
let pool: DevicePool;

beforeEach(() => {
  ({ server, pool } = makeHarness());
  registerSetParameters(server.asMcpServer, pool);
  registerGetState(server.asMcpServer, pool);
  registerLoadProgram(server.asMcpServer, pool);
  registerLoadSong(server.asMcpServer, pool);
  registerListPrograms(server.asMcpServer, pool);
  registerListSongs(server.asMcpServer, pool);
  registerListParameters(server.asMcpServer, pool);
  registerSystemPrompt(server.asMcpServer, pool);
  registerDisconnect(server.asMcpServer, pool);
  registerIsConnected(server.asMcpServer, pool);
  registerGetHealth(server.asMcpServer, pool);
});

describe("set_parameters tool", () => {
  it("sets parameters on a connected device", async () => {
    connectNord(pool);
    const res = await server.call("set_parameters", { parameters: [{ name: "organ_model", value: "B3" }] });
    assert.match(res.content[0].text, /Parameters set:/);
  });

  it("returns the pool resolution error when nothing is connected", async () => {
    const res = await server.call("set_parameters", { parameters: [{ name: "organ_model", value: 0 }] });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /No keyboard connected/);
  });
});

describe("get_state tool", () => {
  it("reports Nord's one-way-MIDI message", async () => {
    connectNord(pool);
    const res = await server.call("get_current_state", {});
    assert.match(res.content[0].text, /not supported|one-way/i);
  });
});

describe("load_program tool", () => {
  it("loads a valid program", async () => {
    connectNord(pool);
    const res = await server.call("load_program", { bank: 1, slot: 1 });
    assert.match(res.content[0].text, /Loaded program 1:1/);
  });

  it("errors when not connected", async () => {
    const res = await server.call("load_program", { bank: 1, slot: 1 });
    assert.ok(res.isError);
  });
});

describe("load_song tool", () => {
  it("loads a song on a connected device", async () => {
    connectNord(pool);
    const res = await server.call("load_song", { bank: 1, slot: 1, part: "A" });
    assert.match(res.content[0].text, /Set list 1, song 1/);
  });
});

describe("list_programs / list_songs tools", () => {
  it("list_programs reports no backup data by default", async () => {
    connectNord(pool);
    const res = await server.call("list_programs", {});
    assert.match(res.content[0].text, /No backup data loaded/);
  });

  it("list_programs lists programs from backup data", async () => {
    const { device } = connectNord(pool);
    device.backupData = { programs: [{ bank: 1, slot: 0, name: "Intro" }] };
    const res = await server.call("list_programs", {});
    assert.match(res.content[0].text, /Intro/);
  });

  it("list_songs reports no backup data by default", async () => {
    connectNord(pool);
    const res = await server.call("list_songs", {});
    assert.match(res.content[0].text, /No backup data loaded/);
  });
});

describe("list_parameters tool", () => {
  it("lists parameters for a connected device", async () => {
    connectNord(pool);
    const res = await server.call("list_parameters", { section: "organ" });
    assert.match(res.content[0].text, /## ORGAN/);
  });
});

describe("system_prompt tool", () => {
  it("returns the device system prompt for a single device", async () => {
    connectNord(pool);
    const res = await server.call("get_system_prompt", {});
    assert.match(res.content[0].text, /Nord Electro 5D/);
  });

  it("augments the prompt with a device roster when multiple are connected", async () => {
    connectNord(pool, { label: "a" });
    connectNord(pool, { label: "b" });
    const res = await server.call("get_system_prompt", { device: 1 });
    assert.match(res.content[0].text, /device 1/);
    assert.match(res.content[0].text, /device 2/);
  });
});

describe("disconnect tool", () => {
  it("disconnects a connected device", async () => {
    connectNord(pool);
    const res = await server.call("disconnect_from_keyboard", {});
    assert.ok(!res.isError);
    assert.strictEqual(pool.size(), 0);
  });

  it("reports when nothing was connected", async () => {
    const res = await server.call("disconnect_from_keyboard", {});
    assert.match(res.content[0].text, /No device was connected/);
  });
});

describe("is_connected tool", () => {
  it("reports not connected for an empty pool", async () => {
    const res = await server.call("is_connected", {});
    assert.match(res.content[0].text, /Not connected/);
  });

  it("renders the local pool in WS-transport mode", async () => {
    const prev = process.env.MOCK_WS_URL;
    process.env.MOCK_WS_URL = "ws://localhost:0";
    try {
      connectNord(pool, { label: "ws-dev" });
      const res = await server.call("is_connected", {});
      assert.match(res.content[0].text, /WS-transport mode/);
      assert.match(res.content[0].text, /ws-dev/);
    } finally {
      if (prev === undefined) delete process.env.MOCK_WS_URL;
      else process.env.MOCK_WS_URL = prev;
    }
  });
});

describe("get_health tool", () => {
  it("reports local pool size and MCB reachability", async () => {
    connectNord(pool);
    const res = await server.call("get_health", {});
    const payload = JSON.parse(res.content[0].text);
    assert.strictEqual(payload.deviceCount, 1);
    assert.strictEqual(typeof payload.mcbReachable, "boolean");
  });
});
