# Agent Migration: Anthropic SDK to mlx-lm (Local LLM)

## Motivation

Run the keyboard agent fully offline using a local LLM on Apple Silicon via mlx-lm, eliminating API costs and internet dependency.

## Approach

**OpenAI SDK + mlx_lm.server.** mlx_lm.server exposes an OpenAI-compatible `/v1/chat/completions` endpoint. The agent replaces the Anthropic SDK with the OpenAI Node SDK and calls the local server.

Two processes:
1. `mlx_lm.server` — serves the model locally (user starts via `npm run run:mlx`)
2. `agent` — the existing HTTP server, now calling the local LLM instead of Anthropic

## Dependencies

**Add:** `openai` (OpenAI Node SDK)
**Remove:** `@anthropic-ai/sdk`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://localhost:8080/v1` | OpenAI-compatible endpoint |
| `MLX_MODEL` | `mlx-community/Qwen2.5-7B-Instruct-4bit` | Model for mlx_lm.server (run:mlx script) |
| `MLX_PORT` | `8080` | Port for mlx_lm.server |
| `MIDI_PORT` | (auto-detect) | MIDI port (unchanged) |
| `MAX_HISTORY_MESSAGES` | `40` | Max conversation messages before trimming |

**Removed:** `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`

## npm Scripts

```json
{
  "run:mlx": "mlx_lm.server --model ${MLX_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit} --port ${MLX_PORT:-8080}",
  "agent": "tsx src/agent.ts"
}
```

## Tool Schema Conversion

MCP tool schemas convert from Anthropic format to OpenAI function-calling format:

```
Anthropic:                        OpenAI:
{ name, description,        ->    { type: "function",
  input_schema }                    function: { name, description,
                                               parameters } }
```

MCP's `inputSchema` maps directly to OpenAI's `parameters` (both JSON Schema).

## Agentic Tool-Use Loop

The core loop structure stays the same (send message -> check for tool calls -> execute -> feed back -> repeat). The protocol mapping:

| Aspect | Anthropic SDK | OpenAI SDK |
|--------|--------------|------------|
| Response tool calls | `block.type === "tool_use"` | `choice.message.tool_calls[]` |
| Tool call ID | `block.id` | `tool_call.id` |
| Tool name | `block.name` | `tool_call.function.name` |
| Tool input | `block.input` (object) | `tool_call.function.arguments` (JSON string, must parse) |
| Feed result back | `{ type: "tool_result", tool_use_id, content }` | `{ role: "tool", tool_call_id, content }` |
| Continue signal | `stop_reason === "tool_use"` | `finish_reason === "tool_calls"` |

Conversation history changes from Anthropic's `content: ContentBlock[]` to OpenAI's `content: string` + `tool_calls` array on assistant messages.

## Web Search

Replace Anthropic's server-side `web_search_20250305` tool with a new MCP tool registered in the keyboards-mcp server.

**New file:** `src/tools/web-search.ts`
- Registers a `web_search` MCP tool
- Takes a `query` string parameter
- Calls DuckDuckGo HTML search (`https://html.duckduckgo.com/html/?q=...`), parses result snippets
- Returns search results as text (title + URL + snippet)

**Drop from agent:** All `server_tool_use` and `web_search_tool_result` block handling. Web search becomes a standard MCP tool call, no special cases.

## System Prompt Changes

**Moderate trimming** to fit local model context windows:
- Keep all domain instructions (connection flow, sound selection, song recreation guidelines, sound design tips)
- Compress inventory: keep program list (bank:slot + name), piano model names, sample names. Strip per-program parameter details, set list song-level assignments, and usage counts
- Remove Anthropic-specific references
- Target: roughly halve the current system prompt size

## Error Handling

**Startup validation:** Agent pings `GET /v1/models` on launch. If unreachable, prints "Cannot reach LLM server at <url>. Start mlx_lm.server first (npm run run:mlx)." and exits.

**Malformed tool calls:** Local models may produce bad tool calls. The agent:
- Catches JSON parse errors on `tool_call.function.arguments` and returns a clear error to the model
- Rejects unknown tool names with a message listing available tools
- Lets the model self-correct within the agentic loop

**Conversation trimming:** When history exceeds `MAX_HISTORY_MESSAGES`, trim oldest message pairs while preserving the system prompt.

## Files Changed

| File | Change |
|------|--------|
| `src/agent.ts` | Main migration: OpenAI SDK, tool schema conversion, agentic loop rewrite, system prompt compression, startup validation, history trimming |
| `package.json` | Replace `@anthropic-ai/sdk` with `openai`, update `agent` script, add `run:mlx` script |
| `src/tools/web-search.ts` | New MCP tool for web search |
| `src/index.ts` | Register web_search tool |

## Out of Scope

- Keyboard model code, MCP server core, mock runner, existing tools — unchanged
- Streaming responses from mlx_lm (SSE to chat UI continues to work, but LLM responses are non-streaming for simplicity; can add later)
- Multi-MCP-client architecture
- Automatic mlx_lm.server lifecycle management (user starts/stops it)
