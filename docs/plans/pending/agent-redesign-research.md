# Agent Redesign — Research Notes

> **Not a plan.** This document captures design research and code suggestions from a Gemini conversation, plus review notes. To be formalized into a plan under task 8a.

## Background

The current `src/agent.ts` is a standalone HTTP server (port 3001) that bridges a chat UI to the Claude API. It spawns keyboards-mcp as a single child MCP process, uses the OpenAI SDK directly, and streams responses via SSE.

The redesign replaces this with a **Vercel AI SDK**-based agent that is:
- **Provider-agnostic** — swap LLM providers by changing one import + model name
- **Multi-MCP** — connects to both keyboards-mcp and audio-analysis-mcp (plan 7)
- **Web-search-capable** — via Vercel AI Gateway with built-in Perplexity search tool
- **Skill-aware** — preloads the recreate-sound workflow as a system prompt

## Gemini Suggestion: Basic Agent Pattern

Demonstrates the Vercel AI SDK's provider-agnostic tool mapping with a single MCP server.

```typescript
import { generateText, tool, jsonSchema } from "ai";
import { openai } from "@ai-sdk/openai"; // or: import { anthropic } from "@ai-sdk/anthropic"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runAgent() {
  // 1. Configure the stdio transport to point to your local MCP server
  const transport = new StdioClientTransport({
    command: "node",
    args: ["./path/to/your/mcp-server.js"],
  });

  // 2. Initialize and connect the MCP Client
  const mcpClient = new Client(
    { name: "my-electron-app", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  await mcpClient.connect(transport);
  console.log("✅ MCP Server connected via stdio");

  // 3. Fetch the list of safe tools you already built
  const { tools: mcpTools } = await mcpClient.listTools();

  // 4. Map the MCP tools into the Vercel AI SDK format
  const aiTools = {};

  for (const mcpTool of mcpTools) {
    aiTools[mcpTool.name] = tool({
      description: mcpTool.description,
      parameters: jsonSchema(mcpTool.inputSchema),
      execute: async (args) => {
        console.log(`\n⚙️  Agent triggering local tool: ${mcpTool.name}`);

        const result = await mcpClient.callTool({
          name: mcpTool.name,
          arguments: args,
        });

        return result;
      },
    });
  }

  // 5. Run the Cloud Agent Loop
  console.log("\n🤖 Cloud Agent is thinking...");

  const result = await generateText({
    model: openai("gpt-4o"), // Provider swap: just change this line
    prompt: "Please look at the current user data and give me a summary.",
    tools: aiTools,
    maxSteps: 5,
  });

  console.log("\n💬 Final Answer from Agent:\n");
  console.log(result.text);

  // Cleanup the background process when done
  await transport.close();
}

runAgent().catch(console.error);
```

**Key insight:** Provider swap is just the import and model string. Core logic (tool mapping, MCP integration) stays identical.

## Gemini Suggestion: Full Electron Integration

### Main Process (Electron IPC handler)

Multi-MCP, streaming, Vercel Gateway with Perplexity search.

```typescript
import { ipcMain } from "electron";
import { streamText, tool, jsonSchema } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Initialize your Vercel Gateway
const myGateway = createGateway({
  apiKey: process.env.VERCEL_GATEWAY_API_KEY,
});

// Listen for messages from the React UI
ipcMain.on("send-chat-message", async (event, userPrompt) => {
  const mcpServerConfigs = [
    { id: "database-mcp", scriptPath: "./mcp-db-server.js" },
    { id: "files-mcp", scriptPath: "./mcp-file-server.js" },
  ];

  const activeTransports = [];
  const aiTools: Record<string, any> = {};

  try {
    // 1. Connect to both MCP Servers
    for (const config of mcpServerConfigs) {
      const transport = new StdioClientTransport({
        command: "node",
        args: [config.scriptPath],
      });
      activeTransports.push(transport);

      const mcpClient = new Client(
        { name: config.id, version: "1.0.0" },
        { capabilities: { tools: {} } }
      );
      await mcpClient.connect(transport);

      const { tools: mcpTools } = await mcpClient.listTools();

      for (const mcpTool of mcpTools) {
        aiTools[mcpTool.name] = tool({
          description: mcpTool.description,
          parameters: jsonSchema(mcpTool.inputSchema),
          execute: async (args) => {
            // Optional: Tell UI a tool is running
            event.sender.send(
              "agent-status",
              `Running local tool: ${mcpTool.name}...`
            );
            return await mcpClient.callTool({
              name: mcpTool.name,
              arguments: args,
            });
          },
        });
      }
    }

    // 2. Add the Vercel Gateway Web Search Tool
    aiTools["web_search"] = myGateway.tools.perplexitySearch({
      maxResults: 5,
    });

    event.sender.send("agent-status", "Thinking...");

    // 3. Call the Agent using streamText
    const result = await streamText({
      model: myGateway("anthropic/claude-3-5-sonnet-latest"),
      prompt: userPrompt,
      tools: aiTools,
      maxSteps: 5,
    });

    event.sender.send("agent-status", "Typing...");

    // 4. The Streaming Loop: Push words to the UI as fast as they generate
    for await (const textChunk of result.textStream) {
      event.sender.send("stream-chunk", textChunk);
    }
  } catch (error) {
    console.error("Agent Error:", error);
    event.sender.send("stream-error", "The agent encountered an error.");
  } finally {
    // 5. Cleanup and notify UI we are done
    for (const transport of activeTransports) await transport.close();
    event.sender.send("stream-finished");
  }
});
```

### Preload Script

```typescript
import { contextBridge, ipcRenderer } from "electron";

// Expose safe APIs to the React window
contextBridge.exposeInMainWorld("electronAPI", {
  // Send message to the Main process
  sendMessage: (prompt: string) =>
    ipcRenderer.send("send-chat-message", prompt),

  // Listeners for the streaming text
  onStreamChunk: (callback: (chunk: string) => void) =>
    ipcRenderer.on("stream-chunk", (_event, chunk) => callback(chunk)),

  onAgentStatus: (callback: (status: string) => void) =>
    ipcRenderer.on("agent-status", (_event, status) => callback(status)),

  onStreamFinished: (callback: () => void) =>
    ipcRenderer.on("stream-finished", () => callback()),
});
```

### React UI

```tsx
import React, { useState, useEffect } from "react";

declare global {
  interface Window {
    electronAPI: any;
  }
}

export default function ChatApp() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    { role: string; content: string }[]
  >([]);
  const [currentStream, setCurrentStream] = useState("");
  const [status, setStatus] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    window.electronAPI.onStreamChunk((chunk: string) => {
      setCurrentStream((prev) => prev + chunk);
    });

    window.electronAPI.onAgentStatus((newStatus: string) => {
      setStatus(newStatus);
    });

    window.electronAPI.onStreamFinished(() => {
      setMessages((prev) => [...prev, { role: "agent", content: "" }]);
      setIsTyping(false);
      setStatus("");
    });
  }, []);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages([...messages, { role: "user", content: input }]);
    setInput("");
    setCurrentStream("");
    setIsTyping(true);
    setStatus("Connecting to agent...");
    window.electronAPI.sendMessage(input);
  };

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h2>My Local Agent</h2>
      <div
        style={{
          height: "400px",
          overflowY: "auto",
          border: "1px solid #ccc",
          padding: "10px",
        }}
      >
        {messages.map((msg, idx) => (
          <div
            key={idx}
            style={{
              margin: "10px 0",
              color: msg.role === "user" ? "blue" : "black",
            }}
          >
            <strong>{msg.role.toUpperCase()}: </strong>
            {msg.content}
          </div>
        ))}
        {isTyping && (
          <div style={{ margin: "10px 0", color: "black" }}>
            <strong>AGENT: </strong>
            {currentStream}
            <span className="cursor-blink">|</span>
          </div>
        )}
      </div>
      <div style={{ marginTop: "10px", fontSize: "12px", color: "#666" }}>
        {status}
      </div>
      <div style={{ display: "flex", marginTop: "10px" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ flexGrow: 1, padding: "8px" }}
          disabled={isTyping}
        />
        <button
          onClick={handleSend}
          disabled={isTyping}
          style={{ padding: "8px 16px" }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

## Review — Issues to Fix

### 1. MCP servers spawned per message (critical)

Every `send-chat-message` creates new `StdioClientTransport` instances, spawns child processes, connects, lists tools, then tears them all down in `finally`. This means:
- ~500ms+ latency per message just for MCP startup
- Tool definitions are re-fetched every time (they don't change)
- If the user sends two messages quickly, duplicate server instances are created

**Fix:** MCP clients must be long-lived — start them once at app startup, reuse across all messages. Only tear down on app exit. The tool map should be built once and cached.

### 2. No conversation history

```typescript
const result = await streamText({
  prompt: userPrompt, // ← just the latest message, no history
```

The agent has no memory of prior turns. For a chat interface, the call needs:
```typescript
messages: conversationHistory, // all turns, not just the latest
```

This is critical for the recreate-sound workflow where the agent needs to remember what song it's working on, what stems it separated, what parameters it already tried.

**Fix:** Maintain a `messages` array in the main process (or pass from the UI). Append user messages and agent responses. Pass the full array to `streamText`.

### 3. No system prompt

The plan calls for preloading the recreate-sound skill — that goes in the `system` field of `streamText`. Currently missing entirely. The system prompt should include:
- The recreate-sound workflow (from `docs/recreate-sound.md`)
- Keyboard inventory context (from backup data via `get_system_prompt`)
- Sound design guidelines per connected model

### 4. React streaming bug

```typescript
// onStreamFinished:
setMessages((prev) => [
  ...prev,
  { role: "agent", content: "" }, // ← empty content! currentStream is lost
]);
```

The `currentStream` state is never captured into the finalized message. The comment in the code acknowledges it as a "slight hack" — it's a real bug.

**Fix:**
```typescript
setCurrentStream((finalText) => {
  setMessages((prev) => [...prev, { role: "agent", content: finalText }]);
  return "";
});
```

### 5. IPC listener leak

The `useEffect` registers `onStreamChunk`, `onAgentStatus`, `onStreamFinished` but returns no cleanup function. On React strict mode or re-mounts, listeners accumulate and fire multiple times.

**Fix:** The preload should expose `removeListener` methods. The `useEffect` must return a cleanup function that removes all registered listeners.

### 6. Verify `@ai-sdk/gateway` with `perplexitySearch`

The `createGateway` API and `myGateway.tools.perplexitySearch()` may not be real Vercel AI SDK APIs. The SDK has provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`) but the gateway package with built-in Perplexity tool routing needs verification against actual Vercel docs. Gemini may have hallucinated this API surface.

**Action:** Check the Vercel AI SDK docs and npm registry for `@ai-sdk/gateway` before building on this assumption.

### 7. Error isolation between MCP servers

If the second MCP server fails to connect, the first is already connected but may not clean up properly since the loop throws before adding the second transport to `activeTransports`. The loop also connects sequentially — should be parallel.

**Fix:** Use `Promise.allSettled` for parallel connection, or wrap each server connection in its own try/catch so partial failures don't orphan the successful connections.

## Architecture Decision: Standalone vs Embedded

The current `src/agent.ts` is a standalone HTTP server (port 2999). The Gemini suggestion moves the agent into the Electron main process using IPC. This is a significant architectural shift:

| Aspect | Standalone HTTP | Embedded in Electron |
|--------|----------------|---------------------|
| **Clients** | Any HTTP client (browser, Claude Code, curl) | Only the Electron mock runner UI |
| **Lifecycle** | Independent process, always available | Tied to mock runner app lifecycle |
| **Testing** | Easy to test via HTTP | Requires Electron test harness |
| **Deployment** | Can run headless on a server | Desktop-only |

**Recommendation:** Consider keeping the HTTP server option as well, or at minimum extracting the agent core (MCP setup, tool mapping, conversation management) into a shared module that both an HTTP server and Electron IPC handler can use.

## Dependencies (to verify)

| Package | Purpose | Verified? |
|---------|---------|-----------|
| `ai` | Vercel AI SDK core (`generateText`, `streamText`, `tool`, `jsonSchema`) | Yes — well-documented |
| `@ai-sdk/openai` | OpenAI provider | Yes |
| `@ai-sdk/anthropic` | Anthropic provider | Yes |
| `@ai-sdk/gateway` | Vercel AI Gateway with Perplexity search | **Needs verification** |
| `@modelcontextprotocol/sdk` | MCP client (already used) | Yes — already in package.json |

## Open Questions

1. Should the agent support both HTTP and Electron IPC, or go all-in on Electron?
2. Is `@ai-sdk/gateway` real, or do we need an alternative for web search (e.g., direct Perplexity API, or a custom MCP tool)?
3. How does conversation history interact with `maxSteps`? Does each step's tool result count as a message?
4. Should the system prompt be static (loaded once) or dynamic (refreshed when devices connect/disconnect, backups are extracted)?
5. How does the agent handle long-running MCP tools (e.g., stem separation from audio-analysis-mcp might take minutes)?
6. Token budget: the recreate-sound skill + keyboard inventory + sound design guidelines could be large. What's the context budget for the system prompt?
