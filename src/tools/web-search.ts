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
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          return {
            content: [{ type: "text" as const, text: `Search failed: HTTP ${resp.status}` }],
            isError: true,
          };
        }
        html = await resp.text();
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${(err as Error).message}` }],
          isError: true,
        };
      }

      // Parse DuckDuckGo HTML results
      const results: string[] = [];
      const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/g;
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
        const resultUrl = match[1].replace(/&amp;/g, "&");
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        if (title && resultUrl) {
          results.push(snippet ? `${title}\n${resultUrl}\n${snippet}` : `${title}\n${resultUrl}`);
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
