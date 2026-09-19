import type {
  Page,
  PageRequest,
  RepoRelativePath,
  RepoState,
} from "./shared.js";

export const GIT_READ_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 200,
  maxDiffBytes: 2 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
} as const;

export const GIT_FILE_STATUSES = [
  "unmodified",
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
  "unmerged",
  "untracked",
  "ignored",
  "unknown",
] as const;

export const GIT_CHANGE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
] as const;

export type GitFileStatus = (typeof GIT_FILE_STATUSES)[number];
export type GitChangeStatus = (typeof GIT_CHANGE_STATUSES)[number];

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

export interface GitWorkingTreeEntry {
  path: RepoRelativePath;
  indexStatus: GitFileStatus;
  workingTreeStatus: GitFileStatus;
  previousPath?: RepoRelativePath;
}

export type GitDiffTarget =
  | {
      kind: "working-tree";
      includeStaged: boolean;
      includeUnstaged: boolean;
    }
  | {
      kind: "range";
      base: string;
      head: string;
    };

export interface GitDiffRequest {
  target: GitDiffTarget;
  paths?: readonly RepoRelativePath[];
  maxBytes: number;
}

export interface GitDiffResult {
  target: GitDiffTarget;
  diff: string;
  bytes: number;
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  parents: readonly string[];
  author: GitIdentity;
  authoredAt: string;
  committer: GitIdentity;
  committedAt: string;
  subject: string;
}

export interface GitHistoryRequest extends PageRequest {
  from?: string;
  paths?: readonly RepoRelativePath[];
}

export interface GitPage<T> extends Page<T> {
  truncated: boolean;
}

export interface GitFileAtRevisionRequest {
  revision: string;
  path: RepoRelativePath;
  maxBytes: number;
}

export interface GitFileAtRevisionResult {
  content: Uint8Array;
  bytes: number;
  truncated: boolean;
}

export type ChangedFile =
  | {
      path: RepoRelativePath;
      status: Exclude<GitChangeStatus, "renamed" | "copied">;
    }
  | {
      path: RepoRelativePath;
      status: "renamed" | "copied";
      previousPath: RepoRelativePath;
    };

export interface GitChangedFilesRequest {
  base: string;
  head: string;
  page?: PageRequest;
}

/** Strictly read-only Git application seam with no generic command escape hatch. */
export interface GitPort {
  getRepoState(): Promise<RepoState>;
  getIdentity(): Promise<GitIdentity>;
  getWorkingTree(page?: PageRequest): Promise<GitPage<GitWorkingTreeEntry>>;
  resolveRevision(ref: string): Promise<string>;
  getDiff(request: GitDiffRequest): Promise<GitDiffResult>;
  getHistory(request?: GitHistoryRequest): Promise<GitPage<GitCommit>>;
  readFileAtRevision(
    request: GitFileAtRevisionRequest,
  ): Promise<GitFileAtRevisionResult | null>;
  getChangedFiles(
    request: GitChangedFilesRequest,
  ): Promise<GitPage<ChangedFile>>;
}
