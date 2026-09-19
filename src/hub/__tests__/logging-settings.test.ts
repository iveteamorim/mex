import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubApp } from "../app.js";
import { createLocalHubReadServices } from "../services.js";
import { HubSessionManager } from "../security/session.js";

const ORIGIN = "http://127.0.0.1:48123";
const HOST = "127.0.0.1:48123";
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const PATH = "/api/v1/settings/logging";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-logging-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  const unused = async (): Promise<never> => { throw new Error("Logging settings must not consult Team workflows."); };
  const app = createHubApp({ security: new HubSessionManager({ bootstrapToken: TOKEN, expectedOrigin: ORIGIN }),
    services: createLocalHubReadServices({ projectRoot: root, scaffoldId: "logging-fixture", jobs: { list: () => ({ items: [] }) },
      team: { getMember: unused, listMembers: unused, getCurrentActor: unused, getActivity: unused,
        listActivity: unused, previewIdentityActivity: unused, applyIdentityActivity: unused } }) });
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, { method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const session = await app.request(`${ORIGIN}/api/v1/session`, { headers: { host: HOST, cookie } });
  const { csrfToken } = await session.json() as { csrfToken: string };
  const get = (suffix = "") => app.request(`${ORIGIN}${PATH}${suffix}`, { headers: { host: HOST, cookie } });
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(`${ORIGIN}${PATH}`, { method: "POST",
    headers: { host: HOST, cookie, origin: ORIGIN, "content-type": "application/json", "x-mex-csrf": csrfToken, ...headers }, body: JSON.stringify(body) });
  return { root, app, get, post };
}

describe("Hub logging preferences", () => {
  it("reads an absent preference without initializing checkout-local state", async () => {
    const { root, get } = await fixture();
    const before = statSync(join(root, ".mex")).mtimeMs;
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "significant", source: "default", revision: null });
    expect(existsSync(join(root, ".mex/local"))).toBe(false);
    expect(statSync(join(root, ".mex")).mtimeMs).toBe(before);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("writes through the shared policy store and rejects stale browser edits", async () => {
    const { root, get, post } = await fixture();
    const changed = await post({ mode: "manual", expectedRevision: null });
    expect(changed.status).toBe(200);
    const policy = await changed.json() as { mode: string; revision: string; source: string };
    expect(policy).toMatchObject({ mode: "manual", source: "local" });
    expect(policy.revision).toMatch(/^[a-f0-9]{64}$/);
    const path = join(root, ".mex/local/agent-preferences.json");
    const bytes = readFileSync(path);
    expect((await post({ mode: "checkpoints", expectedRevision: null })).status).toBe(409);
    expect(readFileSync(path)).toEqual(bytes);
    expect(await (await get()).json()).toEqual(policy);
    expect((await post({ mode: "checkpoints", expectedRevision: policy.revision })).status).toBe(200);
  });

  it("requires authenticated origin and CSRF and rejects malformed or extra fields", async () => {
    const { root, app, get, post } = await fixture();
    const request = { mode: "manual", expectedRevision: null };
    expect((await app.request(`${ORIGIN}${PATH}`, { headers: { host: HOST } })).status).toBe(401);
    expect((await post(request, { origin: "https://outside.example" })).status).toBe(403);
    expect((await post(request, { "x-mex-csrf": "wrong" })).status).toBe(403);
    for (const body of [{ mode: "manual" }, { ...request, path: "/private" }, { ...request, mode: "every-tool" }, { ...request, expectedRevision: "wrong" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await get("?mode=manual")).status).toBe(400);
    expect(existsSync(join(root, ".mex/local"))).toBe(false);
  });
});
