/**
 * Scratch scaffolds for the index tests.
 *
 * Every test here builds a real scaffold on disk and a real SQLite database:
 * the properties under test — atomic publish, WAL handling, a deterministic
 * walk — are properties of the filesystem, and a mocked one would assert
 * nothing about them.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Scaffold {
  /** Absolute scaffold root. */
  root: string;
  /** Write a file, creating directories. Path is scaffold-relative POSIX. */
  write(path: string, text: string): void;
  /** Delete a file. Path is scaffold-relative POSIX. */
  remove(path: string): void;
  /** Copy a directory from the repo into the scaffold. */
  copyFrom(absoluteSource: string, targetPath?: string): void;
  dispose(): void;
}

export function createScaffold(): Scaffold {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-index-"));
  return {
    root,
    write(path, text) {
      const absolute = resolve(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, "utf-8");
    },
    remove(path) {
      rmSync(resolve(root, path), { force: true });
    },
    copyFrom(absoluteSource, targetPath = ".") {
      const absolute = resolve(root, targetPath);
      mkdirSync(absolute, { recursive: true });
      cpSync(absoluteSource, absolute, { recursive: true });
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The committed fixture corpus, as an absolute path. */
export function fixtureRoot(...segments: string[]): string {
  return resolve(__dirname, "..", "..", "..", "..", "test", "fixtures", "wiki", ...segments);
}

/** A clock that advances a fixed step per call, so two runs never coincide. */
export function steppingClock(startMs = Date.UTC(2026, 0, 1)): () => string {
  let current = startMs;
  return () => {
    current += 1000;
    return new Date(current).toISOString();
  };
}
