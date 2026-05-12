import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { AudioAnalysisClient } from "../../../src/audio-analysis-client/index.js";
import type {
  StemSeparateResult,
  StemsEvent,
  StructureEvent,
} from "../../../src/audio-analysis-client/index.js";

function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function sseResponse(...chunks: string[]): Response {
  return new Response(bodyOf(...chunks), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("AudioAnalysisClient.healthz", () => {
  it("returns true on 200", async () => {
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async (url) => {
        assert.equal(url, "http://x/healthz");
        return new Response("{}", { status: 200 });
      }),
    });
    assert.equal(await client.healthz(), true);
  });

  it("returns false on non-2xx", async () => {
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async () => new Response("", { status: 503 })),
    });
    assert.equal(await client.healthz(), false);
  });

  it("returns false when fetch throws", async () => {
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async () => {
        throw new Error("network");
      }),
    });
    assert.equal(await client.healthz(), false);
  });

  it("strips a trailing slash from serverUrl", async () => {
    let captured = "";
    const client = new AudioAnalysisClient({
      serverUrl: "http://x/",
      fetch: makeFetch(async (url) => {
        captured = url;
        return new Response("{}", { status: 200 });
      }),
    });
    await client.healthz();
    assert.equal(captured, "http://x/healthz");
  });
});

describe("AudioAnalysisClient.importAudio", () => {
  it("posts JSON and returns the parsed result", async () => {
    const expected = {
      audio_path: "/tmp/foo.wav",
      job_name: "foo",
      sample_rate: 48000,
      duration_seconds: 12.5,
      channels: 2,
    };
    let seenBody = "";
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async (url, init) => {
        assert.equal(url, "http://x/jobs/import");
        assert.equal(init?.method, "POST");
        seenBody = init?.body as string;
        return jsonResponse(expected);
      }),
    });
    const got = await client.importAudio({ file_path: "/in.mp3" });
    assert.deepEqual(got, expected);
    assert.deepEqual(JSON.parse(seenBody), { file_path: "/in.mp3" });
  });

  it("throws on 4xx with a useful message", async () => {
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async () => new Response("bad path", { status: 404 })),
    });
    await assert.rejects(client.importAudio({ file_path: "/x" }), /HTTP 404/);
  });
});

describe("AudioAnalysisClient.separateStems", () => {
  it("yields progress events then the result and terminates", async () => {
    const result: StemSeparateResult = {
      stems: [{ stem: "vocals", path: "/o/vocals.wav" }],
      model: "htdemucs",
      preset: "medium",
      cached: false,
    };
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async () =>
        sseResponse(
          'event: progress\ndata: {"stage":"load","fraction":0.1,"detail":null}\n\n',
          'event: progress\ndata: {"stage":"sep","fraction":0.8,"detail":"chunk 4/5"}\n\n',
          `event: result\ndata: ${JSON.stringify(result)}\n\n`,
        ),
      ),
    });
    const events: StemsEvent[] = await collect(
      client.separateStems({ audio_path: "jobs/foo/source.wav", preset: "medium" }),
    );
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], {
      type: "progress",
      stage: "load",
      fraction: 0.1,
      detail: null,
    });
    assert.deepEqual(events[1], {
      type: "progress",
      stage: "sep",
      fraction: 0.8,
      detail: "chunk 4/5",
    });
    assert.equal(events[2].type, "result");
    if (events[2].type === "result") {
      assert.deepEqual(events[2].result, result);
    }
  });

  it("yields an error event and stops on server-side error", async () => {
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async () =>
        sseResponse(
          'event: progress\ndata: {"stage":"load","fraction":0.1,"detail":null}\n\n',
          'event: error\ndata: {"type":"RuntimeError","message":"GPU OOM"}\n\n',
          // Anything after should be ignored — the iterator terminates on
          // the terminal `error` event.
          'event: progress\ndata: {"stage":"x","fraction":0.5,"detail":null}\n\n',
        ),
      ),
    });
    const events: StemsEvent[] = await collect(
      client.separateStems({ audio_path: "a", preset: "medium" }),
    );
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], {
      type: "error",
      errorType: "RuntimeError",
      message: "GPU OOM",
    });
  });

  it("throws on a non-2xx initial response", async () => {
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async () => new Response("nope", { status: 422 })),
    });
    await assert.rejects(
      (async () => {
        for await (const _ of client.separateStems({
          audio_path: "a",
          preset: "medium",
        })) {
          // unreachable
        }
      })(),
      /HTTP 422/,
    );
  });

  it("propagates AbortSignal", async () => {
    const ac = new AbortController();
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async (_url, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }),
    });
    ac.abort();
    await assert.rejects(
      (async () => {
        for await (const _ of client.separateStems(
          { audio_path: "a", preset: "medium" },
          { signal: ac.signal },
        )) {
          // unreachable
        }
      })(),
      /aborted/,
    );
  });
});

describe("AudioAnalysisClient.analyzeStructure", () => {
  it("decodes structure result event", async () => {
    const result = {
      structure_path: "/o/structure.json",
      segments: [{ start: 0, end: 10, label: "intro" }],
      duration: 120,
      cached: false,
    };
    const client = new AudioAnalysisClient({
      serverUrl: "http://x",
      fetch: makeFetch(async () =>
        sseResponse(`event: result\ndata: ${JSON.stringify(result)}\n\n`),
      ),
    });
    const events: StructureEvent[] = await collect(
      client.analyzeStructure({ audio_path: "a" }),
    );
    assert.equal(events.length, 1);
    if (events[0].type === "result") {
      assert.deepEqual(events[0].result, result);
    } else {
      assert.fail("expected result event");
    }
  });
});
