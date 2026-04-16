# Test Automation Framework

> **Execution order: 2 of 7** — Depends on: architecture plan. Should be implemented early to validate the architecture refactor and all subsequent changes.

## Goal

Automated end-to-end testing for keyboards-mcp: launch a headless mock device, connect the MCP server to it, call MCP tools, and assert on the mock's observed state.

## Decisions

| Topic | Decision |
|-------|----------|
| Test runner | `node:test` + `node:assert` (zero dependencies) |
| Headless mock | Separate CLI entry point (`src/mock-runner/cli.ts`), no Electron |
| MCP interaction | MCP SDK client over stdio (child process), tests call `client.callTool()` |
| State probing | WebSocket client connects to mock's existing WS server |
| Initial scope | Framework + 3-5 smoke tests (connect, set_parameters, get_state) |

## Headless Mock Runner

New file: `src/mock-runner/cli.ts`

- Plain Node entry point that loads the `KeyboardModel` from the registry, calls `model.createMockHandler()`, and creates a thin `MockEngine(port, handler)`
- Accepts `--model <id>` flag (required), plus optional `--ws-port`, `--lower-channel`, `--upper-channel`
- Creates the virtual MIDI port and WebSocket server, no Electron/BrowserWindow
- Prints a ready marker to stdout (e.g., `MOCK_READY`) so the test harness knows when to proceed
- Exits cleanly on SIGTERM

Usage: `node dist/mock-runner/cli.js --model nord-electro-5d`

Package script: `"mock:headless": "node dist/mock-runner/cli.js"`

### Prerequisite

This plan assumes the **architecture plan** has been implemented first. `MockEngine` must already be the thin shell that accepts a `MockHandler`, and models must implement `createMockHandler()`.

## Architecture — Two Approaches

### Approach A: Shared Test Harness

A single `TestHarness` class manages the full lifecycle.

```
tests/
  harness.ts          — TestHarness class
  smoke.test.ts       — Smoke tests
src/mock-runner/
  cli.ts              — Headless entry point
```

**TestHarness API:**

```ts
const h = await TestHarness.start({ model: "nord-electro-5d" });

// Call MCP tools
await h.callTool("connect_to_keyboard", {});
await h.callTool("set_parameters", {
  parameters: [{ name: "drawbar_1", value: 8 }]
});

// Probe mock state (latest WS snapshot)
const state = await h.getMockState();
assert.strictEqual(state.upper.drawbar_1.position, 8);

await h.stop();
```

**Lifecycle:**
1. `start()` spawns headless mock as child process, waits for `MOCK_READY`
2. Spawns MCP server as child process, connects MCP SDK client over stdio
3. `callTool(name, args)` delegates to `client.callTool()`
4. `getMockState()` returns the latest WebSocket state snapshot (the mock broadcasts full state on every CC change; the harness caches the most recent message and returns it immediately)
5. `stop()` kills both child processes, closes WS connection

**Trade-offs:**
- (+) Simple, single abstraction for test authors
- (+) Easy to add tests — just call tools and assert state
- (-) Every test pays the startup cost of both processes

### Approach B: Layered Helpers

Separate the mock and MCP concerns into independent helpers.

```
tests/
  helpers/
    mock-process.ts   — Start/stop headless mock, WS client
    mcp-client.ts     — Start/stop MCP server, callTool wrapper
  smoke.test.ts
```

**Usage:**

```ts
const mock = await MockProcess.start({ model: "nord-electro-5d" });
const mcp = await McpClient.start();

await mcp.callTool("connect_to_keyboard", {});
await mcp.callTool("set_parameters", {
  parameters: [{ name: "drawbar_1", value: 8 }]
});

const state = await mock.getState();
assert.strictEqual(state.upper.drawbar_1.position, 8);

await mock.stop();
await mcp.stop();
```

**Trade-offs:**
- (+) More flexible — can test mock or MCP independently
- (+) Reusable `MockProcess` for non-MCP tests later
- (-) More boilerplate per test
- (-) Premature separation for 3-5 smoke tests

## Smoke Tests (Initial Suite)

Regardless of approach, the first tests cover:

1. **Connect** — start mock, start MCP, call `connect_to_keyboard`, verify MCP reports connected
2. **Set parameters** — set a few parameters (drawbar, effect toggle, continuous), assert mock state matches expected values
3. **Get state** — call `get_current_state` via MCP, verify it reflects what was sent
4. **Apply preset** — call `apply_patch` with a known preset, verify all preset values appear in mock state
5. **List parameters** — call `list_parameters`, verify response includes expected parameter names and sections

## Test Execution

```bash
npm run build && node --test dist/tests/smoke.test.js
```

Package script: `"test": "node --test dist/tests/**/*.test.js"`

Tests live in `tests/` at the project root (alongside `src/`), compiled to `dist/tests/`.

## Future: Multi-Device Tests

The initial smoke tests cover single-device scenarios. Once the **multi-device plan** is implemented, extend the harness to:
- Spawn multiple headless mocks simultaneously (different models, different ports)
- Connect the MCP server to multiple devices
- Test device-indexed tool calls (`set_parameters(device=1, ...)` vs `device=2`)
- Test the auto-resolve behavior (single device = no index needed, multiple = required)
