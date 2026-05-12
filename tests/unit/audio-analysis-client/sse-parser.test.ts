import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseSseStream, type SseEvent } from "../../../src/audio-analysis-client/sse-parser.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of parseSseStream(s)) out.push(e);
  return out;
}

describe("parseSseStream", () => {
  it("parses a single named event", async () => {
    const evts = await collect(streamOf("event: progress\ndata: {\"a\":1}\n\n"));
    assert.deepEqual(evts, [{ event: "progress", data: '{"a":1}' }]);
  });

  it("parses multiple events back to back", async () => {
    const evts = await collect(
      streamOf(
        "event: progress\ndata: {\"x\":1}\n\n",
        "event: result\ndata: {\"ok\":true}\n\n",
      ),
    );
    assert.deepEqual(evts, [
      { event: "progress", data: '{"x":1}' },
      { event: "result", data: '{"ok":true}' },
    ]);
  });

  it("handles chunks split mid-event", async () => {
    const evts = await collect(
      streamOf("event: progr", "ess\ndata: {\"a\":", '1}\n\n'),
    );
    assert.deepEqual(evts, [{ event: "progress", data: '{"a":1}' }]);
  });

  it("joins multi-line data with \\n", async () => {
    const evts = await collect(streamOf("event: x\ndata: one\ndata: two\n\n"));
    assert.deepEqual(evts, [{ event: "x", data: "one\ntwo" }]);
  });

  it("skips comment lines and tolerates blank prefix", async () => {
    const evts = await collect(
      streamOf(": keepalive\nevent: progress\ndata: {}\n\n"),
    );
    assert.deepEqual(evts, [{ event: "progress", data: "{}" }]);
  });

  it("defaults event name to 'message' when omitted", async () => {
    const evts = await collect(streamOf("data: hello\n\n"));
    assert.deepEqual(evts, [{ event: "message", data: "hello" }]);
  });

  it("normalizes \\r\\n line endings", async () => {
    const evts = await collect(streamOf("event: progress\r\ndata: ok\r\n\r\n"));
    assert.deepEqual(evts, [{ event: "progress", data: "ok" }]);
  });

  it("flushes a final event missing trailing blank line", async () => {
    // Real servers always emit the blank line, but be defensive against
    // an abrupt close after the last `data:`.
    const evts = await collect(streamOf("event: result\ndata: {\"ok\":true}\n"));
    assert.deepEqual(evts, [{ event: "result", data: '{"ok":true}' }]);
  });

  it("ignores id: and retry: fields", async () => {
    const evts = await collect(
      streamOf("id: 7\nretry: 3000\nevent: progress\ndata: x\n\n"),
    );
    assert.deepEqual(evts, [{ event: "progress", data: "x" }]);
  });

  it("yields nothing on empty stream", async () => {
    const evts = await collect(streamOf(""));
    assert.deepEqual(evts, []);
  });
});
