export type EventSeverity = "info" | "warn" | "error";

export function nextUnread(
  prev: EventSeverity | null,
  incoming: EventSeverity,
): EventSeverity;
