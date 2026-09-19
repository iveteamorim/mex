import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defineTeamIdentityActivityContract,
  type SeedMemberRequest,
  type TeamIdentityActivityContractFactory,
  type TeamIdentityActivityContractHarness,
  type TeamIdentityActivityContractPort,
  type TeamIdentityActivityScenario,
  type TeamIdentityActivitySnapshot,
  type TeamIdentityActivityTwoCloneHarness,
} from "./contracts/team-identity-activity.contract.js";
import { generateArtifactId } from "../src/team/artifacts/ulid.js";
import type {
  GitChangedFilesRequest,
  GitDiffRequest,
  GitFileAtRevisionRequest,
  GitHistoryRequest,
  GitIdentity,
  GitPort,
} from "../src/team/contracts/git.js";
import type { JsonValue, RepoState, Revision } from "../src/team/contracts/shared.js";
import type { TeamMember } from "../src/team/contracts/workflow.js";
import type { WikiPort } from "../src/team/contracts/wiki.js";
import { MemberRepository } from "../src/team/identity/member-repository.js";
import { TeamLocalState } from "../src/team/local-state/index.js";
import { MockWikiPort } from "../src/team/testing/wiki/mock-wiki-port.js";
import {
  createRepositoryTeamWorkflowPortWithDependencies,
  RepositoryTeamWorkflowPort,
} from "../src/team/workflow/repository-team-workflow-port.js";

const NOW = "2026-08-27T04:05:06.000Z";
const HEAD = "1".repeat(40);
const SCAFFOLD_ID = "checkpoint_c_identity_contract";
const SURFACE_METHODS = [
  "getMember",
  "listMembers",
  "getCurrentActor",
  "getActivity",
  "listActivity",
  "previewIdentityActivity",
  "applyIdentityActivity",
] as const;

const hasCheckpointCSurface = SURFACE_METHODS.every(
  (method) => typeof (RepositoryTeamWorkflowPort.prototype as unknown as Record<string, unknown>)[method]
    === "function",
);

const factory: TeamIdentityActivityContractFactory = {
  open: (scenario) => RepositoryIdentityActivityHarness.open(scenario),
  openTwoClone: () => RepositoryTwoCloneHarness.open(),
};

defineTeamIdentityActivityContract("repository", factory, {
  skip: !hasCheckpointCSurface,
});

interface MutableGit extends GitPort {
  state: RepoState;
  identity: GitIdentity | "unavailable";
}

class RepositoryIdentityActivityHarness implements TeamIdentityActivityContractHarness {
  readonly root: string;
  readonly oracle: TeamIdentityActivityContractHarness["oracle"];
  readonly #git: MutableGit;
  readonly #scaffoldId: string;
  readonly #seedOffset: number;
  #clock = NOW;
  #memberSequence = 0;
  #eventSequence = 0;
  #leaseSequence = 0;
  #pidSequence = 10_000;
  port: TeamIdentityActivityContractPort;
  #closed = false;

  private constructor(
    root: string,
    git: MutableGit,
    seedOffset: number,
    scaffoldId = SCAFFOLD_ID,
  ) {
    this.root = root;
    this.#git = git;
    this.#seedOffset = seedOffset;
    this.#scaffoldId = scaffoldId;
    this.oracle = {
      now: NOW,
      memberIds: Array.from({ length: 12 }, (_, index) => deterministicId(
        "member",
        seedOffset + index + 1,
        Date.parse(NOW),
      )),
    };
    this.port = this.#openPort();
  }

  static async open(
    scenario: TeamIdentityActivityScenario,
    options: { seedOffset?: number; scaffoldId?: string } = {},
  ): Promise<RepositoryIdentityActivityHarness> {
    const root = mkdtempSync(join(tmpdir(), "mex-team-c-contract-"));
    const identity: MutableGit["identity"] = scenario === "unknown"
      ? "unavailable"
      : scenario === "git-fallback"
        ? { name: "Unmatched Git User", email: "unmatched@example.test" }
        : { name: "Ada", email: "ada@example.test" };
    const harness = new RepositoryIdentityActivityHarness(
      root,
      fakeGit(identity),
      options.seedOffset ?? 0,
      options.scaffoldId,
    );
    try {
      if (scenario === "git-alias") {
        await harness.seedMember({
          id: harness.oracle.memberIds[0],
          displayName: "Ada Lovelace",
          active: true,
          gitAliases: [{ name: "Ada", email: "ada@example.test" }],
        });
      }
      if (scenario.startsWith("legacy-v")) {
        await harness.seedMember({
          id: harness.oracle.memberIds[0],
          displayName: "Legacy Member",
          active: true,
        });
        const version = Number(scenario.at(-1)) as 1 | 2 | 3;
        createLegacyDatabase(root, harness.#scaffoldId, version, () => harness.#clock);
      }
      return harness;
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  async seedMember(request: SeedMemberRequest): Promise<TeamMember> {
    const repository = new MemberRepository(this.root, {
      idFactory: () => request.id ?? this.oracle.memberIds[this.#memberSequence++]!,
    });
    return repository.create({
      ...(request.id === undefined ? {} : { id: request.id }),
      displayName: request.displayName,
      active: request.active ?? true,
      gitAliases: request.gitAliases ?? [],
    });
  }

  async snapshot(): Promise<TeamIdentityActivitySnapshot> {
    const canonical = snapshotPaths(this.root, [
      join(this.root, ".mex", "team"),
      join(this.root, ".mex", "events", "activity"),
    ]);
    const localRoot = join(this.root, ".mex", "local");
    const local = snapshotPaths(this.root, [localRoot]);
    return {
      canonicalDigest: digest(canonical),
      localDigest: existsSync(localRoot) ? digest(local) : null,
      localEntries: local,
      activityIds: canonical
        .map((entry) => /(?:^|\/)(event_[0-9A-HJKMNP-TV-Z]{26})\.md:/u.exec(entry)?.[1])
        .filter((value): value is string => value !== undefined)
        .sort(compareCodePoints),
    };
  }

  async restart(): Promise<TeamIdentityActivityContractPort> {
    return this.#openPort();
  }

  async contendingPort(): Promise<TeamIdentityActivityContractPort> {
    return this.#openPort();
  }

  setNow(timestamp: string): void {
    this.#clock = timestamp;
  }

  setGitIdentity(identity: GitIdentity | "unavailable"): void {
    this.#git.identity = identity;
  }

  setRepoState(patch: Partial<RepoState>): void {
    this.#git.state = { ...this.#git.state, ...patch, observedAt: this.#clock };
  }

  localSchemaVersion(): number | null {
    const path = join(this.root, ".mex", "local", "team.db");
    if (!existsSync(path)) return null;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare(
        "SELECT version FROM local_state_schema WHERE singleton = 1",
      ).get() as { version?: unknown } | undefined;
      return typeof row?.version === "number" ? row.version : null;
    } finally {
      database.close();
    }
  }

  installActivitySourceTruncation(): void {
    const root = join(this.root, ".mex", "events", "activity");
    for (let index = 0; index < 4_097; index += 1) {
      const year = 1900 + Math.floor(index / 12);
      const month = String((index % 12) + 1).padStart(2, "0");
      mkdirSync(join(root, `${year}-${month}`), { recursive: true });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    rmSync(this.root, { recursive: true, force: true });
  }

  #openPort(): TeamIdentityActivityContractPort {
    const port = createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(this.root, {
      scaffoldId: this.#scaffoldId,
      wiki: new MockWikiPort({ now: () => this.#clock }) as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
      git: this.#git,
      now: () => new Date(this.#clock),
      pid: this.#pidSequence++,
      processStatus: () => "alive",
      idFactories: {
        member: () => deterministicId(
          "member",
          this.#seedOffset + 100 + this.#memberSequence++,
          Date.parse(this.#clock),
        ),
        workstream: () => deterministicId("ws", this.#seedOffset + 200, Date.parse(this.#clock)),
        proposal: () => deterministicId("proposal", this.#seedOffset + 201, Date.parse(this.#clock)),
        relay: () => deterministicId("relay", this.#seedOffset + 202, Date.parse(this.#clock)),
        playbook: () => deterministicId("playbook", this.#seedOffset + 203, Date.parse(this.#clock)),
        playbookRun: () => deterministicId("run", this.#seedOffset + 204, Date.parse(this.#clock)),
        activity: (timestampMs) => deterministicId(
          "event",
          this.#seedOffset + 300 + this.#eventSequence++,
          timestampMs,
        ),
        localDraft: (kind) => `${kind}_checkpoint_c_contract_${this.#seedOffset}`,
        leaseToken: () => (++this.#leaseSequence).toString(16).padStart(64, "0"),
      },
    });
    return port as unknown as TeamIdentityActivityContractPort;
  }
}

class RepositoryTwoCloneHarness implements TeamIdentityActivityTwoCloneHarness {
  private constructor(
    readonly left: RepositoryIdentityActivityHarness,
    readonly right: RepositoryIdentityActivityHarness,
  ) {}

  static async open(): Promise<RepositoryTwoCloneHarness> {
    const left = await RepositoryIdentityActivityHarness.open("git-fallback", {
      seedOffset: 1_000,
      scaffoldId: "checkpoint_c_two_clone",
    });
    try {
      const right = await RepositoryIdentityActivityHarness.open("git-fallback", {
        seedOffset: 2_000,
        scaffoldId: "checkpoint_c_two_clone",
      });
      return new RepositoryTwoCloneHarness(left, right);
    } catch (error) {
      await left.close();
      throw error;
    }
  }

  async synchronizeCanonical(): Promise<void> {
    synchronizeTree(
      join(this.left.root, ".mex", "team"),
      join(this.right.root, ".mex", "team"),
    );
    synchronizeTree(
      join(this.left.root, ".mex", "events", "activity"),
      join(this.right.root, ".mex", "events", "activity"),
    );
  }

  async close(): Promise<void> {
    await Promise.all([this.left.close(), this.right.close()]);
  }
}

function fakeGit(identity: MutableGit["identity"]): MutableGit {
  const git: MutableGit = {
    identity,
    state: {
      branch: "feature/team-identity",
      head: HEAD,
      dirty: false,
      observedAt: NOW,
    },
    async getRepoState() {
      return structuredClone(git.state);
    },
    async getIdentity() {
      if (git.identity === "unavailable") throw new Error("Git identity unavailable");
      return structuredClone(git.identity);
    },
    async getWorkingTree() {
      return { items: [], nextCursor: null, truncated: false };
    },
    async resolveRevision(ref: string) {
      return ref;
    },
    async getDiff(request: GitDiffRequest) {
      return { target: request.target, diff: "", bytes: 0, truncated: false };
    },
    async getHistory(_request?: GitHistoryRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
    async readFileAtRevision(_request: GitFileAtRevisionRequest) {
      return null;
    },
    async getChangedFiles(_request: GitChangedFilesRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
  };
  return git;
}

function createLegacyDatabase(
  root: string,
  scaffoldId: string,
  version: 1 | 2 | 3,
  now: () => string,
): void {
  const store = new TeamLocalState({ projectRoot: root, scaffoldId, now });
  store.initializeForMutation();
  const database = new DatabaseSync(store.databasePath);
  try {
    database.exec(`
      DROP TABLE IF EXISTS inbox_drafts;
      DROP TABLE IF EXISTS relay_drafts;
      DROP TABLE IF EXISTS team_workflow_lease;
      DROP TABLE IF EXISTS team_workflow_operations;
    `);
    if (version === 1) {
      database.exec(`
        DROP TABLE IF EXISTS hub_jobs;
        DROP TABLE IF EXISTS hub_runtime_lease;
      `);
    } else if (version === 2) {
      database.exec(`
        DROP TABLE IF EXISTS hub_jobs;
        DROP TABLE IF EXISTS hub_runtime_lease;
        CREATE TABLE hub_runtime_lease (
          singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
          pid INTEGER NOT NULL CHECK (pid >= 1),
          token TEXT NOT NULL CHECK (length(token) = 64),
          acquired_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE hub_jobs (
          id TEXT NOT NULL PRIMARY KEY,
          scaffold_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('graph_refresh', 'graph_rebuild', 'wiki_refresh', 'wiki_rebuild')),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          phase TEXT NOT NULL CHECK (
            phase IN ('queued', 'running', 'refreshing', 'rebuilding', 'finalizing', 'complete', 'failed', 'interrupted')
          ),
          progress_completed INTEGER CHECK (progress_completed IS NULL OR progress_completed >= 0),
          progress_total INTEGER CHECK (progress_total IS NULL OR progress_total >= 1),
          progress_message TEXT CHECK (progress_message IS NULL),
          cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          interrupted_reason TEXT CHECK (
            interrupted_reason IS NULL
            OR interrupted_reason IN ('user_cancelled', 'process_restart', 'process_shutdown')
          ),
          problem_json TEXT CHECK (
            problem_json IS NULL OR length(CAST(problem_json AS BLOB)) <= 4096
          ),
          summary TEXT CHECK (summary IS NULL),
          revision TEXT NOT NULL,
          CHECK (
            (progress_completed IS NULL AND progress_total IS NULL AND progress_message IS NULL)
            OR progress_completed IS NOT NULL
          ),
          CHECK (progress_total IS NULL OR progress_completed <= progress_total),
          CHECK (state <> 'running' OR started_at IS NOT NULL),
          CHECK (state IN ('queued', 'running') OR finished_at IS NOT NULL),
          CHECK (state <> 'interrupted' OR interrupted_reason IS NOT NULL)
        ) STRICT;
        CREATE UNIQUE INDEX hub_jobs_one_active_index_job_per_scaffold
          ON hub_jobs (scaffold_id)
          WHERE state IN ('queued', 'running');
        CREATE UNIQUE INDEX hub_jobs_generation_per_kind
          ON hub_jobs (scaffold_id, kind, generation);
        CREATE INDEX hub_jobs_scaffold_created
          ON hub_jobs (scaffold_id, created_at DESC, id DESC);
      `);
    }
    database.prepare(
      "UPDATE local_state_schema SET version = ?, applied_at = ? WHERE singleton = 1",
    ).run(version, now());
  } finally {
    database.close();
  }
}

function deterministicId(
  prefix: "member" | "ws" | "proposal" | "relay" | "event" | "playbook" | "run",
  seed: number,
  now: number,
): string {
  const random = new Uint8Array(10);
  for (let index = 0; index < random.length; index += 1) {
    random[index] = (seed * 31 + index * 17) & 0xff;
  }
  return generateArtifactId(prefix, { now, random });
}

function snapshotPaths(projectRoot: string, roots: readonly string[]): string[] {
  const entries: string[] = [];
  for (const root of roots) collectSnapshotEntries(projectRoot, root, entries);
  entries.sort(compareCodePoints);
  return entries;
}

function collectSnapshotEntries(projectRoot: string, path: string, entries: string[]): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path, { bigint: true });
  const pathFromRoot = relative(projectRoot, path).replaceAll("\\", "/");
  if (stat.isDirectory()) {
    entries.push(`D:${pathFromRoot}:${stat.mtimeNs}:${stat.ctimeNs}`);
    const children = readdirSync(path).sort(compareCodePoints);
    for (const child of children) collectSnapshotEntries(projectRoot, join(path, child), entries);
    return;
  }
  const bytes = readFileSync(path);
  entries.push(
    `F:${pathFromRoot}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

function digest(entries: readonly string[]): Revision {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex") as Revision;
}

function synchronizeTree(left: string, right: string): void {
  const staging = mkdtempSync(join(tmpdir(), "mex-team-c-sync-"));
  try {
    if (existsSync(left)) cpSync(left, join(staging, "left"), { recursive: true });
    if (existsSync(right)) cpSync(right, join(staging, "right"), { recursive: true });
    mergeTree(join(staging, "left"), right);
    mergeTree(join(staging, "right"), left);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function mergeTree(source: string, destination: string): void {
  if (!existsSync(source)) return;
  for (const file of listFiles(source)) {
    const relativePath = relative(source, file);
    const target = join(destination, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const before = readFileSync(target);
      const after = readFileSync(file);
      if (!before.equals(after)) throw new Error(`Canonical clone conflict at ${relativePath}.`);
      continue;
    }
    cpSync(file, target);
  }
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort(compareCodePoints)) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) files.push(child);
    }
  };
  visit(root);
  return files;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
