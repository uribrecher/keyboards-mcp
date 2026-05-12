# audio-analysis-client

TypeScript client for the `audio-analysis-mcp` HTTP+SSE service
(`../audio-analysis-mcp/src/audio_analysis_mcp/service/`). Ships as part of
`keyboards-mcp`; intended consumer is the mock-runner (separate PR).

## Usage

```ts
import { AudioAnalysisClient } from "./audio-analysis-client/index.js";

const client = new AudioAnalysisClient({ serverUrl: "http://127.0.0.1:8765" });

// Sync endpoints
if (!(await client.healthz())) throw new Error("service down");

const imported = await client.importAudio({ file_path: "/path/to/song.mp3" });

// Streaming endpoints — async iterable of typed events.
for await (const evt of client.separateStems({
  audio_path: imported.audio_path,
  preset: "medium",
})) {
  switch (evt.type) {
    case "progress":
      console.log(`${evt.stage}: ${(evt.fraction * 100).toFixed(0)}%`);
      break;
    case "result":
      console.log("stems:", evt.result.stems);
      break;
    case "error":
      console.error(`${evt.errorType}: ${evt.message}`);
      break;
  }
}
```

Both streaming methods accept an `AbortSignal`:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000);
for await (const evt of client.analyzeStructure(
  { audio_path },
  { signal: ac.signal },
)) {
  // ...
}
```

## Event contract

- Each streaming call yields zero or more `progress` events and exactly one
  terminal `result` **or** `error` event.
- After a terminal event the iterator ends; the consumer does not need to
  drain further.
- An HTTP-level error (non-2xx on the initial response) is thrown before any
  event is yielded.
- Network errors and aborts propagate as iterator throws.

## Regenerating types

Request/response types come from the FastAPI OpenAPI schema. SSE event
payloads (`StemSeparateResult`, `StructureAnalyzeResult`) are mirrored by
hand from `audio-analysis-mcp/src/audio_analysis_mcp/schemas.py` because
FastAPI cannot describe SSE bodies — keep `types.ts` in sync when those
Pydantic models change.

To refresh after a server change:

```bash
# 1. Dump the spec from the Python project.
cd ../audio-analysis-mcp
uv run python -c "import json; from audio_analysis_mcp.service.app import app; \
  print(json.dumps(app.openapi(), indent=2))" \
  > ../keyboards-mcp/src/audio-analysis-client/openapi.json

# 2. Regenerate the TS types.
cd ../keyboards-mcp
npm run generate:audio-analysis-types
```

## Files

- `openapi.json` — snapshot of the FastAPI spec (checked in).
- `generated/openapi-types.ts` — `openapi-typescript` output. Do not edit.
- `types.ts` — public type aliases + hand-ported SSE payloads.
- `sse-parser.ts` — named-event SSE parser over `ReadableStream<Uint8Array>`.
- `client.ts` — `AudioAnalysisClient` class.
- `index.ts` — public re-exports.
