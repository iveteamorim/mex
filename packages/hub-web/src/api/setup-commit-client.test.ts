import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHubApi } from "./client";
import type { SetupCommitDiff, SetupCommitPreview, SetupCommitResponse } from "./types";

const revision = "a944e8d9-7e02-4d04-9a62-d8b347b8e7dc";
const session = { csrfToken: "a".repeat(43), expiresAt: "2099-09-10T10:00:00.000Z" };
const preview: SetupCommitPreview = {
  revision, expiresAt: "2099-09-10T10:00:00.000Z", branch: "main", head: null,
  defaultMessage: "chore: initialize MEX", canCommit: true, blockedReason: null,
  files: [{ path: ".mex/config.json", status: "added", additions: 1, deletions: 0, diffCharacters: 17, truncated: false }],
};
const fileDiff: SetupCommitDiff = { revision, path: ".mex/config.json", diff: "+project identity", truncated: false };
const response: SetupCommitResponse = {
  commit: "a".repeat(40), files: [".mex/config.json"], message: "Setup committed locally.",
  run: {
    status: "running", mode: "code-repo", stage: "ready", populated: true, ready: false,
    selectedTools: [], prompt: null, populationTool: null, populationCompleted: true,
    commitCommands: [], anchorNotes: [], message: "Opening the Hub…", progress: null,
    error: null, startedAt: "2026-09-10T10:00:00.000Z", finishedAt: null,
  },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("setup commit transport", () => {
  it("protects every explicit POST with CSRF and sends only the reviewed revision, path and commit message", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json(fileDiff)).mockResolvedValueOnce(json(response));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpHubApi();
    await api.getSession();
    expect(await api.previewSetupCommit()).toEqual(preview);
    const diffRequest = { revision, path: ".mex/config.json" };
    expect(await api.setupCommitDiff(diffRequest)).toEqual(fileDiff);
    const request = { revision, message: "chore: initialize MEX" };
    expect(await api.commitSetup(request)).toEqual(response);
    const previewCall = fetch.mock.calls[1] as [string, RequestInit];
    const diffCall = fetch.mock.calls[2] as [string, RequestInit];
    const commitCall = fetch.mock.calls[3] as [string, RequestInit];
    expect(previewCall[0]).toBe("/api/v1/setup/commit/preview");
    expect(previewCall[1].body).toBe("{}");
    expect(diffCall[0]).toBe("/api/v1/setup/commit/diff");
    expect(diffCall[1].body).toBe(JSON.stringify(diffRequest));
    expect(commitCall[0]).toBe("/api/v1/setup/commit");
    expect(commitCall[1].body).toBe(JSON.stringify(request));
    for (const call of [previewCall, diffCall, commitCall]) {
      expect(call[1].method).toBe("POST");
      expect(call[1].credentials).toBe("same-origin");
      expect((call[1].headers as Headers).get("X-MEX-CSRF")).toBe(session.csrfToken);
      expect((call[1].headers as Headers).get("Content-Type")).toBe("application/json");
    }
  });

  it("rejects malformed review/commit responses at the shared contract boundary", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ ...preview, files: [{ ...preview.files[0], path: "../private" }] }))
      .mockResolvedValueOnce(json({ ...fileDiff, path: "../private" }))
      .mockResolvedValueOnce(json({ ...response, commit: "not-a-git-object" }));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpHubApi();
    await api.getSession();
    await expect(api.previewSetupCommit()).rejects.toMatchObject({ problem: { code: "INTERNAL_ERROR" } });
    await expect(api.setupCommitDiff({ revision, path: ".mex/config.json" })).rejects.toMatchObject({ problem: { code: "INTERNAL_ERROR" } });
    await expect(api.commitSetup({ revision, message: "Review setup" })).rejects.toMatchObject({ problem: { code: "INTERNAL_ERROR" } });
  });

  it("preserves a stale-review problem for the UI and does not retry the commit", async () => {
    const problem = { type: "about:blank", title: "Review changed", status: 409, code: "REVISION_CONFLICT", detail: "Setup files changed after review.", requestId: revision };
    const fetch = vi.fn().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(problem, 409));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpHubApi();
    await api.getSession();
    await expect(api.commitSetup({ revision, message: "Review setup" })).rejects.toMatchObject({ problem });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
