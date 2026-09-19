import { opendirSync } from "node:fs";
import type {
  Diagnostic,
  FileChange,
  PageRequest,
  RepoRelativePath,
  Revision,
} from "../contracts/shared.js";
import { isRevision } from "../contracts/shared.js";
import {
  TEAM_READ_LIMITS,
  type InboxProposal,
  type PlaybookRunState,
  type PlaybookState,
  type Playbook,
  type PlaybookRun,
  type ProposalState,
  type Relay,
  type RelayState,
  type TeamPage,
  type Workstream,
  type WorkstreamState,
} from "../contracts/workflow.js";
import { artifactError } from "./errors.js";
import {
  assertContainedArtifactDirectory,
  atomicCreateArtifact,
  atomicReplaceArtifact,
  canonicalizeProjectRoot,
  readContainedArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "./filesystem.js";
import { revisionOf } from "./revision.js";
import { generateArtifactId } from "./ulid.js";
import { canonicalFileDiff } from "./unified-diff.js";
import {
  WORKFLOW_ARTIFACT_MAX_BYTES,
  inboxProposalArtifactPath,
  parseInboxProposalArtifact,
  parsePlaybookArtifact,
  parsePlaybookRunArtifact,
  parseRelayArtifact,
  parseWorkstreamArtifact,
  playbookArtifactPath,
  playbookRunArtifactPath,
  relayArtifactPath,
  serializeInboxProposalArtifact,
  serializePlaybookArtifact,
  serializePlaybookRunArtifact,
  serializeRelayArtifact,
  serializeWorkstreamArtifact,
  workstreamArtifactPath,
  type InboxProposalArtifactInput,
  type PlaybookArtifactInput,
  type PlaybookRunArtifactInput,
  type RelayArtifactInput,
  type WorkstreamArtifactInput,
} from "./workflow-codecs.js";

export const WORKFLOW_REPOSITORY_LIMITS = {
  maxDirectoryEntries: 4_096,
  maxRecords: 2_048,
  maxCorpusBytes: 32 * 1024 * 1024,
  maxCursorBytes: 4 * 1024,
  maxDiagnostics: 100,
} as const;

export interface WorkflowRepositoryOptions {
  idFactory?: () => string;
}

export interface WorkflowRepositoryListRequest<TState extends string = string>
  extends PageRequest {
  states?: readonly TState[];
  includeArchived?: boolean;
}

export interface WorkflowRepositoryPage<T> extends TeamPage<T> {
  diagnostics: readonly Diagnostic[];
}

interface WorkflowWritePlanBase<T> {
  previewRevision: Revision;
  artifact: T;
  change: FileChange;
  document: string;
  beforeDocument: string | null;
}

export type WorkflowArtifactWritePlan<T> =
  | (WorkflowWritePlanBase<T> & { kind: "create"; beforeRevision: null; beforeDocument: null })
  | (WorkflowWritePlanBase<T> & { kind: "update"; beforeRevision: Revision; beforeDocument: string });

export interface WorkflowArtifactWriteResult<T> {
  previewRevision: Revision;
  artifact: T;
  change: FileChange;
}

export type WorkstreamRepositoryCreateInput = Omit<WorkstreamArtifactInput, "id" | "entityRevision" | "state"> & { id?: string };
export type WorkstreamRepositoryUpdateInput = Omit<WorkstreamArtifactInput, "id" | "entityRevision">;
export type InboxProposalRepositoryCreateInput<TPayload> = Omit<
  InboxProposalArtifactInput<TPayload>,
  "id" | "state" | "reviewer" | "reviewRationale" | "reviewedAt"
> & { id?: string };
export type InboxProposalRepositoryUpdateInput<TPayload> = Omit<InboxProposalArtifactInput<TPayload>, "id">;
type RelayRepositoryCreateInputFor<TInput extends RelayArtifactInput> = Omit<
  TInput,
  "id" | "entityRevision" | "state" | "acknowledgedBy" | "acknowledgedAt" | "closedBy" | "closedAt"
> & { id?: string };
export type RelayRepositoryCreateInput = RelayArtifactInput extends infer TInput
  ? TInput extends RelayArtifactInput
    ? RelayRepositoryCreateInputFor<TInput>
    : never
  : never;
export type RelayRepositoryUpdateInput = RelayArtifactInput extends infer TInput
  ? TInput extends RelayArtifactInput
    ? Omit<TInput, "id" | "entityRevision">
    : never
  : never;
export type PlaybookRepositoryCreateInput = Omit<PlaybookArtifactInput, "id" | "entityRevision" | "state"> & { id?: string };
export type PlaybookRepositoryUpdateInput = Omit<PlaybookArtifactInput, "id" | "entityRevision">;
export type PlaybookRunRepositoryCreateInput = Omit<PlaybookRunArtifactInput, "id" | "entityRevision" | "state"> & { id?: string };
export type PlaybookRunRepositoryUpdateInput = Omit<PlaybookRunArtifactInput, "id" | "entityRevision">;

interface RepositoryCodec<TArtifact, TStored, TCreate, TUpdate> {
  directory: RepoRelativePath;
  lockName: string;
  path(id: string): RepoRelativePath;
  parse(bytes: string | Uint8Array, path: RepoRelativePath): TArtifact;
  serialize(input: TStored): string;
  idOf(artifact: TArtifact): string;
  revisionOf(artifact: TArtifact): Revision;
  sourcePathOf(artifact: TArtifact): RepoRelativePath;
  stateOf(artifact: TArtifact): string;
  states: readonly string[];
  archivedState: string | null;
  createInput(input: TCreate, id: string): TStored;
  updateInput(input: TUpdate, id: string, current: TArtifact): TStored;
  assertTransition(current: TArtifact, candidate: TArtifact): void;
}

class CanonicalWorkflowRepository<TArtifact, TStored, TCreate extends { id?: string }, TUpdate> {
  readonly #projectRoot: string;
  readonly #codec: RepositoryCodec<TArtifact, TStored, TCreate, TUpdate>;
  readonly #idFactory: () => string;

  constructor(projectRoot: string, codec: RepositoryCodec<TArtifact, TStored, TCreate, TUpdate>, idFactory: () => string) {
    this.#projectRoot = canonicalizeProjectRoot(projectRoot);
    this.#codec = codec;
    this.#idFactory = idFactory;
  }

  async get(id: string): Promise<TArtifact | null> {
    const path = this.#codec.path(id);
    const stored = tryReadContainedArtifact(this.#projectRoot, path, WORKFLOW_ARTIFACT_MAX_BYTES, "canonical");
    return stored === null ? null : this.#codec.parse(stored.bytes, path);
  }

  async list(request: WorkflowRepositoryListRequest = {}): Promise<WorkflowRepositoryPage<TArtifact>> {
    const limit = readLimit(request.limit);
    const filter = readFilter(request, this.#codec.states, this.#codec.archivedState);
    const paths = this.#scanPaths();
    const cursor = decodeCursor(request.cursor);
    if (cursor !== null && cursor.filterRevision !== filter.revision) {
      invalidCursor("Cursor was created for a different workflow artifact filter.");
    }
    let corpusBytes = 0;
    const revisions: { path: RepoRelativePath; revision: Revision }[] = [];
    const parsedPage: TArtifact[] = [];
    const afterIndex = cursor === null ? -1 : paths.indexOf(cursor.after);
    if (cursor !== null && afterIndex < 0) invalidCursor("Cursor target is not present in this artifact collection.");
    let matchingAfterCursor = 0;

    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]!;
      const stored = readContainedArtifact(this.#projectRoot, path, WORKFLOW_ARTIFACT_MAX_BYTES, "canonical");
      corpusBytes += stored.bytes.byteLength;
      if (corpusBytes > WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Workflow artifact corpus is too large",
          `Workflow artifact corpus exceeds ${WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes} bytes.`,
          path,
        );
      }
      revisions.push({ path, revision: stored.revision });
      const artifact = this.#codec.parse(stored.bytes, path);
      if (index <= afterIndex || !matchesFilter(this.#codec.stateOf(artifact), filter)) continue;
      matchingAfterCursor += 1;
      if (parsedPage.length < limit) parsedPage.push(artifact);
    }

    const deterministicRevision = revisionOf(JSON.stringify(revisions));
    if (cursor !== null && cursor.collectionRevision !== deterministicRevision) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Workflow artifact page changed",
        "The artifact collection changed after the previous page. Restart listing from the first page.",
      );
    }
    const hasMore = matchingAfterCursor > parsedPage.length;
    return {
      items: parsedPage,
      nextCursor: hasMore
        ? encodeCursor(
            this.#codec.sourcePathOf(parsedPage[parsedPage.length - 1]!),
            deterministicRevision,
            filter.revision,
          )
        : null,
      truncated: hasMore,
      sourceTruncated: false,
      deterministicRevision,
      diagnostics: [],
    };
  }

  async previewCreate(input: TCreate): Promise<WorkflowArtifactWritePlan<TArtifact>> {
    const id = input.id ?? this.#idFactory();
    const path = this.#codec.path(id);
    if (await this.get(id) !== null) {
      throw artifactError("REVISION_CONFLICT", "Workflow artifact already exists", `Artifact ${id} already exists.`, path);
    }
    const document = this.#codec.serialize(this.#codec.createInput(input, id));
    const artifact = this.#codec.parse(document, path);
    this.#assertWriteCapacity("create", path, document);
    const change: FileChange = {
      kind: "create", path, beforeRevision: null, afterRevision: this.#codec.revisionOf(artifact),
      diff: canonicalFileDiff(path, null, document),
    };
    return freezePlan({
      kind: "create", beforeRevision: null, beforeDocument: null, artifact, change, document,
      previewRevision: previewHash("create", null, change, null, document),
    });
  }

  async previewUpdate(id: string, input: TUpdate, expectedRevision: Revision): Promise<WorkflowArtifactWritePlan<TArtifact>> {
    if (!isRevision(expectedRevision)) {
      throw artifactError("VALIDATION_FAILED", "Invalid workflow artifact revision", "Expected revision must be a lower-case SHA-256 digest.");
    }
    const current = await this.get(id);
    if (current === null) throw artifactError("NOT_FOUND", "Workflow artifact not found", `Artifact ${id} does not exist.`);
    if (this.#codec.revisionOf(current) !== expectedRevision) {
      throw artifactError("REVISION_CONFLICT", "Workflow artifact revision conflict", `Artifact ${id} no longer matches the expected revision.`, this.#codec.sourcePathOf(current));
    }
    const read = readContainedArtifact(this.#projectRoot, this.#codec.sourcePathOf(current), WORKFLOW_ARTIFACT_MAX_BYTES, "canonical");
    if (read.revision !== expectedRevision) {
      throw artifactError("REVISION_CONFLICT", "Workflow artifact changed during preview", `Artifact ${id} changed while its preview was prepared.`, this.#codec.sourcePathOf(current));
    }
    const beforeDocument = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const document = this.#codec.serialize(this.#codec.updateInput(input, id, current));
    const candidate = this.#codec.parse(document, this.#codec.sourcePathOf(current));
    this.#codec.assertTransition(current, candidate);
    if (JSON.stringify(semanticArtifact(current)) === JSON.stringify(semanticArtifact(candidate))) {
      throw artifactError("VALIDATION_FAILED", "Workflow artifact is unchanged", `Artifact ${id} update produces no canonical change.`, this.#codec.sourcePathOf(current));
    }
    this.#assertWriteCapacity("update", this.#codec.sourcePathOf(current), document);
    const change: FileChange = {
      kind: "update", path: this.#codec.sourcePathOf(current), beforeRevision: expectedRevision,
      afterRevision: this.#codec.revisionOf(candidate), diff: canonicalFileDiff(this.#codec.sourcePathOf(current), beforeDocument, document),
    };
    return freezePlan({
      kind: "update", beforeRevision: expectedRevision, beforeDocument, artifact: candidate, change, document,
      previewRevision: previewHash("update", expectedRevision, change, beforeDocument, document),
    });
  }

  async apply(plan: WorkflowArtifactWritePlan<TArtifact>, expectedPreviewRevision: Revision): Promise<WorkflowArtifactWriteResult<TArtifact>> {
    const candidate = this.#assertPlan(plan, expectedPreviewRevision);
    return withContainedArtifactLock(this.#projectRoot, this.#codec.directory, this.#codec.lockName, async () => {
      const verified = this.#assertPlan(plan, expectedPreviewRevision);
      const id = this.#codec.idOf(verified);
      if (plan.kind === "create") {
        if (await this.get(id) !== null) throw artifactError("REVISION_CONFLICT", "Workflow artifact preview is stale", `Artifact ${id} was created after preview.`, this.#codec.sourcePathOf(verified));
        this.#assertWriteCapacity("create", this.#codec.sourcePathOf(verified), plan.document);
        atomicCreateArtifact(this.#projectRoot, this.#codec.sourcePathOf(verified), plan.document);
      } else {
        const current = await this.get(id);
        if (current === null || this.#codec.revisionOf(current) !== plan.beforeRevision) {
          throw artifactError("REVISION_CONFLICT", "Workflow artifact preview is stale", `Artifact ${id} changed after preview.`, this.#codec.sourcePathOf(verified));
        }
        this.#codec.assertTransition(current, verified);
        this.#assertWriteCapacity("update", this.#codec.sourcePathOf(verified), plan.document);
        atomicReplaceArtifact(
          this.#projectRoot,
          this.#codec.sourcePathOf(verified),
          plan.beforeRevision,
          plan.document,
          WORKFLOW_ARTIFACT_MAX_BYTES,
          "canonical",
        );
      }
      return { previewRevision: plan.previewRevision, artifact: candidate, change: plan.change };
    });
  }

  #assertPlan(plan: WorkflowArtifactWritePlan<TArtifact>, expectedPreviewRevision: Revision): TArtifact {
    if (!isRevision(expectedPreviewRevision) || plan.previewRevision !== expectedPreviewRevision) {
      throw artifactError("REVISION_CONFLICT", "Workflow preview revision conflict", "The workflow preview does not match the approved revision.");
    }
    const path = this.#codec.sourcePathOf(plan.artifact);
    const candidate = this.#codec.parse(plan.document, path);
    if (plan.kind === "create" && plan.beforeDocument !== null) invalidPlan();
    if (plan.kind === "update") {
      const before = this.#codec.parse(plan.beforeDocument, path);
      if (this.#codec.revisionOf(before) !== plan.beforeRevision || this.#codec.idOf(before) !== this.#codec.idOf(candidate)) invalidPlan();
    }
    const expectedChange: FileChange = plan.kind === "create"
      ? { kind: "create", path, beforeRevision: null, afterRevision: this.#codec.revisionOf(candidate), diff: canonicalFileDiff(path, null, plan.document) }
      : { kind: "update", path, beforeRevision: plan.beforeRevision, afterRevision: this.#codec.revisionOf(candidate), diff: canonicalFileDiff(path, plan.beforeDocument, plan.document) };
    const hash = previewHash(plan.kind, plan.beforeRevision, expectedChange, plan.beforeDocument, plan.document);
    if (hash !== plan.previewRevision || JSON.stringify(plan.change) !== JSON.stringify(expectedChange) || JSON.stringify(plan.artifact) !== JSON.stringify(candidate)) invalidPlan();
    return candidate;
  }

  #scanPaths(): RepoRelativePath[] {
    const directory = assertContainedArtifactDirectory(this.#projectRoot, this.#codec.directory);
    if (directory === null) return [];
    const handle = opendirSync(directory);
    const paths: RepoRelativePath[] = [];
    let entries = 0;
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        entries += 1;
        if (entries > WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries) {
          throw artifactError("VALIDATION_FAILED", "Workflow artifact directory is too large", `Directory exceeds ${WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries} entries.`, this.#codec.directory);
        }
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile()) {
          throw artifactError("PATH_OUTSIDE_PROJECT", "Unsafe workflow artifact", `Entry ${entry.name} must be a regular file.`, this.#codec.directory);
        }
        paths.push(`${this.#codec.directory}/${entry.name}` as RepoRelativePath);
        if (paths.length > WORKFLOW_REPOSITORY_LIMITS.maxRecords) {
          throw artifactError("VALIDATION_FAILED", "Workflow artifact collection is too large", `Collection exceeds ${WORKFLOW_REPOSITORY_LIMITS.maxRecords} records.`, this.#codec.directory);
        }
      }
    } finally {
      handle.closeSync();
    }
    return paths.sort(compare);
  }

  #assertWriteCapacity(
    kind: "create" | "update",
    targetPath: RepoRelativePath,
    document: string,
  ): void {
    const directory = assertContainedArtifactDirectory(this.#projectRoot, this.#codec.directory);
    const candidateBytes = Buffer.byteLength(document, "utf8");
    if (directory === null) {
      if (kind === "update") {
        throw artifactError(
          "REVISION_CONFLICT",
          "Workflow artifact preview is stale",
          `Artifact ${targetPath} disappeared while collection capacity was checked.`,
          targetPath,
        );
      }
      if (candidateBytes > WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Workflow artifact corpus is too large",
          `Workflow artifact corpus would exceed ${WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes} bytes.`,
          targetPath,
        );
      }
      return;
    }

    const handle = opendirSync(directory);
    let directoryEntries = 0;
    let records = 0;
    let projectedCorpusBytes = candidateBytes;
    let foundTarget = false;
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        // The collection lock is transient and cannot remain after this operation.
        if (entry.name === this.#codec.lockName) continue;
        directoryEntries += 1;
        if (directoryEntries > WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Workflow artifact directory is too large",
            `Directory exceeds ${WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries} entries.`,
            this.#codec.directory,
          );
        }
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile()) {
          throw artifactError(
            "PATH_OUTSIDE_PROJECT",
            "Unsafe workflow artifact",
            `Entry ${entry.name} must be a regular file.`,
            this.#codec.directory,
          );
        }
        records += 1;
        if (records > WORKFLOW_REPOSITORY_LIMITS.maxRecords) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Workflow artifact collection is too large",
            `Collection exceeds ${WORKFLOW_REPOSITORY_LIMITS.maxRecords} records.`,
            this.#codec.directory,
          );
        }
        const path = `${this.#codec.directory}/${entry.name}` as RepoRelativePath;
        if (path === targetPath) {
          foundTarget = true;
          if (kind === "create") {
            throw artifactError(
              "REVISION_CONFLICT",
              "Workflow artifact preview is stale",
              `Artifact ${targetPath} already exists.`,
              targetPath,
            );
          }
          continue;
        }
        projectedCorpusBytes += readContainedArtifact(
          this.#projectRoot,
          path,
          WORKFLOW_ARTIFACT_MAX_BYTES,
          "canonical",
        ).bytes.byteLength;
        if (projectedCorpusBytes > WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes) {
          throw artifactError(
            "VALIDATION_FAILED",
            "Workflow artifact corpus is too large",
            `Workflow artifact corpus would exceed ${WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes} bytes.`,
            targetPath,
          );
        }
      }
    } finally {
      handle.closeSync();
    }

    const projectedEntries = directoryEntries + (kind === "create" ? 1 : 0);
    const projectedRecords = records + (kind === "create" ? 1 : 0);
    if (projectedEntries > WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Workflow artifact directory is full",
        `Creating ${targetPath} would exceed ${WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries} directory entries.`,
        targetPath,
      );
    }
    if (projectedRecords > WORKFLOW_REPOSITORY_LIMITS.maxRecords) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Workflow artifact collection is full",
        `Creating ${targetPath} would exceed ${WORKFLOW_REPOSITORY_LIMITS.maxRecords} records.`,
        targetPath,
      );
    }
    if (kind === "update" && !foundTarget) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Workflow artifact preview is stale",
        `Artifact ${targetPath} disappeared while collection capacity was checked.`,
        targetPath,
      );
    }
    if (projectedCorpusBytes > WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Workflow artifact corpus is too large",
        `Workflow artifact corpus would exceed ${WORKFLOW_REPOSITORY_LIMITS.maxCorpusBytes} bytes.`,
        targetPath,
      );
    }
  }
}

/** Canonical `.mex/workstreams/<ws-id>.md` repository. */
export class WorkstreamRepository {
  readonly #repository: CanonicalWorkflowRepository<Workstream, WorkstreamArtifactInput, WorkstreamRepositoryCreateInput, WorkstreamRepositoryUpdateInput>;

  constructor(projectRoot: string, options: WorkflowRepositoryOptions = {}) {
    this.#repository = new CanonicalWorkflowRepository(projectRoot, workstreamCodec, options.idFactory ?? (() => generateArtifactId("ws")));
  }

  get(id: string): Promise<Workstream | null> { return this.#repository.get(id); }
  list(request?: WorkflowRepositoryListRequest<WorkstreamState>): Promise<WorkflowRepositoryPage<Workstream>> { return this.#repository.list(request); }
  previewCreate(input: WorkstreamRepositoryCreateInput): Promise<WorkflowArtifactWritePlan<Workstream>> { return this.#repository.previewCreate(input); }
  previewUpdate(id: string, input: WorkstreamRepositoryUpdateInput, expectedRevision: Revision): Promise<WorkflowArtifactWritePlan<Workstream>> { return this.#repository.previewUpdate(id, input, expectedRevision); }
  apply(plan: WorkflowArtifactWritePlan<Workstream>, expectedPreviewRevision: Revision): Promise<WorkflowArtifactWriteResult<Workstream>> { return this.#repository.apply(plan, expectedPreviewRevision); }
}

/** Canonical `.mex/inbox/<proposal-id>.md` repository. */
export class InboxProposalRepository<TPayload> {
  readonly #repository: CanonicalWorkflowRepository<InboxProposal<TPayload>, InboxProposalArtifactInput<TPayload>, InboxProposalRepositoryCreateInput<TPayload>, InboxProposalRepositoryUpdateInput<TPayload>>;

  constructor(projectRoot: string, options: WorkflowRepositoryOptions = {}) {
    this.#repository = new CanonicalWorkflowRepository(projectRoot, proposalCodec<TPayload>(), options.idFactory ?? (() => generateArtifactId("proposal")));
  }

  get(id: string): Promise<InboxProposal<TPayload> | null> { return this.#repository.get(id); }
  list(request?: WorkflowRepositoryListRequest<ProposalState>): Promise<WorkflowRepositoryPage<InboxProposal<TPayload>>> { return this.#repository.list(request); }
  previewCreate(input: InboxProposalRepositoryCreateInput<TPayload>): Promise<WorkflowArtifactWritePlan<InboxProposal<TPayload>>> { return this.#repository.previewCreate(input); }
  previewUpdate(id: string, input: InboxProposalRepositoryUpdateInput<TPayload>, expectedRevision: Revision): Promise<WorkflowArtifactWritePlan<InboxProposal<TPayload>>> { return this.#repository.previewUpdate(id, input, expectedRevision); }
  apply(plan: WorkflowArtifactWritePlan<InboxProposal<TPayload>>, expectedPreviewRevision: Revision): Promise<WorkflowArtifactWriteResult<InboxProposal<TPayload>>> { return this.#repository.apply(plan, expectedPreviewRevision); }
}

/** Canonical `.mex/relays/<relay-id>.md` repository. */
export class RelayRepository {
  readonly #repository: CanonicalWorkflowRepository<Relay, RelayArtifactInput, RelayRepositoryCreateInput, RelayRepositoryUpdateInput>;

  constructor(projectRoot: string, options: WorkflowRepositoryOptions = {}) {
    this.#repository = new CanonicalWorkflowRepository(projectRoot, relayCodec, options.idFactory ?? (() => generateArtifactId("relay")));
  }

  get(id: string): Promise<Relay | null> { return this.#repository.get(id); }
  list(request?: WorkflowRepositoryListRequest<RelayState>): Promise<WorkflowRepositoryPage<Relay>> { return this.#repository.list(request); }
  previewCreate(input: RelayRepositoryCreateInput): Promise<WorkflowArtifactWritePlan<Relay>> { return this.#repository.previewCreate(input); }
  previewUpdate(id: string, input: RelayRepositoryUpdateInput, expectedRevision: Revision): Promise<WorkflowArtifactWritePlan<Relay>> { return this.#repository.previewUpdate(id, input, expectedRevision); }
  apply(plan: WorkflowArtifactWritePlan<Relay>, expectedPreviewRevision: Revision): Promise<WorkflowArtifactWriteResult<Relay>> { return this.#repository.apply(plan, expectedPreviewRevision); }
}

/** Canonical `.mex/playbooks/<playbook-id>.md` repository. */
export class PlaybookRepository {
  readonly #repository: CanonicalWorkflowRepository<Playbook, PlaybookArtifactInput, PlaybookRepositoryCreateInput, PlaybookRepositoryUpdateInput>;

  constructor(projectRoot: string, options: WorkflowRepositoryOptions = {}) {
    this.#repository = new CanonicalWorkflowRepository(projectRoot, playbookCodec, options.idFactory ?? (() => generateArtifactId("playbook")));
  }

  get(id: string): Promise<Playbook | null> { return this.#repository.get(id); }
  list(request?: WorkflowRepositoryListRequest<PlaybookState>): Promise<WorkflowRepositoryPage<Playbook>> { return this.#repository.list(request); }
  previewCreate(input: PlaybookRepositoryCreateInput): Promise<WorkflowArtifactWritePlan<Playbook>> { return this.#repository.previewCreate(input); }
  previewUpdate(id: string, input: PlaybookRepositoryUpdateInput, expectedRevision: Revision): Promise<WorkflowArtifactWritePlan<Playbook>> { return this.#repository.previewUpdate(id, input, expectedRevision); }
  apply(plan: WorkflowArtifactWritePlan<Playbook>, expectedPreviewRevision: Revision): Promise<WorkflowArtifactWriteResult<Playbook>> { return this.#repository.apply(plan, expectedPreviewRevision); }
}

/** Canonical `.mex/playbooks/runs/<run-id>.md` repository. */
export class PlaybookRunRepository {
  readonly #repository: CanonicalWorkflowRepository<PlaybookRun, PlaybookRunArtifactInput, PlaybookRunRepositoryCreateInput, PlaybookRunRepositoryUpdateInput>;

  constructor(projectRoot: string, options: WorkflowRepositoryOptions = {}) {
    this.#repository = new CanonicalWorkflowRepository(projectRoot, runCodec, options.idFactory ?? (() => generateArtifactId("run")));
  }

  get(id: string): Promise<PlaybookRun | null> { return this.#repository.get(id); }
  list(request?: WorkflowRepositoryListRequest<PlaybookRunState>): Promise<WorkflowRepositoryPage<PlaybookRun>> { return this.#repository.list(request); }
  previewCreate(input: PlaybookRunRepositoryCreateInput): Promise<WorkflowArtifactWritePlan<PlaybookRun>> { return this.#repository.previewCreate(input); }
  previewUpdate(id: string, input: PlaybookRunRepositoryUpdateInput, expectedRevision: Revision): Promise<WorkflowArtifactWritePlan<PlaybookRun>> { return this.#repository.previewUpdate(id, input, expectedRevision); }
  apply(plan: WorkflowArtifactWritePlan<PlaybookRun>, expectedPreviewRevision: Revision): Promise<WorkflowArtifactWriteResult<PlaybookRun>> { return this.#repository.apply(plan, expectedPreviewRevision); }
}

const workstreamCodec: RepositoryCodec<Workstream, WorkstreamArtifactInput, WorkstreamRepositoryCreateInput, WorkstreamRepositoryUpdateInput> = {
  directory: ".mex/workstreams", lockName: ".workstreams.mex-lock", path: workstreamArtifactPath,
  parse: parseWorkstreamArtifact, serialize: serializeWorkstreamArtifact,
  idOf: (artifact) => artifact.ref.id, revisionOf: (artifact) => artifact.revision, sourcePathOf: (artifact) => artifact.sourcePath,
  stateOf: (artifact) => artifact.state,
  states: ["planned", "active", "blocked", "done", "archived"], archivedState: "archived",
  createInput: (input, id) => ({ ...input, id, entityRevision: 1, state: "planned" }),
  updateInput: (input, id, current) => ({ ...input, id, entityRevision: current.entityRevision + 1 }),
  assertTransition: (current, candidate) => {
    assertStateTransition(current.state, candidate.state, WORKSTREAM_TRANSITIONS, "workstream");
    if (JSON.stringify(current.createdBy) !== JSON.stringify(candidate.createdBy) || current.createdAt !== candidate.createdAt) {
      invalidUpdate("Workstream creator and creation time are immutable.");
    }
    if (current.state === "archived") invalidUpdate("Archived workstreams are immutable.");
  },
};

function proposalCodec<TPayload>(): RepositoryCodec<InboxProposal<TPayload>, InboxProposalArtifactInput<TPayload>, InboxProposalRepositoryCreateInput<TPayload>, InboxProposalRepositoryUpdateInput<TPayload>> {
  return {
    directory: ".mex/inbox", lockName: ".inbox.mex-lock", path: inboxProposalArtifactPath,
    parse: parseInboxProposalArtifact<TPayload>, serialize: serializeInboxProposalArtifact,
    idOf: (artifact) => artifact.ref.id, revisionOf: (artifact) => artifact.revision, sourcePathOf: (artifact) => artifact.sourcePath,
    stateOf: (artifact) => artifact.state,
    states: ["pending", "approved", "rejected", "withdrawn", "stale"], archivedState: null,
    createInput: (input, id) => ({ ...input, id, state: "pending" }), updateInput: (input, id) => ({ ...input, id }),
    assertTransition: (current, candidate) => {
      if (current.state === "approved" || current.state === "rejected" || current.state === "withdrawn") {
        invalidUpdate("Reviewed or withdrawn inbox proposals are immutable.");
      }
      assertStateTransition(current.state, candidate.state, PROPOSAL_TRANSITIONS, "inbox proposal");
      if (JSON.stringify(current.author) !== JSON.stringify(candidate.author)) invalidUpdate("Inbox proposal author is immutable.");
      if (current.state !== "stale" && JSON.stringify(current.request) !== JSON.stringify(candidate.request)) {
        invalidUpdate("Inbox proposal request may only change while repairing a stale proposal.");
      }
    },
  };
}

const relayCodec: RepositoryCodec<Relay, RelayArtifactInput, RelayRepositoryCreateInput, RelayRepositoryUpdateInput> = {
  directory: ".mex/relays", lockName: ".relays.mex-lock", path: relayArtifactPath,
  parse: parseRelayArtifact, serialize: serializeRelayArtifact,
  idOf: (artifact) => artifact.ref.id, revisionOf: (artifact) => artifact.revision, sourcePathOf: (artifact) => artifact.sourcePath,
  stateOf: (artifact) => artifact.state,
  states: ["published", "acknowledged", "closed"], archivedState: null,
  createInput: (input, id) => ({
    ...input,
    id,
    entityRevision: 1,
    state: "published",
  }) as RelayArtifactInput,
  updateInput: (input, id, current) => ({
    ...input,
    id,
    entityRevision: current.entityRevision + 1,
  }) as RelayArtifactInput,
  assertTransition: (current, candidate) => {
    assertStateTransition(current.state, candidate.state, RELAY_TRANSITIONS, "relay");
    if (
      current.schemaVersion !== candidate.schemaVersion
      || JSON.stringify(current.sender) !== JSON.stringify(candidate.sender)
    ) {
      invalidUpdate("Relay schema, sender, and publication context are immutable.");
    }
    if (JSON.stringify(relayContent(current)) !== JSON.stringify(relayContent(candidate))) {
      invalidUpdate("Published relay content is immutable; only acknowledgement and close authority may change.");
    }
    if (current.acknowledgedBy !== undefined && (
      JSON.stringify(current.acknowledgedBy) !== JSON.stringify(candidate.acknowledgedBy)
      || current.acknowledgedAt !== candidate.acknowledgedAt
    )) invalidUpdate("Relay acknowledgement authority is immutable once recorded.");
    if (current.state === "closed") invalidUpdate("Closed relays are immutable.");
  },
};

const playbookCodec: RepositoryCodec<Playbook, PlaybookArtifactInput, PlaybookRepositoryCreateInput, PlaybookRepositoryUpdateInput> = {
  directory: ".mex/playbooks", lockName: ".playbooks.mex-lock", path: playbookArtifactPath,
  parse: parsePlaybookArtifact, serialize: serializePlaybookArtifact,
  idOf: (artifact) => artifact.ref.id, revisionOf: (artifact) => artifact.revision, sourcePathOf: (artifact) => artifact.sourcePath,
  stateOf: (artifact) => artifact.state,
  states: ["active", "archived"], archivedState: "archived",
  createInput: (input, id) => ({ ...input, id, entityRevision: 1, state: "active" }),
  updateInput: (input, id, current) => ({ ...input, id, entityRevision: current.entityRevision + 1 }),
  assertTransition: (current, candidate) => {
    assertStateTransition(current.state, candidate.state, PLAYBOOK_TRANSITIONS, "playbook");
    if (current.state === "archived") invalidUpdate("Archived playbooks are immutable.");
  },
};

const runCodec: RepositoryCodec<PlaybookRun, PlaybookRunArtifactInput, PlaybookRunRepositoryCreateInput, PlaybookRunRepositoryUpdateInput> = {
  directory: ".mex/playbooks/runs", lockName: ".runs.mex-lock", path: playbookRunArtifactPath,
  parse: parsePlaybookRunArtifact, serialize: serializePlaybookRunArtifact,
  idOf: (artifact) => artifact.ref.id, revisionOf: (artifact) => artifact.revision, sourcePathOf: (artifact) => artifact.sourcePath,
  stateOf: (artifact) => artifact.state,
  states: ["active", "completed"], archivedState: null,
  createInput: (input, id) => ({ ...input, id, entityRevision: 1, state: "active" }),
  updateInput: (input, id, current) => ({ ...input, id, entityRevision: current.entityRevision + 1 }),
  assertTransition: (current, candidate) => {
    assertStateTransition(current.state, candidate.state, RUN_TRANSITIONS, "playbook run");
    if (JSON.stringify(current.playbook) !== JSON.stringify(candidate.playbook)
      || JSON.stringify(current.workstream) !== JSON.stringify(candidate.workstream)
      || JSON.stringify(current.startedBy) !== JSON.stringify(candidate.startedBy)
      || current.startedAt !== candidate.startedAt
      || current.steps.map((step) => step.stepId).join("\0") !== candidate.steps.map((step) => step.stepId).join("\0")) {
      invalidUpdate("Playbook run identity, authority, and step set are immutable.");
    }
    if (current.state === "completed") invalidUpdate("Completed playbook runs are immutable.");
    let newlyCompleted = 0;
    for (let index = 0; index < current.steps.length; index += 1) {
      const before = current.steps[index]!;
      const after = candidate.steps[index]!;
      if (before.completedBy !== undefined) {
        if (JSON.stringify(before) !== JSON.stringify(after)) invalidUpdate("Completed playbook run steps are immutable.");
      } else if (after.completedBy !== undefined) {
        newlyCompleted += 1;
      }
    }
    if (newlyCompleted !== 1) invalidUpdate("Each playbook run update must complete exactly one step.");
  },
};

const WORKSTREAM_TRANSITIONS = {
  planned: ["planned", "active", "archived"],
  active: ["active", "blocked", "done", "archived"],
  blocked: ["blocked", "active", "done", "archived"],
  done: ["done", "archived"],
  archived: ["archived"],
} as const;
const PROPOSAL_TRANSITIONS = {
  pending: ["pending", "approved", "rejected", "withdrawn", "stale"],
  stale: ["stale", "pending"],
  approved: ["approved"], rejected: ["rejected"], withdrawn: ["withdrawn"],
} as const;
const RELAY_TRANSITIONS = {
  published: ["published", "acknowledged"], acknowledged: ["acknowledged", "closed"], closed: ["closed"],
} as const;
const PLAYBOOK_TRANSITIONS = { active: ["active", "archived"], archived: ["archived"] } as const;
const RUN_TRANSITIONS = { active: ["active", "completed"], completed: ["completed"] } as const;

function assertStateTransition<TState extends string>(
  before: TState,
  after: TState,
  transitions: Readonly<Record<TState, readonly TState[]>>,
  label: string,
): void {
  if (!transitions[before].includes(after)) invalidUpdate(`Invalid ${label} lifecycle transition ${before} -> ${after}.`);
}

interface PageCursor {
  v: 1;
  after: RepoRelativePath;
  collectionRevision: Revision;
  filterRevision: Revision;
}

function encodeCursor(after: RepoRelativePath, collectionRevision: Revision, filterRevision: Revision): string {
  return Buffer.from(JSON.stringify({ v: 1, after, collectionRevision, filterRevision } satisfies PageCursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): PageCursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > WORKFLOW_REPOSITORY_LIMITS.maxCursorBytes) invalidCursor("Cursor is invalid or too large.");
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength > WORKFLOW_REPOSITORY_LIMITS.maxCursorBytes || decoded.toString("base64url") !== value) invalidCursor("Cursor encoding is invalid.");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)) as unknown;
    if (!isRecord(parsed) || Object.keys(parsed).sort(compare).join(",") !== "after,collectionRevision,filterRevision,v"
      || parsed.v !== 1 || typeof parsed.after !== "string" || typeof parsed.collectionRevision !== "string"
      || typeof parsed.filterRevision !== "string" || !isRevision(parsed.collectionRevision)
      || !isRevision(parsed.filterRevision) || !parsed.after.endsWith(".md")) invalidCursor("Cursor payload is invalid.");
    return parsed as unknown as PageCursor;
  } catch (error) {
    if (error instanceof Error && error.name === "MexPortError") throw error;
    invalidCursor("Cursor payload is invalid.");
  }
}

interface NormalizedFilter {
  states: readonly string[] | null;
  includeArchived: boolean;
  archivedState: string | null;
  revision: Revision;
}

function readFilter(
  request: WorkflowRepositoryListRequest,
  allowedStates: readonly string[],
  archivedState: string | null,
): NormalizedFilter {
  if (request.includeArchived !== undefined && typeof request.includeArchived !== "boolean") {
    throw artifactError("INVALID_REQUEST", "Invalid workflow artifact filter", "includeArchived must be a boolean.");
  }
  let states: readonly string[] | null = null;
  if (request.states !== undefined) {
    if (!Array.isArray(request.states) || request.states.length === 0 || request.states.length > allowedStates.length) {
      throw artifactError("INVALID_REQUEST", "Invalid workflow artifact filter", `states must contain between 1 and ${allowedStates.length} values.`);
    }
    states = [...request.states].sort(compare);
    if (new Set(states).size !== states.length || states.some((state) => !allowedStates.includes(state))) {
      throw artifactError("INVALID_REQUEST", "Invalid workflow artifact filter", "states contains a duplicate or unsupported workflow state.");
    }
  }
  const includeArchived = request.includeArchived ?? false;
  return {
    states,
    includeArchived,
    archivedState,
    revision: revisionOf(JSON.stringify({ v: 1, states, includeArchived, archivedState })),
  };
}

function matchesFilter(state: string, filter: NormalizedFilter): boolean {
  if (filter.states !== null) return filter.states.includes(state);
  return filter.includeArchived || filter.archivedState === null || state !== filter.archivedState;
}

function readLimit(value: number | undefined): number {
  if (value === undefined) return TEAM_READ_LIMITS.defaultPageSize;
  if (!Number.isInteger(value) || value < 1 || value > TEAM_READ_LIMITS.maxPageSize) {
    throw artifactError("INVALID_REQUEST", "Invalid workflow page size", `Page size must be between 1 and ${TEAM_READ_LIMITS.maxPageSize}.`);
  }
  return value;
}

function previewHash(kind: "create" | "update", beforeRevision: Revision | null, change: FileChange, beforeDocument: string | null, document: string): Revision {
  return revisionOf(JSON.stringify({ kind, beforeRevision, change, beforeDocument, document }));
}

function semanticArtifact(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const {
    schemaVersion: _schemaVersion,
    ref: _ref,
    kind: _kind,
    sourcePath: _sourcePath,
    revision: _revision,
    entityRevision: _entityRevision,
    ...semantic
  } = value;
  return semantic;
}

function relayContent(value: Relay): unknown {
  const semantic = semanticArtifact(value) as Record<string, unknown>;
  const {
    state: _state,
    acknowledgedBy: _acknowledgedBy,
    acknowledgedAt: _acknowledgedAt,
    closedBy: _closedBy,
    closedAt: _closedAt,
    ...content
  } = semantic;
  return content;
}

function freezePlan<T, TPlan extends WorkflowArtifactWritePlan<T>>(plan: TPlan): TPlan {
  Object.freeze(plan.change);
  Object.freeze(plan.artifact);
  return Object.freeze(plan);
}

function invalidPlan(): never {
  throw artifactError("VALIDATION_FAILED", "Invalid workflow preview", "The workflow preview payload was modified after it was produced.");
}

function invalidUpdate(detail: string): never {
  throw artifactError("VALIDATION_FAILED", "Invalid workflow artifact update", detail);
}

function invalidCursor(detail: string): never {
  throw artifactError("INVALID_REQUEST", "Invalid workflow page cursor", detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
