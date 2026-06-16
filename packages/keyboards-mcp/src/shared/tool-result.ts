/**
 * Return type for device tool methods.
 * Matches the MCP SDK content format so tools can pass through directly.
 *
 * `warnings` is a structured field carrying validation notices that are also
 * appended to the response text (for backward-compatible LLM consumption).
 * Downstream UIs / agents can color, count, or suppress them independently
 * of the body text.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  warnings?: string[];
}

/** Helper to create a text-only ToolResult */
export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
