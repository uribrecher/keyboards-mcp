import { randomUUID } from "node:crypto";
import type { SessionManager } from "../session-manager.js";
import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { PortListReader, MockRegistryReader, Lease } from "../types.js";
import { resolvePort, PortResolutionError } from "../port-resolver.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

interface Deps {
  sessions: SessionManager;
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

export function makeDevicesHandlers(deps: Deps) {
  return {
    create: async (ctx: RouteContext) => {
      const sessionId = ctx.headers["x-session-id"];
      if (!sessionId) throw new HttpError(400, "invalid-input", "X-Session-Id header is required");
      const session = deps.sessions.get(sessionId);
      if (!session) throw new HttpError(404, "session-not-found", `Session ${sessionId} not found`);

      const body = (ctx.body ?? {}) as {
        port?: string; model?: string; with_shadow?: string; input_port?: string;
        channel?: number; lower_channel?: number; upper_channel?: number;
      };
      if (typeof body.port !== "string" || typeof body.model !== "string") {
        throw new HttpError(400, "invalid-input", "Body must include string `port` and `model`");
      }

      const primary = resolveOrHttp(() => resolvePort(body.port!, "output", deps.portList, deps.mockRegistry));

      const existingPrimary = deps.leases.isPrimary(primary.portName);
      if (existingPrimary) {
        const owner = deps.sessions.get(existingPrimary.sessionId);
        throw new HttpError(409, "port-already-owned", `Port ${primary.portName} is already owned`,
          { port: primary.portName, owner: { sessionId: existingPrimary.sessionId, pid: owner?.pid, processName: owner?.processName } });
      }
      if (deps.bridges.isShadowTarget(primary.portName)) {
        throw new HttpError(409, "port-is-shadow", `Port ${primary.portName} is currently a shadow target`);
      }

      let input: { portName: string } | undefined;
      if (typeof body.input_port === "string") {
        const ip = resolveOrHttp(() => resolvePort(body.input_port!, "input", deps.portList, deps.mockRegistry));
        input = { portName: ip.portName };
      } else {
        // Auto-resolve from a mock primary: mocks expose both directions
        // (device's MIDI In and MIDI Out) under the same OS port name (#21).
        // Real hardware uses different names for IN vs OUT, so the user
        // must pass `input_port` explicitly there. Run the resolved name
        // through resolvePort with kind="input" to validate that the
        // mock's input direction is actually visible to the OS — guards
        // against stale mock-registry entries.
        const mockEntry = deps.mockRegistry.findByMidiPort(primary.portName);
        if (mockEntry) {
          try {
            const ip = resolvePort(primary.portName, "input", deps.portList, deps.mockRegistry);
            input = { portName: ip.portName };
          } catch {
            // Stale registry entry or OS port list changed — silently skip
            // input wiring rather than failing the whole connect call.
            // The user can still pass input_port explicitly to force.
          }
        }
      }

      let shadow: { portName: string; wsPort: number | null } | undefined;
      if (typeof body.with_shadow === "string") {
        shadow = resolveOrHttp(() => resolvePort(body.with_shadow!, "output", deps.portList, deps.mockRegistry));
        if (shadow.portName === primary.portName) throw new HttpError(409, "self-shadow", "Master and shadow resolve to the same OS port");
        if (deps.leases.isPrimary(shadow.portName)) throw new HttpError(409, "shadow-target-is-primary", `Cannot shadow ${shadow.portName}: it is currently a primary`);
      }

      const deviceId = randomUUID();
      const lease: Lease = {
        deviceId, ownerSessionId: sessionId, model: body.model,
        primary, input, shadow,
        channel: body.channel ?? 1,
        lowerChannel: body.lower_channel,
        upperChannel: body.upper_channel,
        connectedAt: Date.now(),
      };

      deps.leases.add(lease);
      if (shadow) {
        try {
          deps.bridges.add(deviceId, primary.portName, shadow.portName);
        } catch (err) {
          deps.leases.remove(deviceId); // rollback
          throw err;
        }
      }
      session.ownedDeviceIds.add(deviceId);
      return { statusCode: 200, body: toManifest(lease) };
    },

    list: async () => ({ statusCode: 200, body: deps.leases.listAll().map(toManifest) }),

    delete: async (ctx: RouteContext) => {
      const lease = deps.leases.get(ctx.params.id);
      if (!lease) throw new HttpError(404, "device-not-found", `Device ${ctx.params.id} not found`);
      const sessionId = ctx.headers["x-session-id"];
      if (sessionId !== lease.ownerSessionId) throw new HttpError(403, "not-owner", "Only the owner session can release this lease");
      if (deps.bridges.shadowOf(lease.deviceId)) deps.bridges.remove(lease.deviceId);
      deps.leases.remove(lease.deviceId);
      deps.sessions.get(sessionId)?.ownedDeviceIds.delete(lease.deviceId);
      return { statusCode: 204 };
    },
  };
}

function toManifest(lease: Lease) {
  const { connectedAt: _c, ...rest } = lease;
  return rest;
}

function resolveOrHttp<T>(fn: () => T): T {
  try { return fn(); }
  catch (err) {
    if (err instanceof PortResolutionError) throw new HttpError(400, err.code, err.message, err.details);
    throw err;
  }
}
