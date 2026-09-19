import { describe, it, expect } from "vitest";
import {
  WIKI_SOURCE_TYPES,
  findDuplicateSources,
  isWikiSourceType,
  reportUnresolvedSources,
  sourceIdentity,
  validateSource,
  type WikiSource,
  type WikiSourceType,
} from "../source.js";
import { rootContext } from "../validate.js";

function check(source: unknown): { ok: boolean; codes: string[] } {
  const result = validateSource(source, rootContext());
  return { ok: result.ok, codes: result.diagnostics.map((entry) => entry.code) };
}

/** One valid example of every source kind, so the vocabulary is covered by construction. */
const VALID: Record<WikiSourceType, WikiSource> = {
  file: { type: "file", ref: "src/auth/tokens.ts" },
  symbol: { type: "symbol", ref: "function:a3f8c21d9e4b7f60" },
  commit: { type: "commit", ref: "8f21a3c" },
  pull_request: { type: "pull_request", ref: "#132" },
  issue: { type: "issue", ref: "#87" },
  document: { type: "document", ref: "docs/rfc-004.md" },
  manual: { type: "manual", note: "Agreed in the 2026-08 architecture review." },
  agent_session: { type: "agent_session", ref: "session_01Jo6Wr2CMDPtLn3" },
  test: { type: "test", ref: "test/auth.test.ts:rotates refresh tokens" },
  url: { type: "url", ref: "https://example.com/rfc" },
};

describe("source vocabulary", () => {
  it("has the ten required kinds", () => {
    expect([...WIKI_SOURCE_TYPES].sort()).toEqual(
      ["agent_session", "commit", "document", "file", "issue", "manual", "pull_request", "symbol", "test", "url"].sort(),
    );
  });

  it("recognizes only those kinds", () => {
    expect(isWikiSourceType("commit")).toBe(true);
    expect(isWikiSourceType("grounding")).toBe(false);
  });

  it("accepts a valid example of every kind", () => {
    for (const type of WIKI_SOURCE_TYPES) {
      expect(check(VALID[type]), `${type} should be valid`).toMatchObject({ ok: true });
    }
  });

  it("rejects every kind when its required evidence is missing", () => {
    // The point of per-kind validation: one generic "ref is a string" rule
    // would wave all of these through.
    for (const type of WIKI_SOURCE_TYPES) {
      expect(check({ type }).ok, `${type} with no evidence should be rejected`).toBe(false);
    }
  });

  it("rejects an unknown kind", () => {
    expect(check({ type: "tweet", ref: "x" })).toMatchObject({ ok: false });
    expect(check({ type: "tweet", ref: "x" }).codes).toContain("MALFORMED_SOURCE");
  });

  it.each(["/etc/passwd", "../outside.md", "src\\secret.ts", "src/../secret.ts", "src/\0secret.ts"])(
    "rejects unsafe canonical file source path %j",
    (ref) => {
      const result = check({ type: "file", ref });
      expect(result.ok).toBe(false);
      expect(result.codes).toContain("MALFORMED_SOURCE");
    },
  );
});

describe("commit sources", () => {
  it("accepts an abbreviated or full SHA, in either field", () => {
    expect(check({ type: "commit", ref: "8f21a3c" }).ok).toBe(true);
    expect(check({ type: "commit", commit: "48da30c" }).ok).toBe(true);
    expect(check({ type: "commit", ref: "48da30c1f2e3a4b5c6d7e8f90a1b2c3d4e5f6071" }).ok).toBe(true);
  });

  it("rejects a SHA that is not hexadecimal", () => {
    const result = check({ type: "commit", ref: "yesterday" });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("INVALID_COMMIT_FORMAT");
  });

  it("rejects a SHA shorter than Git's default abbreviation", () => {
    expect(check({ type: "commit", ref: "8f21" }).codes).toContain("INVALID_COMMIT_FORMAT");
  });

  it("checks a commit field attached to another kind too", () => {
    expect(check({ type: "file", ref: "src/a.ts", commit: "nope!" }).codes).toContain("INVALID_COMMIT_FORMAT");
    expect(check({ type: "file", ref: "src/a.ts", commit: "8f21a3c" }).ok).toBe(true);
  });
});

describe("manual sources", () => {
  it("requires a note, because the note is the evidence", () => {
    expect(check({ type: "manual" }).ok).toBe(false);
    expect(check({ type: "manual", note: "   " }).ok).toBe(false);
    expect(check({ type: "manual", note: "Agreed in review." }).ok).toBe(true);
  });

  it("does not accept a ref as a substitute for the note", () => {
    expect(check({ type: "manual", ref: "somewhere" }).ok).toBe(false);
  });
});

describe("url sources", () => {
  it("requires a parseable URL", () => {
    expect(check({ type: "url", ref: "https://example.com/a?b=c" }).ok).toBe(true);
    expect(check({ type: "url", ref: "not a url" }).ok).toBe(false);
  });

  it("parses without fetching", async () => {
    // Validation is offline by contract: it must not leak that a project cites
    // a URL, and `mex wiki validate` must work on a plane. Assert no network
    // call is even attempted.
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("validation must never fetch a URL");
    }) as typeof fetch;
    try {
      expect(check({ type: "url", ref: "https://example.com/rfc" }).ok).toBe(true);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("symbol sources", () => {
  it("requires a non-empty graph reference", () => {
    expect(check({ type: "symbol", ref: "" }).ok).toBe(false);
    expect(check({ type: "symbol", ref: "function:a3f8c21d" }).ok).toBe(true);
  });
});

describe("capturedAt", () => {
  it("accepts an ISO 8601 timestamp and rejects prose", () => {
    expect(check({ ...VALID.file, capturedAt: "2026-08-22T10:00:00Z" }).ok).toBe(true);
    expect(check({ ...VALID.file, capturedAt: "last Tuesday" }).ok).toBe(false);
  });
});

describe("reportUnresolvedSources", () => {
  it("reports unresolved external evidence at info severity", () => {
    const diagnostics = reportUnresolvedSources([VALID.url, VALID.issue, VALID.file]);
    expect(diagnostics.map((entry) => entry.code)).toEqual([
      "UNRESOLVED_EXTERNAL_SOURCE",
      "UNRESOLVED_EXTERNAL_SOURCE",
    ]);
    // Legal but explicit — it never blocks, it just must not read as verified.
    expect(diagnostics.every((entry) => entry.severity === "info")).toBe(true);
  });

  it("stays quiet once the caller can resolve them", () => {
    expect(reportUnresolvedSources([VALID.url], () => true)).toEqual([]);
  });

  it("does not treat repository-local evidence as external", () => {
    expect(reportUnresolvedSources([VALID.file, VALID.commit, VALID.manual])).toEqual([]);
  });
});

describe("sourceIdentity", () => {
  it("ignores commentary that is not identity", () => {
    expect(sourceIdentity({ type: "file", ref: "src/a.ts", note: "first" })).toBe(
      sourceIdentity({ type: "file", ref: "src/a.ts", note: "second", capturedAt: "2026-08-22T10:00:00Z" }),
    );
  });

  it("treats an abbreviated and a full SHA of one commit as the same evidence", () => {
    expect(sourceIdentity({ type: "commit", ref: "8f21a3c" })).toBe(
      sourceIdentity({ type: "commit", commit: "8f21a3c1f2e3a4b5c6d7e8f90a1b2c3d4e5f6071" }),
    );
  });

  it("normalizes URL host case but not path case", () => {
    expect(sourceIdentity({ type: "url", ref: "https://Example.COM/rfc" })).toBe(
      sourceIdentity({ type: "url", ref: "https://example.com/rfc" }),
    );
    expect(sourceIdentity({ type: "url", ref: "https://example.com/RFC" })).not.toBe(
      sourceIdentity({ type: "url", ref: "https://example.com/rfc" }),
    );
  });

  it("uses the note as identity for manual evidence, which has no referent", () => {
    expect(sourceIdentity({ type: "manual", note: "Agreed in review." })).toBe(
      sourceIdentity({ type: "manual", note: "  agreed in review.  " }),
    );
    expect(sourceIdentity({ type: "manual", note: "A" })).not.toBe(sourceIdentity({ type: "manual", note: "B" }));
  });

  it("separates different kinds pointing at the same string", () => {
    expect(sourceIdentity({ type: "file", ref: "x" })).not.toBe(sourceIdentity({ type: "document", ref: "x" }));
  });
});

describe("findDuplicateSources", () => {
  it("reports a repeated entry once per repeat", () => {
    const diagnostics = findDuplicateSources([VALID.file, { ...VALID.file, note: "again" }, VALID.commit]);
    expect(diagnostics.map((entry) => entry.code)).toEqual(["DUPLICATE_SOURCE"]);
    expect(diagnostics[0]!.path).toBe("sources[1]");
    expect(diagnostics[0]!.severity).toBe("warning");
  });

  it("accepts genuinely distinct evidence", () => {
    expect(findDuplicateSources([VALID.file, VALID.commit, VALID.manual, VALID.url])).toEqual([]);
  });
});
