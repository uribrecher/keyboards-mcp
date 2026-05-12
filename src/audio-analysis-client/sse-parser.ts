export interface SseEvent {
  event: string;
  data: string;
}

// Parses a server-sent events stream into `{event, data}` records, retaining
// the named-event field. The agent-client parser
// (../sound-recreation-agent/client-sdk/src/sse-parser.ts) drops event names —
// the audio-analysis service uses them (`progress` / `result` / `error`) to
// discriminate payload shapes, so we keep them.
//
// EventSource framing per https://html.spec.whatwg.org/#parsing-an-event-stream :
//   - Lines are terminated by \n, \r, or \r\n.
//   - A blank line dispatches the accumulated event.
//   - `event:` sets the event type (default "message").
//   - `data:` lines are accumulated; multiple `data:` lines join with \n.
//   - `id:` / `retry:` are accepted but ignored here.
//   - Lines starting with `:` are comments and skipped.
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  const dataLines: string[] = [];
  let reachedEnd = false;

  const dispatch = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventType = "";
      return null;
    }
    const evt: SseEvent = {
      event: eventType || "message",
      data: dataLines.join("\n"),
    };
    eventType = "";
    dataLines.length = 0;
    return evt;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Normalize \r\n and bare \r to \n, but defer a trailing \r until the
      // next chunk arrives — it may be the first half of a \r\n that got
      // split across the TCP boundary.
      const endsWithCR = buffer.endsWith("\r");
      const head = endsWithCR ? buffer.slice(0, -1) : buffer;
      const normalized = head.replace(/\r\n?/g, "\n");

      const lines = normalized.split("\n");
      buffer = (lines.pop() ?? "") + (endsWithCR ? "\r" : "");

      for (const line of lines) {
        if (line === "") {
          const evt = dispatch();
          if (evt) yield evt;
          continue;
        }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);

        switch (field) {
          case "event":
            eventType = val;
            break;
          case "data":
            dataLines.push(val);
            break;
          // id / retry intentionally ignored.
        }
      }
    }

    // Flush a final event if the stream ended without a trailing blank line.
    if (buffer.length > 0) {
      // A held \r at EOF is a bare-CR line terminator; normalize it to nothing
      // (it just terminates whatever came before, which is already buffered).
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      if (line.startsWith("data:")) {
        let val = line.slice(5);
        if (val.startsWith(" ")) val = val.slice(1);
        dataLines.push(val);
      } else if (line.startsWith("event:")) {
        let val = line.slice(6);
        if (val.startsWith(" ")) val = val.slice(1);
        eventType = val;
      }
    }
    const evt = dispatch();
    if (evt) yield evt;
  } finally {
    if (reachedEnd) {
      reader.releaseLock();
    } else {
      // Consumer terminated early (broke out of for-await or threw). Cancel
      // the underlying stream so the SSE connection drops promptly instead
      // of waiting for the server to close.
      try {
        await reader.cancel();
      } catch {
        // already canceled or stream errored
      }
    }
  }
}
