#!/usr/bin/env tsx
/**
 * Nord Electro 5D Agent Service
 *
 * HTTP server (port 3001) that bridges the web UI chat to Claude API
 * with Nord MCP tools. Spawns keyboards-mcp as a child process and
 * connects to it as an MCP client.
 *
 * Usage: ANTHROPIC_API_KEY=sk-... npx tsx src/agent.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 3001;
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

/** Load the Nord backup inventory if available, to include in the system prompt. */
function loadInventory(): string {
  const inventoryPath = process.env.NORD_INVENTORY
    || join(__dirname, "..", "data", "nord_backup_inventory.md");
  if (!existsSync(inventoryPath)) {
    console.warn(`Inventory file not found at ${inventoryPath} — agent will run without it.`);
    return "";
  }
  const content = readFileSync(inventoryPath, "utf-8");
  console.log(`Loaded inventory from ${inventoryPath} (${content.length} chars)`);
  return `\n\nNORD BACKUP INVENTORY:\n${content}`;
}

const SYSTEM_PROMPT = `You are controlling a Nord Electro 5D keyboard via MIDI.
You have access to tools that let you list parameters, set parameters, apply patches, and more.
You also have web search to research sounds, patches, and keyboard techniques.
Use the tools to fulfill the user's requests about keyboard sounds and patches.
Be concise in your responses. When setting parameters, explain what you're doing briefly.
You can set multiple parameters at once using the set_parameters tool.

CONNECTION:
The following tools REQUIRE an active MIDI connection: set_parameters, apply_patch, load_program.
Before using any of them, call is_connected to verify. If not connected, call connect_to_nord first.
These tools do NOT require a connection: is_connected, connect_to_nord, disconnect_from_nord, list_midi_devices, list_parameters, list_presets, get_current_state, extract_backup, get_last_backup_location.

MIDI ROUTING:
All parameters are sent on the global MIDI channel. There is no per-part MIDI routing.
Piano model index is 1-based and per-category (matching the Nord display).
Sample index is also 1-based. Clavinet has only one model but 4 pickup variations (A/B/C/D) set via piano_variation.
Consult the NORD BACKUP INVENTORY section for model and sample names. If no inventory is available, use numeric references (e.g., Grand:1) and suggest the user run extract_backup.

BI-TIMBRAL MODE:
The Nord Electro 5D has two parts (Lower and Upper).
- LAYER MODE (split off): Both parts span the entire keyboard. You CANNOT assign the same engine type to both parts — each layer must use a different engine (e.g., Organ + Piano, Piano + Sample Synth, Organ + Sample Synth).
- SPLIT MODE (split on): Each part gets its own keyboard zone. You CAN use the same engine on both parts. However, Piano and Sample Synth share model/sample selection across parts — only one piano model and one sample at a time.

ORGAN PRESET ROUTING:
In split mode, Organ Preset 1 routes to the Lower part and Preset 2 routes to the Upper part. The organ model is global (shared), but each preset has its own drawbar registration. To set different organ sounds per part: select Preset 1, set its drawbars, then select Preset 2 and set different drawbars.

ORGAN MODEL CAPABILITIES:
- B3: Full vibrato (V1-V3, C1-C3), full percussion, drawbars 0-8
- B3+Bass: Similar to B3
- Vox: Vibrato V1-V3 only (no chorus). No percussion. Drawbars 0-8.
- Farfisa: Vibrato V1, V2, C2, C3 only. No percussion. Drawbars are on/off toggles (0 or 1).
- Pipe: No vibrato. No percussion.

SOUND SELECTION:
The NORD BACKUP INVENTORY section at the end of this prompt contains the contents of the keyboard's backup. Use it to find stored programs, pianos, and samples.
When the user asks for a sound, PREFER loading a stored program (via load_program) over building one from scratch with apply_patch.
Only use apply_patch or set_parameters to create a sound from scratch if no adequate program exists in the inventory.
Programs are numbered bank:1-50, matching the hardware display. Always use this notation when communicating with the user.

RECREATING SPECIFIC SONGS:
When the user asks for a specific song or artist's sound, do NOT guess from the genre (e.g., "funk band → clav"). Instead:
1. Use web_search to research the actual keyboard parts in that specific song — what instruments are used, how many keyboard layers, what effects, what role each part plays in the mix.
2. Describe what you found: which keyboards are in the recording, their timbral characteristics, and how they sit in the arrangement.
3. Then map those findings to the available Nord sounds from the inventory.
4. If the song has multiple keyboard parts, explain which one you're recreating and why (or offer to set up a split/layer).
5. If you're unsure about the exact sound, say so — don't fill gaps with genre clichés.

SOUND DESIGN TIPS:
- Do NOT use vibrato/chorus together with the rotary speaker (Leslie) — they clash sonically.
- When using the rotary speaker, set spkr_comp_type to "Rotary" and spkr_comp_enable to on.
- For classic Hammond organ tones, use B3 model with appropriate drawbar settings and the Leslie rotary speaker.`;

const inventorySection = loadInventory();
const FULL_SYSTEM_PROMPT = SYSTEM_PROMPT + inventorySection;

// ── MCP Client Setup ──

let mcpClient: Client;
let mcpTools: Anthropic.Tool[] = [];

async function setupMCP(): Promise<void> {
  const serverPath = join(__dirname, "..", "dist", "index.js");

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
  });

  mcpClient = new Client({ name: "nord-agent", version: "1.0.0" });
  await mcpClient.connect(transport);

  // Discover tools and convert to Anthropic format
  const { tools } = await mcpClient.listTools();
  mcpTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));

  console.log(`MCP connected. ${mcpTools.length} tools available:`);
  for (const t of mcpTools) {
    console.log(`  - ${t.name}`);
  }

  // Auto-connect to MIDI port (auto-detect Nord, or use MIDI_PORT env var)
  const midiPort = process.env.MIDI_PORT;
  try {
    const listResult = await mcpClient.callTool({ name: "list_midi_devices", arguments: {} });
    const portsText = (listResult.content as Array<{type: string; text: string}>).map(c => c.text).join("");
    console.log("MIDI ports:", portsText);

    const connectResult = await mcpClient.callTool({
      name: "connect_to_nord",
      arguments: midiPort ? { port: midiPort } : {},
    });
    const connectText = (connectResult.content as Array<{type: string; text: string}>).map(c => c.text).join("");
    console.log("Auto-connect:", connectText);
  } catch (err) {
    console.warn(`Auto-connect to "${midiPort}" failed. Set MIDI_PORT env var or ask Claude to connect.`, err);
  }
}

// ── Anthropic Client ──

const anthropic = new Anthropic();

// Conversation history (single session, in-memory)
let conversationHistory: Anthropic.MessageParam[] = [];

async function handleChat(
  userMessage: string,
  onEvent: (event: string, data: unknown) => void
): Promise<void> {
  conversationHistory.push({ role: "user", content: userMessage });

  let continueLoop = true;

  while (continueLoop) {
    continueLoop = false;

    console.log(`Calling Claude API (${MODEL}, ${conversationHistory.length} messages, ${mcpTools.length} tools)...`);
    let response;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: FULL_SYSTEM_PROMPT,
        tools: [
          ...mcpTools,
          { type: "web_search_20250305", name: "web_search", max_uses: 5 } as any,
        ],
        messages: conversationHistory,
      });
      console.log(`Response: stop_reason=${response.stop_reason}, ${response.content.length} blocks`);
    } catch (apiErr: unknown) {
      console.error("API Error:", apiErr);
      throw apiErr;
    }

    // Process response content blocks
    const assistantContent: Anthropic.ContentBlock[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      assistantContent.push(block);

      if (block.type === "text") {
        onEvent("text", { text: block.text });
      } else if (block.type === "tool_use") {
        onEvent("tool_use", { id: block.id, name: block.name, input: block.input });

        // Execute tool via MCP
        try {
          const result = await mcpClient.callTool({
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });

          const resultText = Array.isArray(result.content)
            ? result.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("\n")
            : String(result.content);

          onEvent("tool_result", { id: block.id, name: block.name, result: resultText });

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: resultText,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          onEvent("tool_result", { id: block.id, name: block.name, result: `Error: ${errorMsg}`, isError: true });

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${errorMsg}`,
            is_error: true,
          });
        }
      } else if ((block as any).type === "server_tool_use") {
        // Web search — handled server-side by Anthropic, just show it in the UI
        onEvent("tool_use", { id: (block as any).id, name: (block as any).name ?? "web_search", input: (block as any).input });
      } else if ((block as any).type === "web_search_tool_result") {
        // Web search results — already processed by the API
        const searchBlock = block as any;
        const resultSummary = Array.isArray(searchBlock.content)
          ? searchBlock.content
              .filter((c: any) => c.type === "web_search_result")
              .map((c: any) => `${c.title}: ${c.url}`)
              .join("\n")
          : "Search completed";
        onEvent("tool_result", { id: searchBlock.id ?? "", name: "web_search", result: resultSummary });
      }
    }

    // Add assistant message to history
    conversationHistory.push({ role: "assistant", content: assistantContent });

    // If there were tool calls, add results and continue the loop
    if (toolResults.length > 0) {
      conversationHistory.push({ role: "user", content: toolResults });
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
  setCorsHeaders(res);

  // CORS preflight
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

    // SSE response
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

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

// ── Main ──

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    console.error("Usage: ANTHROPIC_API_KEY=sk-... npx tsx src/agent.ts");
    process.exit(1);
  }

  // Debug: show key prefix and model
  const keyPrefix = process.env.ANTHROPIC_API_KEY.substring(0, 12);
  console.log(`API key: ${keyPrefix}...`);
  console.log(`Model: ${MODEL}`);

  console.log("Starting Nord Electro 5D Agent...");

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
