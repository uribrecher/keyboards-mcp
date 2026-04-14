# Agent mlx-lm Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Anthropic SDK in `src/agent.ts` with the OpenAI SDK, pointing at a local mlx_lm.server for fully offline, cost-free keyboard agent operation.

**Architecture:** The agent HTTP server (port 3001) calls an OpenAI-compatible local LLM via the OpenAI Node SDK instead of the Anthropic API. mlx_lm.server runs as a separate process. Web search moves from Anthropic's server-side tool to a new MCP tool using DuckDuckGo.

**Tech Stack:** TypeScript (ESM, Node16), OpenAI Node SDK, mlx_lm.server, MCP SDK, DuckDuckGo HTML search

**Spec:** `docs/superpowers/specs/2026-04-14-agent-mlx-lm-migration-design.md`

---

### Task 1: Add web_search MCP Tool

**Files:**
- Create: `src/tools/web-search.ts`
- Modify: `src/index.ts`

This task adds web search as a standard MCP tool so the agent (and any MCP client) can search the web. Does not depend on the agent migration — works with the existing Anthropic agent too.

- [ ] **Step 1: Create `src/tools/web-search.ts`**

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerWebSearch(server: McpServer): void {
  server.registerTool(
    "web_search",
    {
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets for the top results.",
      inputSchema: {
        query: z.string().describe("The search query"),
      },
    },
    async ({ query }) => {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      let html: string;
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "keyboards-mcp/1.0" },
        });
        html = await resp.text();
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${(err as Error).message}` }],
          isError: true,
        };
      }

      // Parse DuckDuckGo HTML results — each result is in a <div class="result">
      // with <a class="result__a"> for title/URL and <a class="result__snippet"> for snippet
      const results: string[] = [];
      const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/g;
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
        const resultUrl = match[1].replace(/&amp;/g, "&");
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        if (title && resultUrl) {
          results.push(`${title}\n${resultUrl}\n${snippet}`);
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found for: ${query}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: results.join("\n\n") }],
      };
    },
  );
}
```

- [ ] **Step 2: Register in `src/index.ts`**

Add the import and registration call. Add after the existing tool registrations:

```typescript
import { registerWebSearch } from "./tools/web-search.js";
```

And after the last `register*` call:

```typescript
registerWebSearch(server);
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/web-search.ts src/index.ts
git commit -m "feat: add web_search MCP tool using DuckDuckGo"
```

---

### Task 2: Rewrite Agent — OpenAI SDK + Tool Loop

**Files:**
- Modify: `src/agent.ts`

This is the main migration task. Rewrite `src/agent.ts` to use the OpenAI SDK instead of Anthropic. The file structure stays the same (imports, constants, MCP setup, chat handler, HTTP server, main). The changes are:

1. Swap SDK imports and client initialization
2. Convert MCP tools to OpenAI function-calling format
3. Rewrite the agentic tool-use loop
4. Update conversation history types
5. Add startup validation (ping LLM server)
6. Add conversation history trimming
7. Compress system prompt
8. Remove all Anthropic-specific block handling (web_search_tool_result, server_tool_use)

- [ ] **Step 1: Replace the entire `src/agent.ts` with the migrated version**

Replace the full file contents with:

```typescript
#!/usr/bin/env tsx
/**
 * Keyboard Agent Service
 *
 * HTTP server (port 3001) that bridges the web UI chat to a local LLM
 * (via OpenAI-compatible API) with keyboard MCP tools.
 * Spawns keyboards-mcp as a child process and connects as an MCP client.
 *
 * Usage: npx tsx src/agent.ts
 * Requires: mlx_lm.server running (npm run run:mlx)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 3001;
const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://localhost:8080/v1";
const MAX_HISTORY = Number(process.env.MAX_HISTORY_MESSAGES) || 40;

/** Load a backup inventory file if available, to include in the system prompt. */
function loadInventory(): string {
  const explicit = process.env.KEYBOARD_INVENTORY;
  if (explicit && existsSync(explicit)) {
    const content = readFileSync(explicit, "utf-8");
    console.log(`Loaded inventory from ${explicit} (${content.length} chars)`);
    return compressInventory(content);
  }
  const dataDir = join(__dirname, "..", "data");
  if (existsSync(dataDir)) {
    const files = readdirSync(dataDir).filter(f => f.endsWith("_backup_inventory.md"));
    if (files.length > 0) {
      const path = join(dataDir, files[0]);
      const content = readFileSync(path, "utf-8");
      console.log(`Loaded inventory from ${path} (${content.length} chars)`);
      return compressInventory(content);
    }
  }
  console.warn("No inventory file found — agent will run without it.");
  return "";
}

/**
 * Compress the inventory for smaller context windows.
 * Keeps program names (bank:slot + name), piano models, and sample names.
 * Strips per-program parameter details, set list song assignments, and usage counts.
 */
function compressInventory(raw: string): string {
  const lines = raw.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    // Skip parameter detail blocks (indented lines after program entries)
    if (/^  {2,}/.test(line) && skipping) continue;

    // Skip "Used by" lines
    if (/used by/i.test(line)) continue;

    // Skip set list song-level assignment details (lines like "  A: Program 1:01 ...")
    if (/^\s+[A-D]:\s+Program\s+/i.test(line)) continue;

    // Keep section headers and program/piano/sample list entries
    if (line.startsWith("#") || line.startsWith("-") || line.startsWith("|") || line.trim() === "") {
      skipping = false;
      kept.push(line);
    } else {
      // Start of a parameter detail block — skip
      skipping = true;
    }
  }

  const compressed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return `\n\nKEYBOARD BACKUP INVENTORY (compressed):\n${compressed}`;
}

const SYSTEM_PROMPT = `You are controlling a MIDI keyboard via an MCP server.
You have access to tools that let you list parameters, set parameters, apply patches, search the web, and more.
Use the tools to fulfill the user's requests about keyboard sounds and patches.
Be concise in your responses. When setting parameters, explain what you're doing briefly.
You can set multiple parameters at once using the set_parameters tool.

CONNECTION:
The following tools REQUIRE an active MIDI connection: set_parameters, apply_patch, load_program, load_song.
Before using any of them, call is_connected to verify. If not connected, call connect_to_keyboard first.
These tools do NOT require a connection: is_connected, connect_to_keyboard, disconnect_from_keyboard, list_midi_devices, list_parameters, list_presets, get_current_state, extract_backup, get_last_backup_location, web_search.

MIDI ROUTING:
All parameters are sent on the global MIDI channel. There is no per-part MIDI routing.
Piano model index is 1-based and per-category (matching the hardware display).
Sample index is also 1-based.

SOUND SELECTION:
When the user asks for a sound, PREFER loading a stored program (via load_program) over building one from scratch with apply_patch.
Only use apply_patch or set_parameters to create a sound from scratch if no adequate program exists in the inventory.
Programs are numbered by bank and slot, matching the hardware display.

RECREATING SPECIFIC SONGS:
When the user asks for a specific song or artist's sound:
1. Use web_search to research the actual keyboard parts in that specific song.
2. Describe what you found: which keyboards, timbral characteristics, arrangement role.
3. Map findings to available sounds from the inventory.
4. If the song has multiple keyboard parts, explain which one you're recreating and why.
5. If unsure about the exact sound, say so.

SOUND DESIGN TIPS:
- Do NOT use vibrato/chorus together with the rotary speaker (Leslie) — they clash sonically.
- When using the rotary speaker, set spkr_comp_type to "Rotary" and spkr_comp_enable to on.`;

const inventorySection = loadInventory();
let FULL_SYSTEM_PROMPT = SYSTEM_PROMPT + inventorySection;

// ── MCP Client Setup ──

let mcpClient: Client;
let mcpTools: ChatCompletionTool[] = [];

async function setupMCP(): Promise<void> {
  const serverPath = join(__dirname, "..", "dist", "index.js");

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
  });

  mcpClient = new Client({ name: "keyboard-agent", version: "1.0.0" });
  await mcpClient.connect(transport);

  // Discover tools and convert to OpenAI function-calling format
  const { tools } = await mcpClient.listTools();
  mcpTools = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));

  console.log(`MCP connected. ${mcpTools.length} tools available:`);
  for (const t of mcpTools) {
    console.log(`  - ${t.function.name}`);
  }

  // Auto-connect to MIDI port
  const midiPort = process.env.MIDI_PORT;
  try {
    const listResult = await mcpClient.callTool({ name: "list_midi_devices", arguments: {} });
    const portsText = (listResult.content as Array<{ type: string; text: string }>).map(c => c.text).join("");
    console.log("MIDI ports:", portsText);

    const connectResult = await mcpClient.callTool({
      name: "connect_to_keyboard",
      arguments: midiPort ? { port: midiPort } : {},
    });
    const connectText = (connectResult.content as Array<{ type: string; text: string }>).map(c => c.text).join("");
    console.log("Auto-connect:", connectText);

    // Fetch model-specific system prompt
    try {
      const promptResult = await mcpClient.callTool({ name: "get_system_prompt", arguments: {} });
      const promptText = (promptResult.content as Array<{ type: string; text: string }>).map(c => c.text).join("");
      if (!promptResult.isError && promptText) {
        FULL_SYSTEM_PROMPT += `\n\n${promptText}`;
        console.log("Loaded model-specific system prompt");
      }
    } catch {
      // Non-fatal — agent works without model-specific prompt
    }
  } catch (err) {
    console.warn("Auto-connect failed. Set MIDI_PORT env var or ask the LLM to connect.", err);
  }
}

// ── LLM Client ──

const openai = new OpenAI({
  baseURL: LLM_BASE_URL,
  apiKey: "not-needed",
});

let conversationHistory: ChatCompletionMessageParam[] = [];

/** Trim conversation history to stay within context limits. */
function trimHistory(): void {
  if (conversationHistory.length <= MAX_HISTORY) return;
  // Keep the most recent messages, drop oldest pairs
  const excess = conversationHistory.length - MAX_HISTORY;
  conversationHistory = conversationHistory.slice(excess);
}

async function handleChat(
  userMessage: string,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  conversationHistory.push({ role: "user", content: userMessage });
  trimHistory();

  let continueLoop = true;

  while (continueLoop) {
    continueLoop = false;

    console.log(`Calling LLM (${conversationHistory.length} messages, ${mcpTools.length} tools)...`);
    let response;
    try {
      response = await openai.chat.completions.create({
        model: "default",
        max_tokens: 4096,
        messages: [
          { role: "system", content: FULL_SYSTEM_PROMPT },
          ...conversationHistory,
        ],
        tools: mcpTools.length > 0 ? mcpTools : undefined,
      });
    } catch (apiErr: unknown) {
      console.error("LLM Error:", apiErr);
      throw apiErr;
    }

    const choice = response.choices[0];
    if (!choice) throw new Error("No response from LLM");

    console.log(`Response: finish_reason=${choice.finish_reason}, tool_calls=${choice.message.tool_calls?.length ?? 0}`);

    // Emit text content
    if (choice.message.content) {
      onEvent("text", { text: choice.message.content });
    }

    // Add assistant message to history (including tool_calls if present)
    conversationHistory.push(choice.message);

    // Process tool calls
    const toolCalls = choice.message.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        onEvent("tool_use", { id: toolCall.id, name: toolName, input: toolCall.function.arguments });

        // Parse arguments (OpenAI sends them as a JSON string)
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          const errorMsg = `Invalid JSON in tool arguments: ${toolCall.function.arguments}. Please try again with valid JSON.`;
          onEvent("tool_result", { id: toolCall.id, name: toolName, result: errorMsg, isError: true });
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: errorMsg,
          });
          continueLoop = true;
          continue;
        }

        // Check if tool exists
        const toolExists = mcpTools.some(t => t.function.name === toolName);
        if (!toolExists) {
          const available = mcpTools.map(t => t.function.name).join(", ");
          const errorMsg = `Unknown tool "${toolName}". Available tools: ${available}`;
          onEvent("tool_result", { id: toolCall.id, name: toolName, result: errorMsg, isError: true });
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: errorMsg,
          });
          continueLoop = true;
          continue;
        }

        // Execute tool via MCP
        try {
          const result = await mcpClient.callTool({ name: toolName, arguments: args });
          const resultText = Array.isArray(result.content)
            ? result.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("\n")
            : String(result.content);

          onEvent("tool_result", { id: toolCall.id, name: toolName, result: resultText });
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultText,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          onEvent("tool_result", { id: toolCall.id, name: toolName, result: `Error: ${errorMsg}`, isError: true });
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: ${errorMsg}`,
          });
        }
      }
      continueLoop = true;
    }
  }

  onEvent("done", {});
}

// ── HTTP Server ──

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  console.log(`${req.method} ${req.url}`);
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/chat") {
    const body = JSON.parse(await readBody(req));
    const message = body.message as string;

    if (!message) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing message field" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      await handleChat(message, (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
    }

    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/reset") {
    conversationHistory = [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/re-extract") {
    res.setHeader("Content-Type", "application/json");
    try {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      let backupPath: string | undefined = parsed.path;
      console.log("re-extract request:", JSON.stringify(parsed));

      const pathResult = await mcpClient.callTool({ name: "get_last_backup_location", arguments: {} });
      const pathText = (pathResult.content as Array<{ type: string; text: string }>)
        .map(c => c.text).join("");
      const lastPath = (!pathResult.isError && pathText && !pathText.includes("No previous backup"))
        ? pathText.trim()
        : undefined;

      if (!backupPath) {
        backupPath = lastPath;
      }

      if (!backupPath) {
        const baseDir = lastPath ? dirname(lastPath) : join(__dirname, "..");
        console.log("re-extract: no path found, returning baseDir:", baseDir);
        res.writeHead(200);
        res.end(JSON.stringify({ error: "no_path", baseDir }));
        return;
      }
      console.log("re-extract: extracting from", backupPath);

      const result = await mcpClient.callTool({
        name: "extract_backup",
        arguments: { file_path: backupPath },
      });
      const resultText = (result.content as Array<{ type: string; text: string }>)
        .map(c => c.text).join("");

      if (result.isError) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: "extract_failed", message: resultText }));
        return;
      }

      const summary = resultText.split("\n").slice(0, 7).join("\n");
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, summary, path: backupPath }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "server_error", message: errorMsg }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

// ── Main ──

async function main(): Promise<void> {
  console.log(`LLM endpoint: ${LLM_BASE_URL}`);

  // Validate LLM server is reachable
  try {
    const resp = await fetch(`${LLM_BASE_URL}/models`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    console.log("LLM server reachable");
  } catch (err) {
    console.error(`Cannot reach LLM server at ${LLM_BASE_URL}.`);
    console.error("Start mlx_lm.server first: npm run run:mlx");
    process.exit(1);
  }

  console.log("Starting Keyboard Agent...");

  await setupMCP();

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Request error:", err);
      res.writeHead(500);
      res.end("Internal error");
    });
  });

  server.listen(PORT, () => {
    console.log(`Agent service running on http://localhost:${PORT}`);
    console.log(`  POST /chat   — send a prompt`);
    console.log(`  POST /reset  — clear conversation history`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down agent...");
    await mcpClient.close();
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify compilation**

Run: `npm run build`
Expected: Clean compilation, no errors. The `dist/agent.js` file is produced.

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "feat: migrate agent from Anthropic SDK to OpenAI SDK for local mlx-lm"
```

---

### Task 3: Update package.json Scripts and Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

In `package.json`:

1. In `dependencies`, remove `"@anthropic-ai/sdk": "^0.80.0"` and add `"openai": "^4.80.0"`
2. Replace the `"agent"` script:
   - Old: `"agent": "ANTHROPIC_API_KEY=$(op item get zevuqtkunbnvdjzt5rbnyvsw6q --reveal --account my.1password.com --fields label=credential) tsx src/agent.ts"`
   - New: `"agent": "tsx src/agent.ts"`
3. Add new script:
   - `"run:mlx": "mlx_lm.server --model ${MLX_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit} --port ${MLX_PORT:-8080}"`

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `openai` added to node_modules, `@anthropic-ai/sdk` removed.

- [ ] **Step 3: Build to verify everything compiles together**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: swap @anthropic-ai/sdk for openai, update agent script, add run:mlx"
```

---

### Task 4: Smoke Test

No code changes. Verify the full stack works end-to-end.

- [ ] **Step 1: Start mlx_lm.server**

In a separate terminal:
```bash
npm run run:mlx
```

Expected: Model loads and server starts on port 8080. If `mlx-lm` is not installed, install it first: `pip install mlx-lm`.

- [ ] **Step 2: Start the agent**

In another terminal:
```bash
npm run agent
```

Expected output includes:
- `LLM endpoint: http://localhost:8080/v1`
- `LLM server reachable`
- `MCP connected. N tools available:` (including `web_search`)
- `Agent service running on http://localhost:3001`

- [ ] **Step 3: Test a chat request**

```bash
curl -X POST http://localhost:3001/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "List available MIDI devices"}' \
  --no-buffer
```

Expected: SSE events with tool_use (list_midi_devices), tool_result, and a text response from the LLM.

- [ ] **Step 4: Test conversation reset**

```bash
curl -X POST http://localhost:3001/reset
```

Expected: `{"ok":true}`

- [ ] **Step 5: Test startup without LLM server**

Stop mlx_lm.server, then run:
```bash
npm run agent
```

Expected: Prints "Cannot reach LLM server at http://localhost:8080/v1." and exits with code 1.
