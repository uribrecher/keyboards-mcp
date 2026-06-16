import { parseSseStream } from "./sse-parser.js";
import type {
  ImportRequest,
  ImportAudioResult,
  StemsRequest,
  StemSeparateResult,
  StemsEvent,
  StructureRequest,
  StructureAnalyzeResult,
  StructureEvent,
  TranscribeRequest,
  NoteTranscribeServiceResult,
  TranscribeEvent,
  TriageRequest,
  NoteTriageBySectionsServiceResult,
  TriageEvent,
} from "./types.js";

export interface AudioAnalysisClientOptions {
  serverUrl: string;
  // Injectable for tests. Defaults to global fetch.
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export class AudioAnalysisClient {
  readonly #serverUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: AudioAnalysisClientOptions) {
    // Strip trailing slash so route joins don't double up.
    this.#serverUrl = opts.serverUrl.replace(/\/$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  async healthz(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#serverUrl}/healthz`, { signal });
      return res.ok;
    } catch {
      return false;
    }
  }

  async importAudio(req: ImportRequest, opts: RequestOptions = {}): Promise<ImportAudioResult> {
    const res = await this.#fetch(`${this.#serverUrl}/jobs/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(await formatHttpError(res));
    }
    return (await res.json()) as ImportAudioResult;
  }

  separateStems(req: StemsRequest, opts: RequestOptions = {}): AsyncIterable<StemsEvent> {
    return this.#streamJob<StemSeparateResult, StemsEvent>("/jobs/stems", req, opts);
  }

  analyzeStructure(
    req: StructureRequest,
    opts: RequestOptions = {},
  ): AsyncIterable<StructureEvent> {
    return this.#streamJob<StructureAnalyzeResult, StructureEvent>(
      "/jobs/structure",
      req,
      opts,
    );
  }

  transcribeNotes(
    req: TranscribeRequest,
    opts: RequestOptions = {},
  ): AsyncIterable<TranscribeEvent> {
    return this.#streamJob<NoteTranscribeServiceResult, TranscribeEvent>(
      "/jobs/transcribe",
      req,
      opts,
    );
  }

  triageNotesBySections(
    req: TriageRequest,
    opts: RequestOptions = {},
  ): AsyncIterable<TriageEvent> {
    return this.#streamJob<NoteTriageBySectionsServiceResult, TriageEvent>(
      "/jobs/triage",
      req,
      opts,
    );
  }

  async *#streamJob<TResult, TEvent>(
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): AsyncIterable<TEvent> {
    const res = await this.#fetch(`${this.#serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(await formatHttpError(res));
    }
    if (!res.body) {
      throw new Error("Response has no body");
    }

    for await (const sse of parseSseStream(res.body)) {
      const evt = decodeEvent<TResult>(sse.event, sse.data);
      if (evt) {
        yield evt as TEvent;
        // Server contract: `error` and `result` are terminal events.
        if (evt.type === "error" || evt.type === "result") return;
      }
    }
  }
}

type DecodedEvent<TResult> =
  | { type: "progress"; stage: string; fraction: number; detail: string | null }
  | { type: "result"; result: TResult }
  | { type: "error"; errorType: string; message: string };

function decodeEvent<TResult>(name: string, data: string): DecodedEvent<TResult> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  switch (name) {
    case "progress":
      return {
        type: "progress",
        stage: typeof p.stage === "string" ? p.stage : "",
        fraction: typeof p.fraction === "number" ? p.fraction : 0,
        detail: typeof p.detail === "string" ? p.detail : null,
      };
    case "result":
      return { type: "result", result: parsed as TResult };
    case "error":
      return {
        type: "error",
        errorType: typeof p.type === "string" ? p.type : "Error",
        message: typeof p.message === "string" ? p.message : "",
      };
    default:
      return null;
  }
}

async function formatHttpError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = await res.text();
    if (body) detail = `: ${body.slice(0, 500)}`;
  } catch {
    // body unreadable — fall through with empty detail
  }
  return `HTTP ${res.status} ${res.statusText}${detail}`;
}
