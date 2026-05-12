import type { components } from "./generated/openapi-types.js";

// Request/response shapes generated from the FastAPI OpenAPI spec.
type Schemas = components["schemas"];

export type ImportRequest = Schemas["ImportRequest"];
export type ImportAudioResult = Schemas["ImportAudioResult"];
export type StructureRequest = Schemas["StructureRequest"];

// openapi-typescript marks any property with a `default` as required in the
// generated type, even when the OpenAPI `required` list omits it. For a
// request body the server applies the default when the field is missing, so
// `preset` is genuinely optional from the caller's perspective. Re-wrap.
type GeneratedStemsRequest = Schemas["StemsRequest"];
export type StemsRequest = Omit<GeneratedStemsRequest, "preset"> & {
  preset?: GeneratedStemsRequest["preset"];
};
export type StemPreset = GeneratedStemsRequest["preset"];

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

// Transcribe (Basic Pitch) request/result. The service result payload is
// deliberately small — note events are written to disk as a sidecar JSON
// next to the MIDI, not inlined in the SSE result frame. Hand-mirrored
// from audio_analysis_mcp/schemas.py::NoteTranscribeServiceResult.
export type TranscribeRequest = { audio_path: string };

export interface NoteTranscribeServiceResult {
  midi_path: string;
  cached: boolean;
}

export type TranscribeEvent =
  | ProgressEvent
  | ResultEvent<NoteTranscribeServiceResult>
  | ErrorEvent;

// Per-section note triage. The result payload is again deliberately
// small — the full per-section data (candidates + polyphony profiles)
// stays on disk at `triage_path` and can grow to MBs on a busy song.
// Hand-mirrored from audio_analysis_mcp/schemas.py.
export interface TriageSection {
  start_time: number;
  end_time: number;
  label: string;
}

export type TriageRequest = {
  audio_path: string;
  sections: TriageSection[];
  min_duration?: number;
  max_candidates?: number;
  jitter_tolerance?: number;
};

export interface NoteTriageBySectionsServiceResult {
  triage_path: string;
  cached: boolean;
}

export type TriageEvent =
  | ProgressEvent
  | ResultEvent<NoteTriageBySectionsServiceResult>
  | ErrorEvent;
