import {
  lstatSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { resolve } from "node:path";
import { artifactError } from "../artifacts/errors.js";

interface RootIdentity {
  device: bigint;
  inode: bigint;
  birthtime: bigint;
}

/**
 * Bind a workflow service to one physical checkout for its whole lifetime.
 * Both the caller-visible lexical path and the canonical directory identity
 * are revalidated before every publication/recovery phase.
 */
export class RepositoryRootGuard {
  readonly path: string;
  readonly #requestedPath: string;
  readonly #identity: RootIdentity;

  constructor(projectRoot: string) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw invalidRoot();
    }
    this.#requestedPath = resolve(projectRoot);
    try {
      this.path = realpathSync(this.#requestedPath);
      const stat = statSync(this.path, { bigint: true });
      if (!stat.isDirectory()) throw new Error("not a directory");
      this.#identity = identityOf(stat);
    } catch {
      throw invalidRoot();
    }
  }

  assertCurrent(): void {
    try {
      if (realpathSync(this.#requestedPath) !== this.path) throw new Error("retargeted");
      const lexical = lstatSync(this.path, { bigint: true });
      if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error("unsafe root");
      const current = statSync(this.path, { bigint: true });
      if (!current.isDirectory() || !sameIdentity(this.#identity, identityOf(current))) {
        throw new Error("replaced");
      }
    } catch {
      throw artifactError(
        "REVISION_CONFLICT",
        "Repository identity changed",
        "The repository root changed after this workflow service was created. Reopen the repository and preview again.",
      );
    }
  }
}

function identityOf(stat: BigIntStats): RootIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    birthtime: stat.birthtimeNs,
  };
}

function sameIdentity(left: RootIdentity, right: RootIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.birthtime === right.birthtime;
}

function invalidRoot() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid repository root",
    "The Team workflow service requires an existing repository directory.",
  );
}
