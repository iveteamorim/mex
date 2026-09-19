import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_CONNECTIONS = 64;
const FORCE_CLOSE_AFTER_MS = 2_000;

export interface StartHubNodeServerOptions {
  readonly app: Hono<any>;
  readonly port?: number;
}

export interface RunningHubNodeServer {
  readonly origin: string;
  readonly port: number;
  replaceApp(next: Hono<any>): void;
  close(): Promise<void>;
}

/** Start one bounded HTTP listener on IPv4 loopback only. */
export function startHubNodeServer(
  options: StartHubNodeServerOptions,
): Promise<RunningHubNodeServer> {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    return Promise.reject(new Error("Hub port must be 0 or an integer from 1 to 65535."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let app = options.app;
    const listener = getRequestListener((request) => app.fetch(request), {
      hostname: LOOPBACK_HOST,
      autoCleanupIncoming: true,
    });
    const server = createServer({
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 16 * 1024,
      requestTimeout: 30_000,
    }, (incoming, outgoing) => {
      if (!isSafeRawRequestTarget(incoming.url ?? "")) {
        rejectUnsafeRequestTarget(incoming, outgoing);
        return;
      }
      void listener(incoming, outgoing);
    });
    server.once("listening", () => {
      if (settled) return;
      settled = true;
      server.off("error", onStartupError);
      server.maxConnections = MAX_CONNECTIONS;
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        void closeServer(server).finally(() => {
          reject(new Error("Hub listener did not expose its bound address."));
        });
        return;
      }
      if (address.address !== LOOPBACK_HOST) {
        void closeServer(server).finally(() => {
          reject(new Error("Hub listener did not bind to the required loopback address."));
        });
        return;
      }
      resolve({
        origin: `http://${LOOPBACK_HOST}:${address.port}`,
        port: address.port,
        replaceApp(next) {
          app = next;
        },
        close: () => closeServer(server),
      });
    });

    const onStartupError = (error: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      const detail = error.code === "EADDRINUSE"
        ? `Hub port ${port} is already in use.`
        : "The local Project Hub listener could not start.";
      reject(new Error(detail, { cause: error }));
    };
    server.once("error", onStartupError);
    server.listen(port, LOOPBACK_HOST);
  });
}

/** Validate the exact native request target before WHATWG URL normalization. */
export function isSafeRawRequestTarget(target: string): boolean {
  if (target === "" || target.length > 16 * 1024 || !target.startsWith("/") || target.startsWith("//")) {
    return false;
  }
  const rawPath = target.split(/[?#]/, 1)[0] ?? "/";
  let candidate = rawPath;
  for (let depth = 0; depth < 3; depth += 1) {
    if (hasUnsafeRawPath(candidate)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) return !hasUnsafeRawPath(candidate);
    candidate = decoded;
  }
  return !hasUnsafeRawPath(candidate) && !/%[0-9a-f]{2}/i.test(candidate);
}

function hasUnsafeRawPath(path: string): boolean {
  if (
    path.includes("\\")
    || path.includes("\0")
    || /[\x00-\x1f\x7f]/.test(path)
    || /%(?:00|2f|5c)/i.test(path)
  ) {
    return true;
  }
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function rejectUnsafeRequestTarget(
  incoming: import("node:http").IncomingMessage,
  outgoing: import("node:http").ServerResponse,
): void {
  const requestId = randomUUID();
  const body = JSON.stringify({
    type: "about:blank",
    title: "Invalid request",
    status: 400,
    code: "INVALID_REQUEST",
    detail: "The requested Hub path contains unsafe path syntax.",
    instance: "/",
    requestId,
  });
  incoming.resume();
  outgoing.writeHead(400, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/problem+json; charset=UTF-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-request-id": requestId,
  });
  outgoing.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    const forceTimer = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, FORCE_CLOSE_AFTER_MS);
    forceTimer.unref?.();
    if ("closeIdleConnections" in server) server.closeIdleConnections();

    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    });
  });
}
