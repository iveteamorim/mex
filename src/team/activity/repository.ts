import { opendirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import type {
  Diagnostic,
  EntityRef,
  FileChange,
  JsonValue,
  RepoRelativePath,
  RepoState,
  Revision,
} from "../contracts/shared.js";
import { MexPortError } from "../contracts/shared.js";
import type { GitPort } from "../contracts/git.js";
import type {
  ActivityEvent,
  ActivitySubjectRef,
  StoredActivityEvent,
} from "../contracts/workflow.js";
import {
  ACTIVITY_ARTIFACT_MAX_BYTES,
  activityArtifactPath,
  parseActivityArtifact,
  serializeActivityArtifact,
} from "../artifacts/codecs.js";
import { artifactError } from "../artifacts/errors.js";
import {
  assertContainedArtifactDirectory,
  atomicCreateArtifact,
  readContainedArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../artifacts/filesystem.js";
import { revisionOf } from "../artifacts/revision.js";
import { canonicalFileDiff } from "../artifacts/unified-diff.js";
import { generateArtifactId, isArtifactId } from "../artifacts/ulid.js";
import type { ActorResolver } from "../identity/actor-resolver.js";
import { readLegacyTimeline } from "./legacy.js";
import {
  buildTimelinePage,
  type TimelinePage,
  type TimelineRequest,
} from "./timeline.js";

const ACTIVITY_ROOT = ".mex/events/activity" as RepoRelativePath;
const ACTIVITY_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const ACTIVITY_FILE = /^(event_[0-9A-HJKMNP-TV-Z]{26})\.md$/;
const MAX_ISSUED_ACTIVITY_PREVIEWS = 256;
const ACTIVITY_LOCK_NAME = ".activity.mex-lock";
const ACTIVITY_INTERNAL_ROOT_ENTRIES = new Set([
  ACTIVITY_LOCK_NAME,
  `${ACTIVITY_LOCK_NAME}.recovery`,
]);

export const ACTIVITY_REPOSITORY_LIMITS = Object.freeze({
  maxDirectoryEntries: 4_096,
  maxRecords: 2_048,
  maxCorpusBytes: 32 * 1024 * 1024,
  maxDiagnostics: 100,
});

export interface ActivityCreateInput {
  actor: ActivityEvent["actor"];
  action: string;
  subjects: readonly ActivitySubjectRef[];
  workstream?: EntityRef;
  metadata?: Readonly<Record<string, JsonValue>>;
}

/** Service-owned provenance for a new schema-v2 Activity event. */
export interface ActivityCreateProvenance {
  origin: Extract<ActivityEvent, { schemaVersion: 2 }>["origin"];
  label?: string;
}

export interface ActivityCreatePreview {
  event: ActivityEvent;
  sourcePath: RepoRelativePath;
  revision: Revision;
  previewRevision: Revision;
  changes: readonly [FileChange];
}

/** Service-captured authority for a workflow event prepared outside this repository. */
export interface PreparedActivityAuthority {
  timestamp: string;
  repoState: RepoState;
}

/**
 * Single-use publication prepared after the live Git checkpoint is validated.
 * The enclosing workflow may publish its primary canonical artifact before
 * invoking `publish`; doing so cannot make the reviewed Activity provenance
 * appear stale merely because that exact workflow dirtied the checkout.
 */
export interface PreparedActivityPublication {
  previewRevision: Revision;
  publish(): Promise<StoredActivityEvent>;
}

export interface ActivityReadResult {
  events: readonly StoredActivityEvent[];
  diagnostics: readonly Diagnostic[];
  sourceTruncated: boolean;
  /** IDs whose requested canonical candidates were malformed or conflicting. */
  untrustedIds: readonly string[];
}

interface ActivityCorpusScan extends ActivityReadResult {
  directoryEntries: number;
  recordCount: number;
  corpusBytes: number;
  months: ReadonlySet<string>;
}

export interface ActivityListPage {
  items: readonly StoredActivityEvent[];
  nextCursor: string | null;
  truncated: boolean;
  sourceTruncated: boolean;
  deterministicRevision: Revision;
  diagnostics: readonly Diagnostic[];
}

export interface ActivityRepositoryOptions {
  projectRoot: string;
  git: GitPort;
  now?: () => Date;
  generateId?: (timestampMs: number) => string;
}

/** Canonical create-only activity storage; repository provenance always comes from GitPort. */
export class ActivityRepository {
  private readonly projectRoot: string;
  private readonly git: GitPort;
  private readonly now: () => Date;
  private readonly generateId: (timestampMs: number) => string;
  private readonly issuedPreviews = new Map<Revision, { preview: ActivityCreatePreview; bytes: string }>();

  constructor(options: ActivityRepositoryOptions) {
    this.projectRoot = bindProjectRoot(options.projectRoot);
    this.git = options.git;
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId
      ?? ((timestampMs) => generateArtifactId("event", { now: timestampMs }));
  }

  async previewCreate(input: ActivityCreateInput): Promise<ActivityCreatePreview> {
    const now = this.now();
    if (Number.isNaN(now.getTime())) {
      throw artifactError("VALIDATION_FAILED", "Invalid activity event", "Activity clock is invalid.");
    }
    return this.previewCreateWithAuthority(input, {
      timestamp: now.toISOString(),
      repoState: await this.git.getRepoState(),
    }, undefined, { origin: { kind: "custom" } });
  }

  /**
   * Prepare an event from authority captured by the enclosing workflow service.
   * Callers cannot publish arbitrary authority: apply still revalidates the
   * exact issued preview and the live repository branch/HEAD/dirty checkpoint.
   */
  async previewCreateWithAuthority(
    input: ActivityCreateInput,
    authority: PreparedActivityAuthority,
    eventId?: string,
    provenance: ActivityCreateProvenance = { origin: { kind: "custom" } },
  ): Promise<ActivityCreatePreview> {
    const timestampDate = new Date(authority.timestamp);
    if (
      Number.isNaN(timestampDate.getTime())
      || timestampDate.toISOString() !== authority.timestamp
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid activity event",
        "Activity authority timestamp must be a canonical ISO timestamp.",
      );
    }
    const id = eventId ?? this.generateId(timestampDate.getTime());
    if (!isArtifactId(id, "event")) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid activity event ID",
        "The workflow-owned Activity event ID must be an event_ prefixed ULID.",
      );
    }
    const event: ActivityEvent = {
      schemaVersion: 2,
      id,
      timestamp: authority.timestamp,
      actor: input.actor,
      action: input.action,
      subjects: input.subjects,
      ...(input.workstream === undefined ? {} : { workstream: input.workstream }),
      repoState: { ...authority.repoState },
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      origin: provenance.origin,
      ...(provenance.label === undefined ? {} : { label: provenance.label }),
    };
    const issued = previewFor(event);
    this.#assertCapacityFor(issued.preview, issued.bytes);
    this.issuedPreviews.set(issued.preview.previewRevision, issued);
    if (this.issuedPreviews.size > MAX_ISSUED_ACTIVITY_PREVIEWS) {
      const oldest = this.issuedPreviews.keys().next().value as Revision | undefined;
      if (oldest !== undefined) this.issuedPreviews.delete(oldest);
    }
    return issued.preview;
  }

  async applyCreate(
    preview: ActivityCreatePreview,
    expectedPreviewRevision: Revision,
  ): Promise<StoredActivityEvent> {
    return (await this.prepareApplyCreate(preview, expectedPreviewRevision)).publish();
  }

  /** Validate the exact issued preview and live Git checkpoint without writing. */
  async prepareApplyCreate(
    preview: ActivityCreatePreview,
    expectedPreviewRevision: Revision,
  ): Promise<PreparedActivityPublication> {
    const issued = this.issuedPreviews.get(expectedPreviewRevision);
    if (issued === undefined) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Activity preview is unavailable",
        "The activity preview was not issued by this repository instance or has expired.",
        preview.sourcePath,
      );
    }
    const verified = previewFor(preview.event);
    if (
      expectedPreviewRevision !== verified.preview.previewRevision
      || preview.previewRevision !== verified.preview.previewRevision
      || preview.sourcePath !== verified.preview.sourcePath
      || preview.revision !== verified.preview.revision
      || JSON.stringify(preview.changes) !== JSON.stringify(verified.preview.changes)
      || issued.bytes !== verified.bytes
    ) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Activity preview changed",
        "The activity preview does not match the operation being applied.",
        verified.preview.sourcePath,
      );
    }

    const currentRepo = await this.git.getRepoState();
    if (!sameRepoCheckpoint(preview.event.repoState, currentRepo)) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Repository changed",
        "Repository branch, HEAD, or dirty state changed after activity preview.",
        preview.sourcePath,
      );
    }
    this.#assertCapacityFor(issued.preview, issued.bytes);

    let consumed = false;
    return Object.freeze({
      previewRevision: expectedPreviewRevision,
      publish: async (): Promise<StoredActivityEvent> => {
        if (consumed) {
          throw artifactError(
            "REVISION_CONFLICT",
            "Activity publication was already consumed",
            "The prepared Activity publication is single-use.",
            preview.sourcePath,
          );
        }
        const stored = await this.#publishWithCapacity(issued.preview, issued.bytes);
        consumed = true;
        this.issuedPreviews.delete(expectedPreviewRevision);
        return stored;
      },
    });
  }

  /**
   * Complete an Activity effect only after the workflow service has verified a
   * durable journal entry and all preceding canonical effects. This accepts no
   * caller-supplied path or bytes: both are derived from the strict event codec.
   */
  async recoverJournaledCreate(
    event: ActivityEvent,
    expectedRevision: Revision,
  ): Promise<StoredActivityEvent> {
    const verified = previewFor(event);
    if (verified.preview.revision !== expectedRevision) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Activity recovery revision conflict",
        "The journaled Activity event does not match its expected revision.",
        verified.preview.sourcePath,
      );
    }
    return this.#publishWithCapacity(verified.preview, verified.bytes);
  }

  get(id: string): StoredActivityEvent | null {
    if (!isArtifactId(id, "event")) {
      throw artifactError("INVALID_REQUEST", "Invalid activity ID", "Activity ID must be an event_ prefixed ULID.");
    }
    const read = this.readAll();
    if (read.sourceTruncated) throw activitySourceTruncated();
    if (read.untrustedIds.includes(id)) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Activity record is untrusted",
        "The requested canonical Activity ID has a malformed or conflicting record.",
      );
    }
    return read.events.find((event) => event.id === id) ?? null;
  }

  list(request: TimelineRequest = {}): ActivityListPage {
    const read = this.readAll();
    const page = buildTimelinePage(read.events, [], read.diagnostics, {
      ...request,
      source: "activity",
    }, read.sourceTruncated);
    return {
      items: page.items.map((entry) => {
        if (entry.source !== "activity") throw new Error("Unexpected legacy activity entry.");
        return entry.event;
      }),
      nextCursor: page.nextCursor,
      truncated: page.truncated,
      sourceTruncated: page.sourceTruncated,
      deterministicRevision: page.deterministicRevision,
      diagnostics: page.diagnostics,
    };
  }

  readAll(): ActivityReadResult {
    const scan = this.#scanCorpus();
    return {
      events: scan.events,
      diagnostics: scan.diagnostics,
      sourceTruncated: scan.sourceTruncated,
      untrustedIds: scan.untrustedIds,
    };
  }

  #scanCorpus(ignoreInternalLockEntries = false): ActivityCorpusScan {
    const root = assertContainedArtifactDirectory(this.projectRoot, ACTIVITY_ROOT);
    if (root === null) {
      return {
        events: [],
        diagnostics: [],
        sourceTruncated: false,
        untrustedIds: [],
        directoryEntries: 0,
        recordCount: 0,
        corpusBytes: 0,
        months: new Set(),
      };
    }

    const parsed: StoredActivityEvent[] = [];
    const diagnostics: Diagnostic[] = [];
    const malformedIds = new Set<string>();
    const months = new Set<string>();
    let sourceTruncated = false;
    let directoryEntries = 0;
    let recordCount = 0;
    let corpusBytes = 0;
    let diagnosticsTruncated = false;
    const appendDiagnostic = (item: Diagnostic): void => {
      if (diagnostics.length < ACTIVITY_REPOSITORY_LIMITS.maxDiagnostics) {
        diagnostics.push(item);
        return;
      }
      if (diagnosticsTruncated) return;
      diagnosticsTruncated = true;
      diagnostics[diagnostics.length - 1] = diagnostic(
        "ACTIVITY_DIAGNOSTICS_TRUNCATED",
        `Canonical Activity diagnostics exceed the ${ACTIVITY_REPOSITORY_LIMITS.maxDiagnostics}-item safety limit.`,
        ACTIVITY_ROOT,
      );
    };
    const truncate = (message: string): void => {
      sourceTruncated = true;
      appendDiagnostic(diagnostic(
        "ACTIVITY_SOURCE_TRUNCATED",
        message,
        ACTIVITY_ROOT,
      ));
    };

    // The publication callback owns the fixed-name lock and may ignore its two
    // bounded internal markers. Ordinary reads count those names so a planted
    // lookalike can never weaken the 4,096-entry ceiling.
    const monthDirectory = readDirectoryBounded(
      root,
      ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries
        + (ignoreInternalLockEntries ? ACTIVITY_INTERNAL_ROOT_ENTRIES.size : 0)
        + 1,
    );
    if (monthDirectory.truncated) {
      truncate(
        `Canonical Activity exceeds the ${ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries}-entry safety limit.`,
      );
    }
    for (const monthEntry of monthDirectory.entries) {
      if (sourceTruncated) break;
      if (
        ignoreInternalLockEntries
        && ACTIVITY_INTERNAL_ROOT_ENTRIES.has(monthEntry.name)
      ) continue;
      directoryEntries += 1;
      if (directoryEntries > ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries) {
        truncate(
          `Canonical Activity exceeds the ${ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries}-entry safety limit.`,
        );
        break;
      }
      const monthPath = `${ACTIVITY_ROOT}/${monthEntry.name}` as RepoRelativePath;
      if (!monthEntry.isDirectory() || !ACTIVITY_MONTH.test(monthEntry.name)) {
        appendDiagnostic(diagnostic(
          "ACTIVITY_ARTIFACT_UNEXPECTED",
          "Unexpected item in the canonical activity directory.",
          monthPath,
        ));
        if (ACTIVITY_MONTH.test(monthEntry.name)) {
          truncate("A canonical Activity month path is not a safely readable directory.");
          break;
        }
        continue;
      }

      let monthRoot: string;
      try {
        const contained = assertContainedArtifactDirectory(this.projectRoot, monthPath);
        if (contained === null) continue;
        monthRoot = contained;
        months.add(monthEntry.name);
      } catch (error) {
        appendDiagnostic(diagnosticFromError(error, monthPath));
        truncate("A canonical Activity month directory could not be read safely.");
        break;
      }

      const fileDirectory = readDirectoryBounded(
        monthRoot,
        ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries - directoryEntries + 1,
      );
      if (fileDirectory.truncated) {
        truncate(
          `Canonical Activity exceeds the ${ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries}-entry safety limit.`,
        );
      }
      for (const fileEntry of fileDirectory.entries) {
        directoryEntries += 1;
        if (directoryEntries > ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries) {
          truncate(
            `Canonical Activity exceeds the ${ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries}-entry safety limit.`,
          );
          break;
        }
        const sourcePath = `${monthPath}/${fileEntry.name}` as RepoRelativePath;
        const fileMatch = ACTIVITY_FILE.exec(fileEntry.name);
        if (!fileEntry.isFile() || fileMatch === null) {
          if (fileMatch !== null) malformedIds.add(fileMatch[1]!);
          appendDiagnostic(diagnostic(
            "ACTIVITY_ARTIFACT_UNEXPECTED",
            "Unexpected item in a canonical activity month directory.",
            sourcePath,
          ));
          continue;
        }
        const candidateId = fileMatch[1]!;
        recordCount += 1;
        if (recordCount > ACTIVITY_REPOSITORY_LIMITS.maxRecords) {
          malformedIds.add(candidateId);
          truncate(
            `Canonical Activity exceeds the ${ACTIVITY_REPOSITORY_LIMITS.maxRecords}-record safety limit.`,
          );
          break;
        }
        try {
          const read = readContainedArtifact(
            this.projectRoot,
            sourcePath,
            ACTIVITY_ARTIFACT_MAX_BYTES,
            "canonical",
          );
          corpusBytes += read.bytes.byteLength;
          if (corpusBytes > ACTIVITY_REPOSITORY_LIMITS.maxCorpusBytes) {
            malformedIds.add(candidateId);
            truncate(
              `Canonical Activity exceeds the ${ACTIVITY_REPOSITORY_LIMITS.maxCorpusBytes}-byte safety limit.`,
            );
            break;
          }
          parsed.push(parseActivityArtifact(read.bytes, sourcePath));
        } catch (error) {
          malformedIds.add(candidateId);
          appendDiagnostic(diagnosticFromError(error, sourcePath));
          if (
            error instanceof MexPortError
            && error.problem.title === "Artifact is too large"
          ) {
            truncate(
              `Canonical Activity contains a record beyond its bounded artifact size.`,
            );
            break;
          }
        }
      }
      if (sourceTruncated) break;
    }

    const events: StoredActivityEvent[] = [];
    const byId = new Map<string, StoredActivityEvent>();
    const conflicted = new Set(malformedIds);
    for (const event of parsed) {
      if (conflicted.has(event.id)) continue;
      const previous = byId.get(event.id);
      if (previous === undefined) {
        byId.set(event.id, event);
        events.push(event);
        continue;
      }
      if (previous.revision === event.revision) continue;

      conflicted.add(event.id);
      byId.delete(event.id);
      const previousIndex = events.findIndex((candidate) => candidate.id === event.id);
      if (previousIndex !== -1) events.splice(previousIndex, 1);
      appendDiagnostic(diagnostic(
        "ACTIVITY_ID_CONFLICT",
        `Conflicting canonical activity files reuse ID ${event.id}; both were excluded.`,
        event.sourcePath,
      ));
    }

    // A partial directory walk depends on filesystem enumeration order. Do not
    // surface those rows as a trusted canonical subset; retain only the safe
    // truncation diagnostic until the corpus can be read completely.
    return {
      events: sourceTruncated
        ? []
        : events.filter((event) => !conflicted.has(event.id)),
      diagnostics,
      sourceTruncated,
      untrustedIds: [...conflicted].sort(),
      directoryEntries,
      recordCount,
      corpusBytes,
      months,
    };
  }

  #assertCapacityFor(
    preview: ActivityCreatePreview,
    bytes: string,
    ignoreInternalLockEntries = false,
  ): void {
    const scan = this.#scanCorpus(ignoreInternalLockEntries);
    if (scan.sourceTruncated) throw activityCapacityExceeded(preview.sourcePath);
    const existing = tryReadContainedArtifact(
      this.projectRoot,
      preview.sourcePath,
      ACTIVITY_ARTIFACT_MAX_BYTES,
      "canonical",
    );
    if (existing !== null) {
      if (existing.revision !== preview.revision) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Activity publication conflict",
          "The canonical Activity path already contains different bytes.",
          preview.sourcePath,
        );
      }
      return;
    }
    const month = preview.sourcePath.split("/")[3]!;
    const addedEntries = scan.months.has(month) ? 1 : 2;
    if (
      scan.recordCount + 1 > ACTIVITY_REPOSITORY_LIMITS.maxRecords
      || scan.directoryEntries + addedEntries > ACTIVITY_REPOSITORY_LIMITS.maxDirectoryEntries
      || scan.corpusBytes + Buffer.byteLength(bytes, "utf8")
        > ACTIVITY_REPOSITORY_LIMITS.maxCorpusBytes
    ) {
      throw activityCapacityExceeded(preview.sourcePath);
    }
  }

  async #publishWithCapacity(
    preview: ActivityCreatePreview,
    bytes: string,
  ): Promise<StoredActivityEvent> {
    return withContainedArtifactLock(
      this.projectRoot,
      ACTIVITY_ROOT,
      ACTIVITY_LOCK_NAME,
      () => {
        this.#assertCapacityFor(preview, bytes, true);
        return this.#publishExact(preview, bytes);
      },
    );
  }

  #publishExact(preview: ActivityCreatePreview, bytes: string): StoredActivityEvent {
    const existing = tryReadContainedArtifact(
      this.projectRoot,
      preview.sourcePath,
      ACTIVITY_ARTIFACT_MAX_BYTES,
      "canonical",
    );
    if (existing !== null) {
      if (existing.revision !== preview.revision) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Activity publication conflict",
          "The canonical Activity path already contains different bytes.",
          preview.sourcePath,
        );
      }
      return parseActivityArtifact(existing.bytes, preview.sourcePath);
    }

    let revision: Revision;
    try {
      revision = atomicCreateArtifact(this.projectRoot, preview.sourcePath, bytes);
    } catch (error) {
      // Another cooperating writer may have published the same immutable event
      // between the exact probe above and O_EXCL publication. Treat only the
      // byte-identical result as an idempotent success.
      if (!(error instanceof MexPortError) || error.problem.code !== "REVISION_CONFLICT") {
        throw error;
      }
      const raced = tryReadContainedArtifact(
        this.projectRoot,
        preview.sourcePath,
        ACTIVITY_ARTIFACT_MAX_BYTES,
        "canonical",
      );
      if (raced === null || raced.revision !== preview.revision) throw error;
      return parseActivityArtifact(raced.bytes, preview.sourcePath);
    }
    if (revision !== preview.revision) {
      throw artifactError(
        "INTERNAL_ERROR",
        "Activity publication failed",
        "Published activity bytes do not match the reviewed preview.",
        preview.sourcePath,
      );
    }
    return parseActivityArtifact(bytes, preview.sourcePath);
  }
}

function bindProjectRoot(projectRoot: string): string {
  try {
    const canonical = realpathSync(resolve(projectRoot));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw artifactError(
      "INVALID_REQUEST",
      "Invalid project root",
      "Activity storage requires an existing repository directory.",
    );
  }
}

export class TimelineReader {
  constructor(
    private readonly projectRoot: string,
    private readonly activity: ActivityRepository,
    private readonly actorResolver: ActorResolver | null = null,
  ) {}

  list(request: TimelineRequest = {}): TimelinePage {
    const canonical = request.source === "legacy"
      ? { events: [], diagnostics: [], sourceTruncated: false }
      : this.activity.readAll();
    const legacy = request.source === "activity"
      ? { entries: [], diagnostics: [], truncated: false }
      : readLegacyTimeline(this.projectRoot);
    return buildTimelinePage(
      canonical.events,
      legacy.entries,
      [...canonical.diagnostics, ...legacy.diagnostics],
      request,
      canonical.sourceTruncated || legacy.truncated,
    );
  }

  async listResolved(request: TimelineRequest = {}): Promise<ResolvedTimelinePage> {
    if (this.actorResolver === null) {
      throw artifactError(
        "INVALID_REQUEST",
        "Actor resolver unavailable",
        "Resolved timeline projection requires an ActorResolver.",
      );
    }
    const page = this.list(request);
    const resolutions = new Map<string, ReturnType<ActorResolver["resolveHistorical"]>>();
    const items = await Promise.all(page.items.map(async (entry): Promise<ResolvedTimelineEntry> => {
      if (entry.source === "legacy") {
        return { entry, recordedActor: null, effectiveActor: null, diagnostics: [] };
      }
      const key = actorKey(entry.actor);
      let pending = resolutions.get(key);
      if (pending === undefined) {
        pending = this.actorResolver!.resolveHistorical(entry.actor);
        resolutions.set(key, pending);
      }
      const resolution = await pending;
      return {
        entry,
        // Cache current lookup work, never the immutable bytes recorded by this
        // particular event (older member display snapshots may differ).
        recordedActor: entry.actor,
        effectiveActor: resolution.diagnostics.some((item) => item.code === "ACTOR_MEMBER_MISSING")
          || (entry.actor.kind === "git" && resolution.resolvedActor.kind === "git")
          ? entry.actor
          : resolution.resolvedActor,
        diagnostics: resolution.diagnostics,
      };
    }));
    return { ...page, items };
  }
}

export interface ResolvedTimelineEntry {
  entry: TimelinePage["items"][number];
  recordedActor: ActivityEvent["actor"] | null;
  effectiveActor: ActivityEvent["actor"] | null;
  diagnostics: readonly Diagnostic[];
}

export interface ResolvedTimelinePage extends Omit<TimelinePage, "items"> {
  items: readonly ResolvedTimelineEntry[];
}

function previewFor(event: ActivityEvent): { preview: ActivityCreatePreview; bytes: string } {
  const bytes = serializeActivityArtifact(event);
  const sourcePath = activityArtifactPath(event);
  const stored = parseActivityArtifact(bytes, sourcePath);
  const { sourcePath: _sourcePath, revision, ...canonicalEvent } = stored;
  const previewRevision = revisionOf(`${sourcePath}\0${revision}`);
  const preview: ActivityCreatePreview = {
    event: canonicalEvent,
    sourcePath,
    revision,
    previewRevision,
    changes: [{
      kind: "create",
      path: sourcePath,
      beforeRevision: null,
      afterRevision: revision,
      diff: canonicalFileDiff(sourcePath, null, bytes),
    }],
  };
  return {
    bytes,
    preview: deepFreeze(preview),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function sameRepoCheckpoint(left: ActivityEvent["repoState"], right: ActivityEvent["repoState"]): boolean {
  return left.branch === right.branch && left.head === right.head && left.dirty === right.dirty;
}

function readDirectoryBounded(
  path: string,
  maximum: number,
): { entries: Dirent[]; truncated: boolean } {
  let directory;
  try {
    directory = opendirSync(path);
  } catch {
    throw artifactError(
      "VALIDATION_FAILED",
      "Canonical Activity directory is unreadable",
      "A canonical Activity directory could not be opened safely.",
      ACTIVITY_ROOT,
    );
  }
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    let entry: Dirent | null;
    while ((entry = directory.readSync()) !== null) {
      if (entries.length >= maximum) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { entries, truncated };
}

function actorKey(actor: ActivityEvent["actor"]): string {
  if (actor.kind === "unknown") return "unknown";
  if (actor.kind === "member") {
    return `member\0${actor.memberId}`;
  }
  return `git\0${actor.name?.trim().normalize("NFC") ?? ""}\0${actor.email?.trim().normalize("NFC").toLowerCase() ?? ""}`;
}

function diagnostic(code: string, message: string, path: RepoRelativePath): Diagnostic {
  return { code, severity: "warning", message, path };
}

function diagnosticFromError(error: unknown, path: RepoRelativePath): Diagnostic {
  if (error instanceof MexPortError) {
    return error.problem.diagnostics?.[0] ?? {
      code: error.problem.code,
      severity: "error",
      message: error.problem.detail,
      path,
    };
  }
  return {
    code: "ACTIVITY_ARTIFACT_UNREADABLE",
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    path,
  };
}

function activitySourceTruncated(): MexPortError {
  return artifactError(
    "VALIDATION_FAILED",
    "Canonical Activity source is truncated",
    "The canonical Activity corpus exceeds a bounded read limit and cannot be trusted.",
    ACTIVITY_ROOT,
  );
}

function activityCapacityExceeded(path: RepoRelativePath): MexPortError {
  return artifactError(
    "VALIDATION_FAILED",
    "Canonical Activity capacity exceeded",
    "Publishing this event would exceed the bounded Activity record, byte, or directory-entry limit.",
    path,
  );
}
