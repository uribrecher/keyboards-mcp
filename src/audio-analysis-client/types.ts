import type { components } from "./generated/openapi-types.js";

// Request/response shapes generated from the FastAPI OpenAPI spec.
type Schemas = components["schemas"];

export type ImportRequest = Schemas["ImportRequest"];
export type ImportAudioResult = Schemas["ImportAudioResult"];
export type StemsRequest = Schemas["StemsRequest"];
export type StructureRequest = Schemas["StructureRequest"];
export type StemPreset = StemsRequest["preset"];

// SSE payload shapes — NOT in the OpenAPI spec because FastAPI types streaming
// responses as `{}`. Mirrored by hand from
// audio-analysis-mcp/src/audio_analysis_mcp/schemas.py. Keep in sync.
export interface StemFile {
  stem: string;
  path: string;
}

export interface StemSeparateResult {
  stems: StemFile[];
  model: string;
  preset: string;
  cached: boolean;
}

export interface StructureSegment {
  start: number;
  end: number;
  label: string;
}

export interface StructureAnalyzeResult {
  structure_path: string;
  segments: StructureSegment[];
  duration: number;
  cached: boolean;
}

// SSE event union. The wire format is `event: <name>\ndata: <json>\n\n`
// (see audio_analysis_mcp/service/sse.py).
export interface ProgressEvent {
  type: "progress";
  stage: string;
  fraction: number;
  detail: string | null;
}

export interface ResultEvent<T> {
  type: "result";
  result: T;
}

export interface ErrorEvent {
  type: "error";
  errorType: string;
  message: string;
}

export type StemsEvent = ProgressEvent | ResultEvent<StemSeparateResult> | ErrorEvent;
export type StructureEvent = ProgressEvent | ResultEvent<StructureAnalyzeResult> | ErrorEvent;
