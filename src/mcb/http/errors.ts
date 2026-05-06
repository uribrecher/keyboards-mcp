export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function formatError(err: unknown): { statusCode: number; body: { error: string; message: string; details?: unknown } } {
  if (err instanceof HttpError) {
    return { statusCode: err.statusCode, body: { error: err.code, message: err.message, details: err.details } };
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("port-not-found"))     return { statusCode: 400, body: { error: "port-not-found", message: msg, details: (err as { details?: unknown }).details } };
    if (msg.includes("ambiguous-port"))     return { statusCode: 400, body: { error: "ambiguous-port", message: msg, details: (err as { details?: unknown }).details } };
    if (msg.includes("port-already-owned")) return { statusCode: 409, body: { error: "port-already-owned", message: msg } };
    if (msg.includes("self-shadow"))        return { statusCode: 409, body: { error: "self-shadow", message: msg } };
    if (msg.includes("bridge-already-exists")) return { statusCode: 409, body: { error: "bridge-already-exists", message: msg } };
    if (msg.includes("shadow-conflict"))    return { statusCode: 409, body: { error: "shadow-conflict", message: msg } };
    if (msg.includes("cycle-would-form"))   return { statusCode: 409, body: { error: "cycle-would-form", message: msg } };
  }
  const errorId = Math.random().toString(36).slice(2, 10);
  console.error(`[mcb] internal-error ${errorId}:`, err);
  return { statusCode: 500, body: { error: "internal-error", message: `Internal error (id ${errorId})` } };
}
