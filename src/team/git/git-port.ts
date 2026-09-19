import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  ChangedFile,
  GitChangedFilesRequest,
  GitCommit,
  GitDiffRequest,
  GitDiffResult,
  GitFileAtRevisionRequest,
  GitFileAtRevisionResult,
  GitFileStatus,
  GitHistoryRequest,
  GitIdentity,
  GitPage,
  GitPort,
  GitWorkingTreeEntry,
} from "../contracts/git.js";
import { GIT_READ_LIMITS } from "../contracts/git.js";
import type { PageRequest, RepoState } from "../contracts/shared.js";
import {
  isRepoRelativePath,
  MexPortError,
} from "../contracts/shared.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STRUCTURED_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_REF_LENGTH = 1_024;
const MAX_BRANCH_BYTES = 1_024;
const MAX_PATH_BYTES = 4_096;
const MAX_PATHS_PER_REQUEST = 4_096;
const UTF8_LOOKAHEAD_BYTES = 4;
const MAX_GIT_CONTROL_FILE_BYTES = 64 * 1024;

const REDIRECTING_GIT_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_QUARANTINE_PATH",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_SHALLOW",
  "GIT_TRACE_CURL",
] as const;

interface GitCommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
  readonly truncated: boolean;
}

interface GitCommandOptions {
  readonly operation: string;
  readonly maxStdoutBytes?: number;
  readonly acceptedExitCodes?: readonly number[];
}

interface StatusSnapshot {
  readonly branch: string | null;
  readonly head: string | null;
  readonly entries: readonly GitWorkingTreeEntry[];
  readonly fingerprint: string;
}

interface WorkingTreeCursor {
  readonly version: 1;
  readonly kind: "working-tree";
  readonly offset: number;
  readonly fingerprint: string;
}

interface HistoryCursor {
  readonly version: 1;
  readonly kind: "history";
  readonly offset: number;
  readonly anchor: string;
  readonly scope: string;
}

interface ChangedFilesCursor {
  readonly version: 1;
  readonly kind: "changed-files";
  readonly offset: number;
  readonly base: string;
  readonly head: string;
}

type GitCursor = WorkingTreeCursor | HistoryCursor | ChangedFilesCursor;

interface RepositoryGitPortOptions {
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

interface NodeIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtimeNs: bigint;
  readonly kind: "directory" | "file";
  readonly contentHash?: string;
}

interface RepositoryIdentity {
  readonly controlEntry: NodeIdentity;
  readonly gitDirectoryPath: string;
  readonly gitDirectory: NodeIdentity;
  readonly commonDirectoryPath: string;
  readonly commonDirectory: NodeIdentity;
}

/**
 * Create a repository-scoped, read-only implementation of the team GitPort.
 *
 * This adapter intentionally has no generic command method. Every Git argv is
 * assembled below from a fixed read-only command plus validated data values.
 */
export function createRepositoryGitPort(
  projectRoot: string,
  options: RepositoryGitPortOptions = {},
): GitPort {
  return new ReadOnlyRepositoryGitPort(projectRoot, options);
}

class ReadOnlyRepositoryGitPort implements GitPort {
  readonly #projectRoot: string;
  readonly #projectRootIdentity: NodeIdentity;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  #repositoryCheck: Promise<RepositoryIdentity> | null = null;
  #repositoryIdentity: RepositoryIdentity | null = null;

  constructor(projectRoot: string, options: RepositoryGitPortOptions) {
    if (!projectRoot) {
      throw invalidRequest("A project root is required.");
    }

    let canonicalRoot: string;
    let rootIdentity: NodeIdentity;
    try {
      canonicalRoot = realpathSync(resolve(projectRoot));
      const rootStats = statSync(canonicalRoot, { bigint: true });
      if (!rootStats.isDirectory()) {
        throw new Error("not a directory");
      }
      rootIdentity = nodeIdentity(rootStats, "directory");
    } catch {
      throw invalidRequest("The project root must be an existing directory.");
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw invalidRequest("The Git timeout must be a positive integer.");
    }

    this.#projectRoot = canonicalRoot;
    this.#projectRootIdentity = rootIdentity;
    this.#timeoutMs = timeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  async getRepoState(): Promise<RepoState> {
    await this.#ensureRepository();
    const snapshot = await this.#readStatus();
    return {
      branch: snapshot.branch,
      head: snapshot.head,
      dirty: snapshot.entries.length > 0,
      observedAt: this.#now().toISOString(),
    };
  }

  async getIdentity(): Promise<GitIdentity> {
    await this.#ensureRepository();
    const result = await this.#runGit(
      ["config", "--null", "--get-regexp", "^user\\.(name|email)$"],
      {
        operation: "read Git identity",
        maxStdoutBytes: 128 * 1024,
        acceptedExitCodes: [0, 1],
      },
    );
    if (result.exitCode === 1) return { name: null, email: null };
    if (result.truncated) {
      throw internalFailure("Git identity configuration exceeded the safe output limit.");
    }

    let name: string | null = null;
    let email: string | null = null;
    for (const entry of splitNul(result.stdout)) {
      const separator = entry.indexOf("\n");
      if (separator <= 0) throw malformedGitOutput("identity configuration");
      const key = entry.slice(0, separator).toLowerCase();
      const value = entry.slice(separator + 1);
      if (key === "user.name") name = value;
      if (key === "user.email") email = value;
    }
    return { name, email };
  }

  async getWorkingTree(
    page: PageRequest = {},
  ): Promise<GitPage<GitWorkingTreeEntry>> {
    await this.#ensureRepository();
    const { limit, cursor } = normalizePageRequest(page);
    const snapshot = await this.#readStatus();
    let offset = 0;

    if (cursor !== undefined) {
      const parsed = decodeCursor(cursor, "working-tree");
      if (parsed.fingerprint !== snapshot.fingerprint) {
        throw invalidRequest(
          "The working tree changed while it was being paginated. Start again without a cursor.",
        );
      }
      offset = parsed.offset;
    }

    assertOffset(offset, snapshot.entries.length);
    const items = snapshot.entries.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor =
      nextOffset < snapshot.entries.length
        ? encodeCursor({
            version: 1,
            kind: "working-tree",
            offset: nextOffset,
            fingerprint: snapshot.fingerprint,
          })
        : null;

    return { items, nextCursor, truncated: nextCursor !== null };
  }

  async resolveRevision(ref: string): Promise<string> {
    await this.#ensureRepository();
    const revision = await this.#tryResolveRevision(ref);
    if (revision === null) {
      throw notFound(`Git revision ${JSON.stringify(ref)} does not name a commit.`);
    }
    return revision;
  }

  async getDiff(request: GitDiffRequest): Promise<GitDiffResult> {
    await this.#ensureRepository();
    assertDiffRequest(request);
    const target =
      request.target.kind === "range"
        ? { kind: "range" as const, base: request.target.base, head: request.target.head }
        : {
            kind: "working-tree" as const,
            includeStaged: request.target.includeStaged,
            includeUnstaged: request.target.includeUnstaged,
          };
    const maxBytes = normalizeByteLimit(
      request.maxBytes,
      GIT_READ_LIMITS.maxDiffBytes,
      "diff",
    );
    const paths = normalizePaths(request.paths);
    let output: Buffer;
    let commandTruncated = false;

    if (target.kind === "range") {
      const [base, head] = await this.#resolveRevisionPair(
        target.base,
        target.head,
      );
      const result = await this.#runDiff(
        [base, head],
        paths,
        maxBytes + UTF8_LOOKAHEAD_BYTES,
      );
      output = result.stdout;
      commandTruncated = result.truncated;
    } else if (
      !target.includeStaged &&
      !target.includeUnstaged
    ) {
      output = Buffer.alloc(0);
    } else if (
      target.includeStaged &&
      target.includeUnstaged
    ) {
      const head = await this.#tryResolveRevision("HEAD");
      if (head !== null) {
        const result = await this.#runDiff(
          [head],
          paths,
          maxBytes + UTF8_LOOKAHEAD_BYTES,
        );
        output = result.stdout;
        commandTruncated = result.truncated;
      } else {
        const staged = await this.#runDiff(
          ["--cached"],
          paths,
          maxBytes + UTF8_LOOKAHEAD_BYTES,
        );
        const remaining = Math.max(
          0,
          maxBytes + UTF8_LOOKAHEAD_BYTES - staged.stdout.byteLength,
        );
        const unstaged = await this.#runDiff([], paths, remaining);
        output = Buffer.concat([staged.stdout, unstaged.stdout]);
        commandTruncated = staged.truncated || unstaged.truncated;
      }
    } else {
      const leadingArguments = target.includeStaged
        ? await this.#stagedDiffArguments()
        : [];
      const result = await this.#runDiff(
        leadingArguments,
        paths,
        maxBytes + UTF8_LOOKAHEAD_BYTES,
      );
      output = result.stdout;
      commandTruncated = result.truncated;
    }

    const rendered = utf8Prefix(output, maxBytes);
    return {
      target,
      diff: rendered.text,
      bytes: rendered.bytes,
      truncated: commandTruncated || rendered.truncated,
    };
  }

  async getHistory(
    request: GitHistoryRequest = {},
  ): Promise<GitPage<GitCommit>> {
    await this.#ensureRepository();
    if (typeof request !== "object" || request === null) {
      throw invalidRequest("A history request must be an object.");
    }
    const { limit, cursor } = normalizePageRequest(request);
    const paths = normalizePaths(request.paths);
    const scope = hashScope({ from: request.from ?? null, paths });
    let offset = 0;
    let anchor: string | null;

    if (cursor !== undefined) {
      const parsed = decodeCursor(cursor, "history");
      if (parsed.scope !== scope) {
        throw invalidRequest("The history cursor does not match this request.");
      }
      if (request.from !== undefined) {
        const currentAnchor = await this.#resolveRequiredRevision(request.from);
        if (currentAnchor !== parsed.anchor) {
          throw invalidRequest(
            "The requested history revision changed while it was being paginated.",
          );
        }
      }
      anchor = parsed.anchor;
      offset = parsed.offset;
    } else if (request.from === undefined) {
      anchor = await this.#tryResolveRevision("HEAD");
    } else {
      anchor = await this.#resolveRequiredRevision(request.from);
    }

    if (anchor === null) {
      return { items: [], nextCursor: null, truncated: false };
    }

    const result = await this.#runGit(
      [
        "log",
        "-z",
        "--no-show-signature",
        "--encoding=UTF-8",
        `--max-count=${limit + 1}`,
        `--skip=${offset}`,
        "--format=format:%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s",
        anchor,
        "--",
        ...paths,
      ],
      {
        operation: "read Git history",
        maxStdoutBytes: MAX_STRUCTURED_OUTPUT_BYTES,
      },
    );
    if (result.truncated) {
      throw internalFailure("Git history exceeded the safe output limit.");
    }

    const commits = parseHistory(result.stdout);
    const hasMore = commits.length > limit;
    const items = commits.slice(0, limit);
    const nextCursor = hasMore
      ? encodeCursor({
          version: 1,
          kind: "history",
          offset: offset + items.length,
          anchor,
          scope,
        })
      : null;
    return { items, nextCursor, truncated: hasMore };
  }

  async readFileAtRevision(
    request: GitFileAtRevisionRequest,
  ): Promise<GitFileAtRevisionResult | null> {
    await this.#ensureRepository();
    if (typeof request !== "object" || request === null) {
      throw invalidRequest("A historical file request is required.");
    }
    const maxBytes = normalizeByteLimit(
      request.maxBytes,
      GIT_READ_LIMITS.maxFileBytes,
      "file",
    );
    const path = normalizePath(request.path);
    const revision = await this.#resolveRequiredRevision(request.revision);
    const object = `${revision}:${path}`;
    const type = await this.#runGit(["cat-file", "-t", object], {
      operation: "inspect a historical file",
      maxStdoutBytes: 32,
      acceptedExitCodes: [0, 128],
    });
    if (type.exitCode !== 0) return null;
    if (stripOneLineEnding(decodeUtf8(type.stdout)) !== "blob") return null;

    const result = await this.#runGit(["cat-file", "blob", object], {
      operation: "read a historical file",
      maxStdoutBytes: maxBytes + 1,
    });
    const truncated = result.truncated || result.stdout.byteLength > maxBytes;
    const content = new Uint8Array(result.stdout.subarray(0, maxBytes));
    return { content, bytes: content.byteLength, truncated };
  }

  async getChangedFiles(
    request: GitChangedFilesRequest,
  ): Promise<GitPage<ChangedFile>> {
    await this.#ensureRepository();
    if (typeof request !== "object" || request === null) {
      throw invalidRequest("A changed-files request is required.");
    }
    const { limit, cursor } = normalizePageRequest(request.page ?? {});
    const [base, head] = await this.#resolveRevisionPair(request.base, request.head);
    let offset = 0;

    if (cursor !== undefined) {
      const parsed = decodeCursor(cursor, "changed-files");
      if (parsed.base !== base || parsed.head !== head) {
        throw invalidRequest(
          "A changed-files revision moved while it was being paginated.",
        );
      }
      offset = parsed.offset;
    }

    const result = await this.#runGit(
      [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        "--find-copies-harder",
        "--no-ext-diff",
        "--no-textconv",
        base,
        head,
        "--",
      ],
      {
        operation: "read changed files",
        maxStdoutBytes: MAX_STRUCTURED_OUTPUT_BYTES,
      },
    );
    if (result.truncated) {
      throw internalFailure("The changed-file list exceeded the safe output limit.");
    }

    const changedFiles = parseChangedFiles(result.stdout);
    assertOffset(offset, changedFiles.length);
    const items = changedFiles.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor =
      nextOffset < changedFiles.length
        ? encodeCursor({
            version: 1,
            kind: "changed-files",
            offset: nextOffset,
            base,
            head,
          })
        : null;
    return { items, nextCursor, truncated: nextCursor !== null };
  }

  async #ensureRepository(): Promise<void> {
    if (this.#repositoryIdentity !== null) {
      this.#assertRepositoryIdentity(this.#repositoryIdentity);
      return;
    }
    if (this.#repositoryCheck === null) {
      this.#repositoryCheck = this.#checkRepository();
    }
    try {
      const identity = await this.#repositoryCheck;
      this.#repositoryIdentity = identity;
      this.#assertRepositoryIdentity(identity);
    } catch (error) {
      if (this.#repositoryIdentity === null) this.#repositoryCheck = null;
      throw error;
    }
  }

  async #checkRepository(): Promise<RepositoryIdentity> {
    const rootResult = await this.#runGit(
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        operation: "locate the Git repository",
        maxStdoutBytes: 16 * 1024,
      },
    );
    if (rootResult.truncated) {
      throw internalFailure("The Git repository path exceeded the safe output limit.");
    }
    const reportedRoot = stripOneLineEnding(decodeUtf8(rootResult.stdout));
    let reportedRootIdentity: NodeIdentity;
    try {
      const canonicalReportedRoot = realpathSync(reportedRoot);
      reportedRootIdentity = captureDirectory(canonicalReportedRoot);
    } catch {
      throw internalFailure("Git reported an inaccessible repository root.");
    }
    if (!sameNodeIdentity(reportedRootIdentity, this.#projectRootIdentity)) {
      throw invalidRequest(
        "The project root must be the repository top-level directory.",
      );
    }

    let controlBefore: NodeIdentity;
    try {
      controlBefore = captureControlEntry(join(this.#projectRoot, ".git"));
    } catch {
      throw internalFailure("The project root has no stable Git control entry.");
    }

    const [gitDirectoryResult, commonDirectoryResult] = await Promise.all([
      this.#runGit(["rev-parse", "--path-format=absolute", "--absolute-git-dir"], {
        operation: "locate the Git directory",
        maxStdoutBytes: 16 * 1024,
      }),
      this.#runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        operation: "locate the common Git directory",
        maxStdoutBytes: 16 * 1024,
      }),
    ]);
    if (
      gitDirectoryResult.truncated ||
      commonDirectoryResult.truncated
    ) {
      throw internalFailure("Git repository paths exceeded the safe output limit.");
    }

    const reportedGitDirectory = stripOneLineEnding(decodeUtf8(gitDirectoryResult.stdout));
    const reportedCommonDirectory = stripOneLineEnding(
      decodeUtf8(commonDirectoryResult.stdout),
    );
    let gitDirectoryPath: string;
    let commonDirectoryPath: string;
    let gitDirectory: NodeIdentity;
    let commonDirectory: NodeIdentity;
    let controlAfter: NodeIdentity;
    try {
      gitDirectoryPath = realpathSync(reportedGitDirectory);
      commonDirectoryPath = realpathSync(reportedCommonDirectory);
      gitDirectory = captureDirectory(gitDirectoryPath);
      commonDirectory = captureDirectory(commonDirectoryPath);
      controlAfter = captureControlEntry(join(this.#projectRoot, ".git"));
    } catch {
      throw internalFailure("Git reported an inaccessible repository location.");
    }
    if (!sameNodeIdentity(controlBefore, controlAfter)) {
      throw repositoryChanged();
    }
    return {
      controlEntry: controlAfter,
      gitDirectoryPath,
      gitDirectory,
      commonDirectoryPath,
      commonDirectory,
    };
  }

  #assertRepositoryIdentity(expected: RepositoryIdentity): void {
    try {
      const root = captureDirectory(this.#projectRoot);
      const controlEntry = captureControlEntry(join(this.#projectRoot, ".git"));
      const gitDirectoryPath = realpathSync(expected.gitDirectoryPath);
      const commonDirectoryPath = realpathSync(expected.commonDirectoryPath);
      if (
        !sameNodeIdentity(root, this.#projectRootIdentity) ||
        !sameNodeIdentity(controlEntry, expected.controlEntry) ||
        gitDirectoryPath !== expected.gitDirectoryPath ||
        commonDirectoryPath !== expected.commonDirectoryPath ||
        !sameNodeIdentity(captureDirectory(gitDirectoryPath), expected.gitDirectory) ||
        !sameNodeIdentity(captureDirectory(commonDirectoryPath), expected.commonDirectory)
      ) {
        throw repositoryChanged();
      }
    } catch (error) {
      if (error instanceof MexPortError) throw error;
      throw repositoryChanged();
    }
  }

  async #readStatus(): Promise<StatusSnapshot> {
    const result = await this.#runGit(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--no-ahead-behind",
      ],
      {
        operation: "read the working tree",
        maxStdoutBytes: MAX_STRUCTURED_OUTPUT_BYTES,
      },
    );
    if (result.truncated) {
      throw internalFailure("The working-tree status exceeded the safe output limit.");
    }
    return parseStatus(result.stdout);
  }

  async #resolveRequiredRevision(ref: string): Promise<string> {
    const revision = await this.#tryResolveRevision(ref);
    if (revision === null) {
      throw notFound(`Git revision ${JSON.stringify(ref)} does not name a commit.`);
    }
    return revision;
  }

  async #resolveRevisionPair(
    firstRef: string,
    secondRef: string,
  ): Promise<readonly [string, string]> {
    normalizeRevision(firstRef);
    normalizeRevision(secondRef);
    const result = await this.#runGit(
      [
        "rev-parse",
        "--revs-only",
        "--end-of-options",
        `${firstRef}^{commit}`,
        `${secondRef}^{commit}`,
      ],
      { operation: "resolve Git revisions", maxStdoutBytes: 256 },
    );
    if (result.truncated) throw malformedGitOutput("commit identifiers");
    const revisions = stripOneLineEnding(decodeUtf8(result.stdout)).split(/\r?\n/u);
    if (revisions.length !== 2) {
      throw notFound("One or more Git revisions do not name a single commit.");
    }
    if (!isObjectId(revisions[0]) || !isObjectId(revisions[1])) {
      throw malformedGitOutput("commit identifiers");
    }
    return [revisions[0], revisions[1]];
  }

  async #tryResolveRevision(ref: string): Promise<string | null> {
    normalizeRevision(ref);
    const result = await this.#runGit(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      {
        operation: "resolve a Git revision",
        maxStdoutBytes: 128,
        acceptedExitCodes: [0, 1],
      },
    );
    if (result.exitCode === 1) return null;
    const revision = stripOneLineEnding(decodeUtf8(result.stdout));
    if (!/^[0-9a-f]{40,64}$/.test(revision)) {
      throw internalFailure("Git returned an invalid commit identifier.");
    }
    return revision;
  }

  async #runDiff(
    leadingArguments: readonly string[],
    paths: readonly string[],
    maxStdoutBytes: number,
  ): Promise<GitCommandResult> {
    return this.#runGit(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...leadingArguments,
        "--",
        ...paths,
      ],
      { operation: "read a Git diff", maxStdoutBytes },
    );
  }

  async #stagedDiffArguments(): Promise<readonly string[]> {
    const head = await this.#tryResolveRevision("HEAD");
    return head === null ? ["--cached"] : ["--cached", head];
  }

  async #runGit(
    arguments_: readonly string[],
    options: GitCommandOptions,
  ): Promise<GitCommandResult> {
    const activeIdentity = this.#repositoryIdentity;
    if (activeIdentity !== null) this.#assertRepositoryIdentity(activeIdentity);
    const maxStdoutBytes = options.maxStdoutBytes ?? MAX_STRUCTURED_OUTPUT_BYTES;
    const acceptedExitCodes = new Set(options.acceptedExitCodes ?? [0]);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_PAGER: "",
      LC_ALL: "C",
      LANG: "C",
    };
    for (const key of REDIRECTING_GIT_ENVIRONMENT) delete environment[key];
    for (const key of Object.keys(environment)) {
      if (key.startsWith("GIT_TRACE")) delete environment[key];
    }
    if (activeIdentity !== null) {
      environment.GIT_DIR = activeIdentity.gitDirectoryPath;
      environment.GIT_COMMON_DIR = activeIdentity.commonDirectoryPath;
      environment.GIT_WORK_TREE = this.#projectRoot;
    }

    return new Promise<GitCommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(
        "git",
        [
          "--no-optional-locks",
          "--no-replace-objects",
          "-c",
          "color.ui=false",
          "-c",
          "core.quotepath=false",
          "-c",
          "core.fsmonitor=false",
          ...arguments_,
        ],
        {
          cwd: this.#projectRoot,
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.#timeoutMs);
      timer.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        const available = Math.max(0, maxStdoutBytes - stdoutBytes);
        if (available > 0) {
          const retained = chunk.subarray(0, available);
          stdoutChunks.push(retained);
          stdoutBytes += retained.byteLength;
        }
        if (chunk.byteLength > available) stdoutTruncated = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const available = Math.max(0, MAX_STDERR_BYTES - stderrBytes);
        if (available > 0) {
          const retained = chunk.subarray(0, available);
          stderrChunks.push(retained);
          stderrBytes += retained.byteLength;
        }
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(
          internalFailure(`Unable to ${options.operation}: ${error.message}`),
        );
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (activeIdentity !== null) {
          try {
            this.#assertRepositoryIdentity(activeIdentity);
          } catch (error) {
            rejectPromise(error);
            return;
          }
        }
        if (timedOut) {
          rejectPromise(
            internalFailure(
              `Timed out after ${this.#timeoutMs} ms while attempting to ${options.operation}.`,
            ),
          );
          return;
        }

        const exitCode = code ?? -1;
        const stderr = Buffer.concat(stderrChunks);
        if (!acceptedExitCodes.has(exitCode)) {
          const detail = stripOneLineEnding(stderr.toString("utf8"));
          rejectPromise(
            internalFailure(
              detail
                ? `Unable to ${options.operation}: ${detail}`
                : `Unable to ${options.operation}; Git exited with code ${exitCode}.`,
            ),
          );
          return;
        }

        resolvePromise({
          stdout: Buffer.concat(stdoutChunks),
          stderr,
          exitCode,
          truncated: stdoutTruncated,
        });
      });
    });
  }
}

function parseStatus(output: Buffer): StatusSnapshot {
  const records = splitNul(output);
  const entries: GitWorkingTreeEntry[] = [];
  let branch: string | null = null;
  let head: string | null = null;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === "") continue;
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      head = value === "(initial)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : requireCanonicalGitBranch(value);
      continue;
    }
    if (record.startsWith("# ")) continue;
    if (record.startsWith("1 ")) {
      const match = /^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/s.exec(
        record,
      );
      if (match === null) throw malformedGitOutput("working-tree entry");
      entries.push({
        path: requireGitPath(match[2]),
        indexStatus: parseFileStatus(match[1][0]),
        workingTreeStatus: parseFileStatus(match[1][1]),
      });
      continue;
    }
    if (record.startsWith("2 ")) {
      const match = /^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/s.exec(
        record,
      );
      const previousPath = records[index + 1];
      if (match === null || previousPath === undefined || previousPath === "") {
        throw malformedGitOutput("renamed working-tree entry");
      }
      entries.push({
        path: requireGitPath(match[2]),
        previousPath: requireGitPath(previousPath),
        indexStatus: parseFileStatus(match[1][0]),
        workingTreeStatus: parseFileStatus(match[1][1]),
      });
      index += 1;
      continue;
    }
    if (record.startsWith("u ")) {
      const match = /^u ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/s.exec(
        record,
      );
      if (match === null) throw malformedGitOutput("unmerged working-tree entry");
      entries.push({
        path: requireGitPath(match[2]),
        indexStatus: "unmerged",
        workingTreeStatus: "unmerged",
      });
      continue;
    }
    if (record.startsWith("? ")) {
      entries.push({
        path: requireGitPath(record.slice(2)),
        indexStatus: "unmodified",
        workingTreeStatus: "untracked",
      });
      continue;
    }
    if (record.startsWith("! ")) {
      entries.push({
        path: requireGitPath(record.slice(2)),
        indexStatus: "unmodified",
        workingTreeStatus: "ignored",
      });
      continue;
    }
    throw malformedGitOutput("working-tree status");
  }

  return {
    branch,
    head,
    entries,
    fingerprint: createHash("sha256").update(output).digest("hex"),
  };
}

function parseHistory(output: Buffer): readonly GitCommit[] {
  if (output.byteLength === 0) return [];
  const fields = splitNul(output);
  if (fields.length % 9 !== 0) throw malformedGitOutput("history");
  const commits: GitCommit[] = [];
  for (let index = 0; index < fields.length; index += 9) {
    const [hash, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, subject] =
      fields.slice(index, index + 9);
    if (!/^[0-9a-f]{40,64}$/.test(hash) || !isIsoTimestamp(authoredAt) || !isIsoTimestamp(committedAt)) {
      throw malformedGitOutput("history");
    }
    const parsedParents = parents === "" ? [] : parents.split(" ");
    if (parsedParents.some((parent) => !/^[0-9a-f]{40,64}$/.test(parent))) {
      throw malformedGitOutput("history parents");
    }
    commits.push({
      hash,
      parents: parsedParents,
      author: { name: authorName || null, email: authorEmail || null },
      authoredAt,
      committer: { name: committerName || null, email: committerEmail || null },
      committedAt,
      subject,
    });
  }
  return commits;
}

function parseChangedFiles(output: Buffer): readonly ChangedFile[] {
  const fields = splitNul(output);
  const changed: ChangedFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const token = fields[index];
    if (token === "") {
      index += 1;
      continue;
    }
    const code = token[0];
    if (code === "R" || code === "C") {
      const previousPath = fields[index + 1];
      const path = fields[index + 2];
      if (previousPath === undefined || path === undefined) {
        throw malformedGitOutput("renamed changed-file entry");
      }
      changed.push({
        path: requireGitPath(path),
        previousPath: requireGitPath(previousPath),
        status: code === "R" ? "renamed" : "copied",
      });
      index += 3;
      continue;
    }

    const path = fields[index + 1];
    if (path === undefined) throw malformedGitOutput("changed-file entry");
    const status =
      code === "A"
        ? "added"
        : code === "M"
          ? "modified"
          : code === "D"
            ? "deleted"
            : code === "T"
              ? "type_changed"
              : null;
    if (status === null) throw malformedGitOutput("changed-file status");
    changed.push({ path: requireGitPath(path), status });
    index += 2;
  }
  return changed;
}

function parseFileStatus(code: string): GitFileStatus {
  switch (code) {
    case ".":
    case " ":
      return "unmodified";
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    case "U":
      return "unmerged";
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    default:
      return "unknown";
  }
}

function normalizePageRequest(page: PageRequest): {
  readonly limit: number;
  readonly cursor: string | undefined;
} {
  if (typeof page !== "object" || page === null) {
    throw invalidRequest("Page options must be an object.");
  }
  const limit = page.limit ?? GIT_READ_LIMITS.defaultPageSize;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > GIT_READ_LIMITS.maxPageSize
  ) {
    throw invalidRequest(
      `Page size must be an integer from 1 to ${GIT_READ_LIMITS.maxPageSize}.`,
    );
  }
  if (page.cursor !== undefined && page.cursor.length > MAX_CURSOR_BYTES) {
    throw invalidRequest("The page cursor is too large.");
  }
  return { limit, cursor: page.cursor };
}

function normalizeByteLimit(value: number, maximum: number, kind: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw invalidRequest(
      `The ${kind} byte limit must be an integer from 1 to ${maximum}.`,
    );
  }
  return value;
}

function normalizeRevision(ref: string): string {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > MAX_REF_LENGTH ||
    ref.startsWith("-") ||
    ref.startsWith("^") ||
    /[\0-\x20\x7f\\:]/u.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("^@") ||
    ref.includes("^!") ||
    ref.includes("^-")
  ) {
    throw invalidRequest("The Git revision is not a safe revision expression.");
  }
  return ref;
}

function normalizePaths(paths: readonly string[] | undefined): readonly string[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) throw invalidRequest("Git paths must be an array.");
  if (paths.length > MAX_PATHS_PER_REQUEST) {
    throw invalidRequest(`A Git request may include at most ${MAX_PATHS_PER_REQUEST} paths.`);
  }
  return paths.map(normalizePath);
}

function normalizePath(path: string): string {
  if (!isCanonicalGitPath(path)) {
    throw new MexPortError({
      title: "Path outside project",
      status: 400,
      code: "PATH_OUTSIDE_PROJECT",
      detail: "Git paths must be canonical repository-relative POSIX paths.",
    });
  }
  return path;
}

function assertDiffRequest(request: GitDiffRequest): void {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.target !== "object" ||
    request.target === null
  ) {
    throw invalidRequest("A Git diff request and target are required.");
  }
  if (request.target.kind === "range") {
    if (
      typeof request.target.base !== "string" ||
      typeof request.target.head !== "string"
    ) {
      throw invalidRequest("A range diff requires base and head revisions.");
    }
    return;
  }
  if (
    request.target.kind !== "working-tree" ||
    typeof request.target.includeStaged !== "boolean" ||
    typeof request.target.includeUnstaged !== "boolean"
  ) {
    throw invalidRequest("A working-tree diff requires explicit staged and unstaged flags.");
  }
}

function requireGitPath(path: string): string {
  if (!isCanonicalGitPath(path)) throw malformedGitOutput("repository path");
  return path;
}

/** @internal */
export function requireCanonicalGitBranch(branch: string): string {
  if (
    branch.length === 0 ||
    branch.trim() !== branch ||
    branch.normalize("NFC") !== branch ||
    /[\p{Cc}\u2028\u2029]/u.test(branch) ||
    hasUnpairedSurrogate(branch) ||
    Buffer.byteLength(branch, "utf8") > MAX_BRANCH_BYTES
  ) {
    throw malformedGitOutput("branch name");
  }
  return branch;
}

function isCanonicalGitPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PATH_BYTES &&
    isRepoRelativePath(value) &&
    value.normalize("NFC") === value &&
    !/[\p{Cc}\u2028\u2029]/u.test(value) &&
    !hasUnpairedSurrogate(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodeCursor(cursor: GitCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor<TKind extends GitCursor["kind"]>(
  value: string,
  kind: TKind,
): Extract<GitCursor, { kind: TKind }> {
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CURSOR_BYTES) throw new Error();
    decoded = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw invalidRequest("The page cursor is invalid.");
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("version" in decoded) ||
    decoded.version !== 1 ||
    !("kind" in decoded) ||
    decoded.kind !== kind ||
    !("offset" in decoded) ||
    !Number.isSafeInteger(decoded.offset) ||
    (decoded.offset as number) < 0
  ) {
    throw invalidRequest("The page cursor is invalid.");
  }

  if (kind === "working-tree") {
    if (!("fingerprint" in decoded) || !isSha256(decoded.fingerprint)) {
      throw invalidRequest("The page cursor is invalid.");
    }
  } else if (kind === "history") {
    if (
      !("anchor" in decoded) ||
      !isObjectId(decoded.anchor) ||
      !("scope" in decoded) ||
      !isSha256(decoded.scope)
    ) {
      throw invalidRequest("The page cursor is invalid.");
    }
  } else if (
    !("base" in decoded) ||
    !isObjectId(decoded.base) ||
    !("head" in decoded) ||
    !isObjectId(decoded.head)
  ) {
    throw invalidRequest("The page cursor is invalid.");
  }

  return decoded as Extract<GitCursor, { kind: TKind }>;
}

function assertOffset(offset: number, itemCount: number): void {
  if (offset > itemCount) throw invalidRequest("The page cursor is out of range.");
}

function hashScope(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function splitNul(output: Buffer): string[] {
  if (output.byteLength === 0) return [];
  const fields = decodeUtf8(output).split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function decodeUtf8(output: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw malformedGitOutput("UTF-8 output");
  }
}

function stripOneLineEnding(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function utf8Prefix(
  output: Buffer,
  maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const prefix = output.subarray(0, maxBytes);
  let text = prefix.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  const bytes = Buffer.byteLength(text, "utf8");
  return { text, bytes, truncated: output.byteLength > bytes };
}

function captureDirectory(path: string): NodeIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory()) throw new Error("not a directory");
  return nodeIdentity(stats, "directory");
}

function captureControlEntry(path: string): NodeIdentity {
  const lexicalStats = lstatSync(path, { bigint: true });
  if (lexicalStats.isDirectory()) return nodeIdentity(lexicalStats, "directory");
  if (!lexicalStats.isFile()) throw new Error("unsupported Git control entry");

  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_GIT_CONTROL_FILE_BYTES)) {
      throw new Error("invalid Git control file");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const live = lstatSync(path, { bigint: true });
    if (
      !sameFileObservation(before, after) ||
      !sameFileObservation(after, live)
    ) {
      throw new Error("Git control file changed while being read");
    }
    return {
      ...nodeIdentity(after, "file"),
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function nodeIdentity(
  stats: BigIntStats,
  kind: NodeIdentity["kind"],
): NodeIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    birthtimeNs: stats.birthtimeNs,
    kind,
  };
}

function sameNodeIdentity(left: NodeIdentity, right: NodeIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.kind === right.kind &&
    (left.contentHash ?? null) === (right.contentHash ?? null)
  );
}

function sameFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function invalidRequest(detail: string): MexPortError {
  return new MexPortError({
    title: "Invalid Git request",
    status: 400,
    code: "INVALID_REQUEST",
    detail,
  });
}

function notFound(detail: string): MexPortError {
  return new MexPortError({
    title: "Git revision not found",
    status: 404,
    code: "NOT_FOUND",
    detail,
  });
}

function internalFailure(detail: string): MexPortError {
  return new MexPortError({
    title: "Git read failed",
    status: 500,
    code: "INTERNAL_ERROR",
    detail,
  });
}

function repositoryChanged(): MexPortError {
  return new MexPortError({
    title: "Git repository changed",
    status: 409,
    code: "REVISION_CONFLICT",
    detail:
      "The repository control directory changed while Git data was being read. Create a new GitPort and retry.",
  });
}

function malformedGitOutput(kind: string): MexPortError {
  return internalFailure(`Git returned malformed ${kind} data.`);
}
