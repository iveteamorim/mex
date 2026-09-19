/**
 * A scaffold on disk, and the envelopes that act on it.
 *
 * The corpus here is **multi-entity with prose above, below and between**, and
 * that is not decoration. Trap 8 of the brief names the two ways this phase's
 * tests go vacuous, and both are shapes of the same mistake:
 *
 * - an "unrelated bytes preserved" assertion run against a single-entity file,
 *   where there are no unrelated bytes and the assertion is trivially true;
 * - a `create-entry` into a new or empty file, where the declared range is
 *   `[0, 0)` over an empty original, so the complement is empty and write-scope
 *   enforcement holds no matter what is produced.
 *
 * So every file below has at least two entities and prose on both sides of
 * them, {@link assertUntouched} names the bytes it expects to survive rather
 * than asserting a hash, and the creates that matter go into a populated file.
 */

import { expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import { checkOnlyRangesChanged } from "../../markdown/ranges.js";
import type { WikiEntity } from "../../model/entity.js";
import type { WikiActor } from "../../model/operation.js";

export const ARCH = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
export const GATEWAY = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
export const JWT = "mx_01D78XYFJ1PRM1WPBCBT3VHMNV";
export const PATTERN = "mx_01KR2E4K002H3ZYA9G0C4XV531";
export const TOPIC = "mx_01KRMEXM00JAAVJPQVVRX8N56V";

/** Prose that must survive every operation in this suite, verbatim. */
export const SENTINELS = [
  "The system is three services behind one gateway.",
  "A paragraph nobody's entity owns.",
  "Closing prose at the end of the file.",
] as const;

/**
 * A file-level entity, two block entities, and prose in every gap.
 *
 * The file-level entity matters: half the scaffold keeps its metadata in
 * frontmatter and half in a comment, and a metadata operation tested only
 * against one of them proves nothing about the other (brief §3.3).
 */
export const ARCH_MD = `---
name: architecture
description: How the services fit together
mex:
  id: ${ARCH}
  type: architecture
  status: promoted
  # keep this note; a whole-map rewrite would eat it
  revision: 1
last_updated: 2026-08-22
---

# System architecture

The system is three services behind one gateway.

<!-- mex:entity
id: ${GATEWAY}
type: component
status: promoted
revision: 1
-->
## Gateway

Terminates TLS and routes by path prefix.

A paragraph nobody's entity owns.

<!-- mex:entity
id: ${JWT}
type: decision
status: promoted
revision: 3
topics: [${TOPIC}]
-->
## Use JWT for sessions

Because server-side sessions do not scale across regions.

Closing prose at the end of the file.
`;

/** A second file, so a move has somewhere to go. */
export const PATTERNS_MD = `# Patterns

Prose above the only entity here.

<!-- mex:entity
id: ${PATTERN}
type: pattern
status: promoted
revision: 1
-->
## Return problem documents

Every handler returns a problem document.

Prose below it.
`;

/** A topic, so `topics:` references resolve. */
export const TOPICS_MD = `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
-->
## Authentication

Everything about tokens and sessions.
`;

export interface Scaffold {
  root: string;
  read: (path: string) => string;
  write: (path: string, text: string) => void;
  entity: (id: string, path?: string) => WikiEntity;
  /** Every Markdown file in the scaffold, by path. The "nothing moved" oracle. */
  files: () => Record<string, string>;
  dispose: () => void;
}

export const ACTOR: WikiActor = { kind: "agent", id: "p5-tests" };

/** A scaffold with the three files above, in a fresh temp directory. */
export function makeScaffold(files: Record<string, string> = {}): Scaffold {
  const root = mkdtempSync(join(tmpdir(), "mex-ops-"));
  const all: Record<string, string> = {
    "context/architecture.md": ARCH_MD,
    "patterns/problem-documents.md": PATTERNS_MD,
    "topics/authentication.md": TOPICS_MD,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }

  const read = (path: string): string => readFileSync(join(root, path), "utf-8");
  return {
    root,
    read,
    write: (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text, "utf-8");
    },
    entity: (id, path) => {
      for (const candidate of path === undefined ? Object.keys(all) : [path]) {
        const found = parseWikiMarkdown({ path: candidate, text: read(candidate) }).entities.find(
          (entry) => entry.entity.id === id,
        );
        if (found !== undefined) return found.entity;
      }
      throw new Error(`no entity ${id} in the scaffold`);
    },
    files: () => Object.fromEntries(Object.keys(all).map((path) => [path, read(path)])),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows keeps handles on just-closed SQLite files; see P4's note.
      }
    },
  };
}

let counter = 0;

/** An envelope carrying a live precondition for `entityId`. */
export function envelope(
  scaffold: Scaffold,
  type: string,
  payload: unknown,
  options: { entityId?: string; opId?: string; baseRevision?: number; baseContentHash?: string; reason?: string } = {},
): Record<string, unknown> {
  counter += 1;
  const base: Record<string, unknown> = {
    opId: options.opId ?? `op-${counter}`,
    type,
    actor: ACTOR,
    timestamp: "2026-08-24T10:00:00.000Z",
    payload,
  };
  if (options.reason !== undefined) base["reason"] = options.reason;
  if (options.entityId !== undefined) {
    base["entityId"] = options.entityId;
    const current = scaffold.entity(options.entityId);
    base["baseRevision"] = options.baseRevision ?? current.revision;
    base["baseContentHash"] = options.baseContentHash ?? current.location.entityContentHash;
  }
  return base;
}

/**
 * Assert that only the declared ranges of a file changed, and that the prose
 * outside them survived.
 *
 * The sentinel check is **scoped to the complement of the declared ranges**,
 * and finding out why was worth the test: a body runs from its heading to the
 * next entity's metadata, so `"A paragraph nobody's entity owns."` — which
 * reads like a gap between two entities — is in fact inside the Gateway
 * entity's body. An `update-entry` that replaces that body removes it, legally,
 * and a `move-entry` carries it to the other file. Asserting it survives
 * unconditionally would be asserting that those two operations do not work.
 *
 * So the sentinels say *the prose this operation did not claim is still there*,
 * in a message a human can act on, and `checkOnlyRangesChanged` says *no byte
 * outside the plan moved at all* — the second is the strict one, the first is
 * the legible one, and they fail differently.
 */
export function assertUntouched(
  before: string,
  after: string,
  declared: readonly { label: string; start: number; end: number }[],
): void {
  const inDeclared = (offset: number): boolean =>
    declared.some((range) => offset >= range.start && offset < Math.max(range.end, range.start + 1));

  for (const sentinel of SENTINELS) {
    const at = before.indexOf(sentinel);
    if (at < 0 || inDeclared(at)) continue;
    expect(after, `"${sentinel}" is outside every declared range and must survive`).toContain(sentinel);
  }

  const check = checkOnlyRangesChanged(before, after, [...declared]);
  expect(check.ok ? "" : check.message).toBe("");
}

/** Diagnostic codes, for a compact assertion. */
export function codesOf(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((entry) => entry.code);
}
