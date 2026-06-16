import { BridgeRegistryError } from "../bridge-registry.js";
import { LeaseRegistryError } from "../lease-registry.js";
import { PortResolutionError } from "../port-resolver.js";

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

interface FormattedError {
  statusCode: number;
  body: { error: string; message: string; details?: unknown };
}

export function formatError(err: unknown): FormattedError {
  if (err instanceof HttpError) {
    return { statusCode: err.statusCode, body: { error: err.code, message: err.message, details: err.details } };
  }
  if (err instanceof PortResolutionError) {
    return { statusCode: 400, body: { error: err.code, message: err.message, details: err.details } };
  }
  if (err instanceof BridgeRegistryError || err instanceof LeaseRegistryError) {
    return { statusCode: 409, body: { error: err.code, message: err.message } };
  }
  const errorId = Math.random().toString(36).slice(2, 10);
  console.error(`[mcb] internal-error ${errorId}:`, err);
  return { statusCode: 500, body: { error: "internal-error", message: `Internal error (id ${errorId})` } };
}
