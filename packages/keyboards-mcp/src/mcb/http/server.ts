import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { PortListReader, MockRegistryReader } from "../types.js";
import { formatError } from "./errors.js";
import { makeHealthHandler } from "./health.js";
import { makeSessionsHandlers } from "./sessions.js";
import { makeDevicesHandlers } from "./devices.js";
import { makeMidiPortsHandler } from "./midi-ports.js";
import { makeMocksHandlers } from "./mocks.js";

export type ListenTarget =
  | { kind: "uds"; socketPath: string }
  | { kind: "tcp"; host: string; port: number };

export interface ServerDeps {
  listen: ListenTarget;
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  sessions: SessionManager;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

export interface StartedServer { listen: ListenTarget; stop(): Promise<void>; }

export interface RouteContext {
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string | undefined>;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<{ statusCode: number; body?: unknown }>;
}

export async function startServer(deps: ServerDeps): Promise<StartedServer> {
  const startedAtMs = Date.now();
  if (deps.listen.kind === "uds") {
    const dir = dirname(deps.listen.socketPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const routes: Route[] = [
    { method: "GET", pattern: /^\/v1\/health$/, handler: makeHealthHandler({ leases: deps.leases, sessions: deps.sessions, startedAtMs }) },
  ];
  registerRoutes(routes, deps);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://mcb.local");
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) { respond(res, 404, { error: "not-found", message: `No route for ${req.method} ${url.pathname}` }); return; }
      const m = route.pattern.exec(url.pathname)!;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) params[k] = v;
      let body: unknown;
      if (req.method !== "GET") {
        const buf = await readBody(req);
        if (buf.length > 0) {
          try { body = JSON.parse(buf.toString()); }
          catch { respond(res, 400, { error: "invalid-input", message: "Body must be valid JSON" }); return; }
        }
      }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      const result = await route.handler({ params, body, headers });
      respond(res, result.statusCode, result.body);
    } catch (err) {
      const f = formatError(err);
      respond(res, f.statusCode, f.body);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (deps.listen.kind === "uds") {
      const sock = deps.listen.socketPath;
      server.listen(sock, () => {
        try { chmodSync(sock, 0o600); } catch { /* macOS sometimes refuses */ }
        resolve();
      });
    } else {
      // TCP listen mode — used by the docker-compose CI topology where MCB
      // runs in its own container and reachability is over the bridge network.
      // No filesystem permissions to apply; operators are expected to bind on
      // a private network only.
      server.listen(deps.listen.port, deps.listen.host, () => resolve());
    }
  });

  return {
    listen: deps.listen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function respond(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function registerRoutes(routes: Route[], deps: ServerDeps): void {
  const sess = makeSessionsHandlers({ sessions: deps.sessions });
  const dev = makeDevicesHandlers({
    sessions: deps.sessions, leases: deps.leases, bridges: deps.bridges,
    portList: deps.portList, mockRegistry: deps.mockRegistry,
  });
  const midiPorts = makeMidiPortsHandler({
    leases: deps.leases, portList: deps.portList, mockRegistry: deps.mockRegistry,
  });
  const mocks = makeMocksHandlers({ leases: deps.leases, bridges: deps.bridges, sessions: deps.sessions });
  routes.push(
    { method: "POST",   pattern: /^\/v1\/sessions$/,                                handler: sess.create },
    { method: "POST",   pattern: /^\/v1\/devices$/,                                 handler: dev.create },
    { method: "GET",    pattern: /^\/v1\/devices$/,                                 handler: dev.list },
    { method: "DELETE", pattern: /^\/v1\/devices\/(?<id>[a-f0-9-]+)$/,               handler: dev.delete },
    { method: "GET",    pattern: /^\/v1\/midi\/ports$/,                             handler: midiPorts },
    { method: "DELETE", pattern: /^\/v1\/mocks\/(?<instanceId>[a-f0-9-]+)$/,         handler: mocks.delete },
  );
}
