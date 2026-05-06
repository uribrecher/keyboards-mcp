# Plan #12 — Integrate `@sounds-and-recreation/agent-client` SDK

The agent migrated to Vercel AI SDK's UI message stream protocol but the
mock-runner shell never followed. Today the shell hits `/health` and
`/reset` (404), sends `{message}` instead of `{messages: UIMessage[]}`,
and parses `event:`/`data:` two-line SSE while the agent emits
`data: {json}` only. Result: chat doesn't communicate at all (every
request 4xxs).

The agent repo now ships a browser-safe TypeScript SDK at
`sound-recreation-agent/client-sdk/` (`@sounds-and-recreation/agent-client`)
that owns the protocol. This plan replaces the shell's hand-rolled
client with the SDK so the protocol can never desync again.

## Approach

### Dependency

Add to `keyboards-mcp/package.json`:

```json
"@sounds-and-recreation/agent-client": "file:../sound-recreation-agent/client-sdk"
```

Add `build:sdk` + `premock:runner` + `premock:runner:debug` scripts so
fresh clones pick up the SDK without manual `npm run build` in the
sibling repo (the SDK's `dist/` is gitignored).

### Loading in the renderer

The shell has no bundler. Use **native ES modules + import map** (Path
B in the SDK readme):

- Add an `<script type="importmap">` to `index.html` mapping the bare
  specifier to the SDK's built entry under `node_modules`.
- Flip `<script src="app.js">` to `<script src="app.js" type="module">`.
- Internal `dist/*.js` imports inside the SDK are relative to itself,
  so the import map only needs the bare-specifier entry.

### Shell rewrite

In `app.js`, replace only the chat-related block. Tab management, file
menu IPC, backup modal, etc. stay untouched.

- Drop `AGENT_URL` constant in favor of constructing
  `new AgentClient({ serverUrl: "http://localhost:2999" })` once at
  module load.
- Drop the startup `GET /health` probe (no such endpoint). Meter starts
  `off`; flips to `on` after the first successful `done` event from
  `/chat`.
- `sendChat()` consumes the SDK's `AsyncIterable<ChatEvent>`:
  - `text-delta` → append delta to current assistant line
  - `tool-input-start` → start a "tool: name" row
  - `tool-input-available` → format input details into the tool row
  - `tool-output-available` → mark `result` (or error) on the tool row
  - `done` → final flush; meter `on`; chat history saved
- Reset becomes client-side only: `client.reset()` + clear
  `chatLog.innerHTML` + clear localStorage. No HTTP call.
- An `AbortController` is held per send; the SDK rolls back the
  in-flight user message automatically on abort/error.
- Existing localStorage persistence of `chatLog` DOM stays — it's a
  visual record, separate from `client.messages` (which lives in
  memory and is the agent's protocol-level state).

## Known caveats

- **Packaging.** `file:..` deps don't survive an Electron `.app` bundle
  unless the packager copies the SDK `dist/` next to the renderer.
  Documented in the SDK's README and not in scope for this plan; the
  macOS packager (plan 8d) is still a scaffold.
- **Sequential sends only.** Disable the send button while an iterator
  is active. Existing `chatBusy` flag already does this.
- **No `crypto.randomUUID()` polyfill.** Modern Electron renderers
  ship it; not concerned for current Electron 41.

## Verification

After wiring it in:

1. `npm run build` — clean.
2. `npm run lint` — clean.
3. `npm run mock:runner:debug` — Network panel shows
   `POST /chat` with `{messages: [...]}`, response `200`, `data: {...}`
   chunks. Console exposes `globalThis.client = new AgentClient(...)`
   for ad-hoc smoke tests.
4. `client.messages` after a successful exchange has length 2 (user +
   assistant).
5. Reset clears UI + `client.messages.length === 0`.
