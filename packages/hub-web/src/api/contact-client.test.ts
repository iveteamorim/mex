import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHubApi } from "./client";

// Overview checks this preference on mount. Loading the setup workbench here
// would construct all its schemas during an ordinary Hub visit.
vi.mock("@mex/hub-contracts/setup", () => {
  throw new Error("Contact requests must not load setup contracts.");
});

const json = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

afterEach(() => vi.unstubAllGlobals());

describe("independent contact contracts", () => {
  it("reads the Overview preference without setup code or a mutation", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ status: "unasked" }));
    vi.stubGlobal("fetch", fetch);
    await expect(new HttpHubApi().getContactPreference()).resolves.toEqual({ status: "unasked" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("/api/v1/contact");
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });

  it("keeps contact writes authenticated without loading the setup workbench", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ csrfToken: "a".repeat(43), expiresAt: "2026-09-13T20:00:00.000Z" }))
      .mockResolvedValueOnce(json({ status: "skipped" }))
      .mockResolvedValueOnce(json({ ok: true, status: "submitted", message: "Thanks." }));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpHubApi();
    await api.getSession();
    await expect(api.rememberContactPreference({ status: "skipped" })).resolves.toEqual({ status: "skipped" });
    await expect(api.submitSetupContact({ email: "reader@example.com", name: "Reader" }))
      .resolves.toEqual({ ok: true, status: "submitted", message: "Thanks." });
    for (const [url, options] of fetch.mock.calls.slice(1)) {
      expect(url).toMatch(/^\/api\/v1\/contact(?:\/preference)?$/u);
      expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
      expect(new Headers(options.headers).get("X-MEX-CSRF")).toBe("a".repeat(43));
    }
  });

  it("still rejects an invalid preference response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ status: "submitted", email: "private@example.com" })));
    await expect(new HttpHubApi().getContactPreference()).rejects.toThrow();
  });
});
