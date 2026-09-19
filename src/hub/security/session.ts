import { randomBytes, timingSafeEqual } from "node:crypto";
import type { HubProblemCode } from "@mex/hub-contracts";

export const HUB_SESSION_COOKIE_PREFIX = "mex_hub_session_";
export const HUB_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;
export const HUB_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

const HUB_SESSION_COOKIE_SUFFIX_BYTES = 16;

const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

export interface HubSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface HubSessionManagerOptions {
  readonly bootstrapToken: string;
  readonly expectedOrigin: string | (() => string | null);
  readonly bootstrapExpiresAt?: number;
  readonly sessionTtlMs?: number;
  /** Test seam; production generates a fresh per-process cookie-name suffix. */
  readonly sessionCookieSuffix?: string;
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
}

export class HubSecurityError extends Error {
  readonly status: number;
  readonly code: HubProblemCode;
  readonly title: string;

  constructor(status: number, code: HubProblemCode, title: string, detail: string) {
    super(detail);
    this.name = "HubSecurityError";
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

/**
 * Process-local bootstrap and session store. No token is persisted or exposed
 * through ordinary API resources.
 */
export class HubSessionManager {
  readonly sessionCookieName: string;
  readonly #bootstrapToken: string;
  readonly #bootstrapExpiresAt: number;
  readonly #expectedOrigin: string | (() => string | null);
  readonly #sessionTtlMs: number;
  readonly #now: () => number;
  readonly #random: (size: number) => Uint8Array;
  readonly #sessions = new Map<string, HubSession>();
  #bootstrapConsumed = false;

  constructor(options: HubSessionManagerOptions) {
    if (!isOpaqueSecret(options.bootstrapToken)) {
      throw new TypeError("The Hub bootstrap token must be a 256-bit base64url secret.");
    }
    const now = options.now ?? Date.now;
    const sessionTtlMs = options.sessionTtlMs ?? HUB_SESSION_TTL_MS;
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
      throw new TypeError("The Hub session lifetime must be a positive integer.");
    }

    this.#bootstrapToken = options.bootstrapToken;
    this.#expectedOrigin = options.expectedOrigin;
    this.#now = now;
    this.#bootstrapExpiresAt = options.bootstrapExpiresAt ?? now() + HUB_BOOTSTRAP_TTL_MS;
    this.#sessionTtlMs = sessionTtlMs;
    this.#random = options.random ?? randomBytes;

    const cookieSuffix = options.sessionCookieSuffix
      ?? encodeSecret(this.#random(HUB_SESSION_COOKIE_SUFFIX_BYTES));
    if (!isCanonicalCookieSuffix(cookieSuffix)) {
      throw new TypeError(
        "The Hub session cookie suffix must be a canonical 128-bit base64url value.",
      );
    }
    this.sessionCookieName = `${HUB_SESSION_COOKIE_PREFIX}${cookieSuffix}`;
  }

  expectedOrigin(): string {
    const value = typeof this.#expectedOrigin === "function"
      ? this.#expectedOrigin()
      : this.#expectedOrigin;
    if (value === null) {
      throw new HubSecurityError(
        503,
        "INTERNAL_ERROR",
        "Hub is not ready",
        "The local Hub listener has not finished binding.",
      );
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("The expected Hub origin is invalid.");
    }
    if (
      url.protocol !== "http:"
      || url.hostname !== "127.0.0.1"
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
    ) {
      throw new TypeError("The expected Hub origin must be an HTTP 127.0.0.1 origin.");
    }
    return url.origin;
  }

  assertHost(headers: Headers): void {
    for (const name of FORWARDED_HEADERS) {
      if (headers.has(name)) {
        throw new HubSecurityError(
          400,
          "INVALID_REQUEST",
          "Proxy headers rejected",
          "The local Hub does not accept forwarded or proxy request headers.",
        );
      }
    }

    const expectedHost = new URL(this.expectedOrigin()).host;
    const actualHost = headers.get("host");
    if (actualHost !== expectedHost) {
      throw new HubSecurityError(
        400,
        "INVALID_REQUEST",
        "Invalid Host header",
        "The request Host does not match the bound local Hub address.",
      );
    }
  }

  assertOrigin(headers: Headers): void {
    if (headers.get("origin") !== this.expectedOrigin()) {
      throw new HubSecurityError(
        403,
        "ORIGIN_REJECTED",
        "Origin rejected",
        "The mutation must originate from this local Hub instance.",
      );
    }
  }

  exchangeBootstrap(token: string): HubSession {
    const now = this.#now();
    if (
      this.#bootstrapConsumed
      || now >= this.#bootstrapExpiresAt
      || !equalSecret(token, this.#bootstrapToken)
    ) {
      throw unauthorized("The bootstrap token is invalid, expired, or already used.");
    }

    const session: HubSession = {
      id: encodeSecret(this.#random(32)),
      csrfToken: encodeSecret(this.#random(32)),
      expiresAt: new Date(now + this.#sessionTtlMs).toISOString(),
    };
    if (!isOpaqueSecret(session.id) || !isOpaqueSecret(session.csrfToken)) {
      throw new TypeError("The secure random source did not return 32-byte secrets.");
    }
    this.#bootstrapConsumed = true;
    this.#sessions.set(session.id, session);
    return session;
  }

  authenticate(sessionId: string | undefined): HubSession {
    if (sessionId === undefined || !isOpaqueSecret(sessionId)) {
      throw unauthorized("A valid local Hub session is required.");
    }
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw unauthorized("A valid local Hub session is required.");
    }
    if (this.#now() >= Date.parse(session.expiresAt)) {
      this.#sessions.delete(sessionId);
      throw unauthorized("The local Hub session has expired.");
    }
    return session;
  }

  assertCsrf(session: HubSession, suppliedToken: string | undefined): void {
    if (suppliedToken === undefined || !equalSecret(suppliedToken, session.csrfToken)) {
      throw new HubSecurityError(
        403,
        "ORIGIN_REJECTED",
        "CSRF token rejected",
        "The mutation requires the current local Hub CSRF token.",
      );
    }
  }

  remainingSessionSeconds(session: HubSession): number {
    return Math.max(1, Math.floor((Date.parse(session.expiresAt) - this.#now()) / 1_000));
  }
}

export function createBootstrapToken(): string {
  return encodeSecret(randomBytes(32));
}

function unauthorized(detail: string): HubSecurityError {
  return new HubSecurityError(401, "UNAUTHORIZED", "Authentication required", detail);
}

function isOpaqueSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isCanonicalCookieSuffix(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === HUB_SESSION_COOKIE_SUFFIX_BYTES
    && decoded.toString("base64url") === value;
}

function encodeSecret(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function equalSecret(left: string, right: string): boolean {
  const leftHash = Buffer.from(left);
  const rightHash = Buffer.from(right);
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash);
}
