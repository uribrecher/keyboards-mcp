/**
 * Pure state machine for the LOG-tab unread LED.
 *
 * Severity ranks (ascending): info < warn < error.
 *
 * The LED state never downgrades. When a new event arrives with a
 * higher severity than the current unread state, we upgrade. Equal or
 * lower severities are absorbed without changing the state.
 *
 * Selecting the LOG tab clears the state — that's just `null`,
 * applied by the caller; this module doesn't carry global state.
 */

const RANK = { info: 0, warn: 1, error: 2 };

/**
 * @param {"info" | "warn" | "error" | null} prev
 * @param {"info" | "warn" | "error"} incoming
 * @returns {"info" | "warn" | "error"}
 */
export function nextUnread(prev, incoming) {
  if (prev === null) return incoming;
  return RANK[incoming] > RANK[prev] ? incoming : prev;
}
