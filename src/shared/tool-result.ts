/**
 * Return type for device tool methods.
 * Matches the MCP SDK content format so tools can pass through directly.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

/** Helper to create a text-only ToolResult */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
