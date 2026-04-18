# CI with Docker Compose + WebSocket MIDI Transport

## Context

GitHub Actions Ubuntu runners lack ALSA kernel modules for virtual MIDI. Docker Compose gives clean network isolation between services, eliminating port conflicts, MIDI port name collisions, and timing races that plagued the host-based approach.

## Architecture

```
docker-compose.test.yml
┌───────────────────────────────────────────────────┐
│  docker network: test-net                         │
│                                                   │
│  ┌─────────────┐   WS (port 3000)  ┌───────────┐ │
│  │ mock service │◄──────────────────│ test      │ │
│  │ cli.ts       │   CC/SysEx JSON   │ runner    │ │
│  │ --no-midi    │                   │           │ │
│  │ --model $M   │                   │ npm test  │ │
│  └─────────────┘                    └───────────┘ │
│                                                   │
│  MCP spawned by test harness as child process,    │
│  connects to mock via WsMidiConnection over WS    │
└───────────────────────────────────────────────────┘
```

The mock runs as a docker-compose service with a fixed hostname (`mock`). The test runner spawns the MCP server as a child process (same as today), but the MCP uses `WsMidiConnection` to send CCs over WS to `ws://mock:3000` instead of real MIDI.

## Plan

### 1. `WsMidiConnection` — new MidiConnection implementation

Implements the `MidiConnection` interface by sending JSON messages over WebSocket. The MockEngine already handles `{ type: "cc" }` and `{ type: "program" }` from WS clients.

```typescript
// src/midi/ws-midi-connection.ts
export class WsMidiConnection implements MidiConnection {
  private ws: WebSocket;
  sendCC(controller, value, channel?) {
    this.ws.send(JSON.stringify({ type: "cc", controller, value, channel: channel ?? 0 }));
  }
  sendProgramChange(program, channel?) {
    this.ws.send(JSON.stringify({ type: "program", number: program, channel: channel ?? 0 }));
  }
  sendSysEx(bytes) {
    this.ws.send(JSON.stringify({ type: "sysex", bytes }));
  }
  // sendNRPN → decompose into 4 sendCC calls
  // sendCCBatch → loop with delay
  // onCC/onSysEx → no-op (mock doesn't send back over WS)
}
```

**File:** `src/midi/ws-midi-connection.ts` (new)

### 2. MockEngine `--no-midi` flag

Add `noMidi?: boolean` to `EngineOptions`. When true, skip `new easymidi.Input(...)`. Also add sysex handling to the WS message parser (currently only cc and program are handled).

**Files:** `src/mock-runner/engine.ts`, `src/mock-runner/cli.ts`

### 3. `connect_to_keyboard` WS transport path

When `MOCK_WS_URL` env var is set (e.g. `ws://mock:3000`), the connect tool:
- Skips MIDI port detection
- Creates a `WsMidiConnection` to the mock's WS server
- Attaches it to the device as usual

No tool API changes — the env var controls the transport.

**File:** `src/tools/connect.ts`

### 4. Dockerfile

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
RUN npm run build
```

**File:** `Dockerfile` (new)

### 5. docker-compose.test.yml

```yaml
services:
  mock:
    build: .
    command: npx tsx src/mock-runner/cli.ts --model ${TEST_MODEL:-nord-electro-5d} --no-midi --ws-port 3000
    expose:
      - "3000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000').catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 3s
      retries: 10

  test:
    build: .
    command: npm run test:ci
    environment:
      - MOCK_WS_URL=ws://mock:3000
      - MIDI_TRANSPORT=ws
    depends_on:
      mock:
        condition: service_healthy
```

**File:** `docker-compose.test.yml` (new)

### 6. Test scripts update

Add `test:ci` script that runs unit + integration + E2E with WS transport. The TestHarness detects `MOCK_WS_URL` and skips spawning its own mock process — connects to the docker-compose mock service instead.

**File:** `package.json`

### 7. CI workflow

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker compose -f docker-compose.test.yml run --rm test
```

**File:** `.github/workflows/ci.yml`

### 8. Update TestHarness for docker mode

When `MOCK_WS_URL` is set:
- `MockProcess.start()` connects to the existing mock service instead of spawning one
- `TestHarness.start()` passes `MOCK_WS_URL` to the MCP child process

When not set (local dev):
- Existing behavior: spawn mock with real MIDI, MidiManager connects normally

**Files:** `tests/helpers/mock-process.ts`, `tests/helpers/test-harness.ts`

## Files summary

| File | Action |
|------|--------|
| `src/midi/ws-midi-connection.ts` | New — WS-based MidiConnection |
| `src/mock-runner/engine.ts` | Add noMidi option, add sysex WS handling |
| `src/mock-runner/cli.ts` | Add --no-midi flag |
| `src/tools/connect.ts` | Add WS transport path via MOCK_WS_URL |
| `Dockerfile` | New |
| `docker-compose.test.yml` | New |
| `.github/workflows/ci.yml` | Use docker compose |
| `package.json` | Add test:ci script |
| `tests/helpers/mock-process.ts` | Support external mock via MOCK_WS_URL |
| `tests/helpers/test-harness.ts` | Pass MOCK_WS_URL to MCP child |

## Verification

1. `npm test` passes locally (unchanged — real MIDI)
2. `docker compose -f docker-compose.test.yml run --rm test` passes locally
3. CI workflow passes on GitHub Actions
