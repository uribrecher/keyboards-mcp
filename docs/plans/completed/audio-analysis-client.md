# audio-analysis-client (TypeScript)

## Context

A new FastAPI+SSE service lives at `../audio-analysis-mcp/src/audio_analysis_mcp/service/` (routes: `GET /healthz`, `POST /jobs/import`, `POST /jobs/stems`, `POST /jobs/structure`; the last two stream progress as SSE). The mock-runner inside `keyboards-mcp` will, in a later PR, kick off these jobs and render progress bars. We need a small TypeScript client that wraps the HTTP calls and exposes the SSE stream in an ergonomic way for that UI.

Per discussion:
1. Name: `audio-analysis-client` (matches the actual server dir `audio-analysis-mcp`).
2. Location: a sub-module inside `keyboards-mcp`, at `src/audio-analysis-client/`. Not a standalone npm package — it ships as part of `keyboards-mcp`.
3. Progress API: **async iterable of typed events** (mirrors the `@sounds-and-recreation/agent-client` pattern already used in this repo; supports `AbortSignal` cleanly; consumer decides whether to render every event or coalesce).
4. Types: generated from the FastAPI OpenAPI spec via `openapi-typescript`. SSE payload shapes — which FastAPI cannot describe in OpenAPI (the SSE responses are typed as `{}`) — are hand-ported from `audio_analysis_mcp/schemas.py` into a small `types.ts` with comments pointing back to the Pydantic source.
5. Tests: unit tests using stubbed `fetch` + fake `ReadableStream`s — no live service required.

## API surface

```ts
// src/audio-analysis-client/index.ts (public)
export { AudioAnalysisClient } from "./client.js";
export type { AudioAnalysisClientOptions } from "./client.js";
export type {
  ImportRequest, ImportAudioResult,
  StemsRequest, StemSeparateResult, StemFile, StemPreset,
  StructureRequest, StructureAnalyzeResult, StructureSegment,
  ProgressEvent, ResultEvent, ErrorEvent,
  StemsEvent, StructureEvent,
} from "./types.js";
```

```ts
class AudioAnalysisClient {
  constructor(opts: { serverUrl: string; fetch?: typeof fetch });
  healthz(signal?: AbortSignal): Promise<boolean>;
  importAudio(req: ImportRequest, opts?: { signal?: AbortSignal }): Promise<ImportAudioResult>;
  separateStems(req: StemsRequest, opts?: { signal?: AbortSignal }): AsyncIterable<StemsEvent>;
  analyzeStructure(req: StructureRequest, opts?: { signal?: AbortSignal }): AsyncIterable<StructureEvent>;
}

type ProgressEvent = { type: "progress"; stage: string; fraction: number; detail: string | null };
type ResultEvent<T>  = { type: "result"; result: T };
type ErrorEvent      = { type: "error"; errorType: string; message: string };

type StemsEvent     = ProgressEvent | ResultEvent<StemSeparateResult>     | ErrorEvent;
type StructureEvent = ProgressEvent | ResultEvent<StructureAnalyzeResult> | ErrorEvent;
```

Behavior notes:
- Non-2xx response on POST → throws before the iterator yields anything.
- Network error / aborted signal → the iterator throws (propagates `AbortError`).
- A server-side `event: error` chunk → the iterator yields one `ErrorEvent` and then ends cleanly. No `result` will follow.
- `fetch` is injectable via the constructor so tests can stub it without globals.

## Files created

Under `src/audio-analysis-client/`:
- `openapi.json` — snapshot of `app.openapi()` from the FastAPI app.
- `generated/openapi-types.ts` — `openapi-typescript` output (generated; do not edit).
- `types.ts` — re-exports request/response types from generated; hand-ports SSE payload types from `audio_analysis_mcp/schemas.py`; defines the event union.
- `sse-parser.ts` — named-SSE parser yielding `{event, data}` (the agent-client parser discards event names).
- `client.ts` — `AudioAnalysisClient` class.
- `index.ts` — public re-exports.
- `README.md` — usage + regeneration instructions.

Under `tests/unit/audio-analysis-client/`:
- `sse-parser.test.ts`
- `client.test.ts`

## Files modified

- `package.json`: add `openapi-typescript` devDep; add `generate:audio-analysis-types` script.

## Verification

From `keyboards-mcp/`:
1. `npm install`
2. `npm run generate:audio-analysis-types`
3. `npm run test:check`
4. `npm run lint`
5. `npm run test:unit`

## Out of scope

- Wiring the client into `mock-runner` — follow-up PR.
- Adding response schemas to the FastAPI SSE endpoints — keeps the server change-free.
- Long-poll fallback or auto-reconnect.
