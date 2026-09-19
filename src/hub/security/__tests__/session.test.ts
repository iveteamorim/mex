import { describe, expect, it } from "vitest";
import {
  HUB_SESSION_TTL_MS,
  HubSecurityError,
  HubSessionManager,
} from "../session.js";

const BOOTSTRAP = Buffer.alloc(32, 7).toString("base64url");
const ORIGIN = "http://127.0.0.1:48123";

describe("HubSessionManager", () => {
  it("exchanges a bootstrap token exactly once", () => {
    const manager = managerFixture();
    const session = manager.exchangeBootstrap(BOOTSTRAP);
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manager.authenticate(session.id)).toEqual(session);
    expect(() => manager.exchangeBootstrap(BOOTSTRAP)).toThrowError(HubSecurityError);
  });

  it("expires bootstrap and process-local sessions", () => {
    let now = Date.parse("2026-08-23T00:00:00.000Z");
    const expiredBootstrap = managerFixture({
      now: () => now,
      bootstrapExpiresAt: now,
    });
    expect(() => expiredBootstrap.exchangeBootstrap(BOOTSTRAP)).toThrowError(/expired/);

    const manager = managerFixture({ now: () => now });
    const session = manager.exchangeBootstrap(BOOTSTRAP);
    now += HUB_SESSION_TTL_MS;
    expect(() => manager.authenticate(session.id)).toThrowError(/expired/);
  });

  it("requires the exact loopback Host and rejects proxy headers", () => {
    const manager = managerFixture();
    expect(() => manager.assertHost(new Headers({ host: "localhost:48123" })))
      .toThrowError(/Host/);
    expect(() => manager.assertHost(new Headers({
      host: "127.0.0.1:48123",
      "x-forwarded-host": "attacker.example",
    }))).toThrowError(/proxy/i);
    expect(() => manager.assertHost(new Headers({ host: "127.0.0.1:48123" })))
      .not.toThrow();
  });

  it("requires exact Origin and constant-shape CSRF credentials", () => {
    const manager = managerFixture();
    const session = manager.exchangeBootstrap(BOOTSTRAP);
    expect(() => manager.assertOrigin(new Headers({ origin: "http://localhost:48123" })))
      .toThrowError(/originate/);
    expect(() => manager.assertCsrf(session, "wrong"))
      .toThrowError(/CSRF/);
    expect(() => manager.assertCsrf(session, session.csrfToken)).not.toThrow();
  });

  it("uses isolated safe cookie names for independent Hub processes", () => {
    const first = managerFixture({
      sessionCookieSuffix: Buffer.alloc(16, 1).toString("base64url"),
    });
    const second = managerFixture({
      sessionCookieSuffix: Buffer.alloc(16, 2).toString("base64url"),
    });

    expect(first.sessionCookieName).toMatch(/^mex_hub_session_[A-Za-z0-9_-]{22}$/);
    expect(second.sessionCookieName).toMatch(/^mex_hub_session_[A-Za-z0-9_-]{22}$/);
    expect(first.sessionCookieName).not.toBe(second.sessionCookieName);
  });

  it.each([
    "short",
    "a".repeat(21),
    "a".repeat(23),
    ";path=unsafe-cookie-name",
  ])("rejects an invalid session cookie suffix: %s", (sessionCookieSuffix) => {
    expect(() => managerFixture({ sessionCookieSuffix })).toThrowError(TypeError);
  });

  it("rejects a random source that cannot produce a 128-bit cookie suffix", () => {
    expect(() => managerFixture({
      random: () => new Uint8Array(15),
    })).toThrowError(/cookie suffix/i);
  });
});

function managerFixture(overrides: Partial<ConstructorParameters<typeof HubSessionManager>[0]> = {}) {
  let randomValue = 20;
  return new HubSessionManager({
    bootstrapToken: BOOTSTRAP,
    expectedOrigin: ORIGIN,
    now: () => Date.parse("2026-08-23T00:00:00.000Z"),
    random: (size) => new Uint8Array(size).fill(randomValue++),
    ...overrides,
  });
}
