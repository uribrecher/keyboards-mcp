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
