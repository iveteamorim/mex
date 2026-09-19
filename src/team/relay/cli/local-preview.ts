import { createHash } from "node:crypto";
import { lstatSync, opendirSync, unlinkSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import {
  assertContainedArtifactDirectory,
  atomicCreateArtifact,
  readContainedArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../../artifacts/filesystem.js";
import { artifactError } from "../../artifacts/errors.js";
import { MEX_ERROR_CODES, MexPortError, type RepoRelativePath } from "../../contracts/shared.js";
import type { TeamRelayCommand, TeamRelayPreviewEnvelope } from "../../contracts/workflow.js";
import { teamEnvelope } from "../../cli/envelope.js";
import { RepositoryRootGuard } from "../../workflow/repository-root.js";
import { boundedRelayJson, hashRelayValue, normalizeTeamRelayCommand } from "../handoff.js";
import { parseRelayPreviewValue } from "./request-file.js";

const DIRECTORY = ".mex/local/relay-previews" as RepoRelativePath;
const LOCK = ".relay-previews.mex-lock";
const MAX_PENDING = 64;
const MAX_BYTES = 64 * 1024;

/** Persist exact local-create authority before apply so process retries can reuse it. */
export async function withLocalRelayPreview<T>(
  projectRoot: string,
  request: TeamRelayCommand,
  create: () => Promise<TeamRelayPreviewEnvelope>,
  apply: (preview: TeamRelayPreviewEnvelope) => Promise<T>,
): Promise<T> {
  let retainedPath: RepoRelativePath | undefined;
  let applied: { result: T } | undefined;
  try {
    const root = new RepositoryRootGuard(projectRoot);
    const normalized = normalizeTeamRelayCommand(request);
    if (normalized.action.kind !== "relay.draft.save" || normalized.action.draftId !== undefined) {
      throw invalidPending();
    }
    const requestHash = hashRelayValue(normalized);
    const name = `${createHash("sha256").update(normalized.operationId).digest("hex")}.json`;
    const path = `${DIRECTORY}/${name}` as RepoRelativePath;
    root.assertCurrent();
    return await withContainedArtifactLock(root.path, DIRECTORY, LOCK, async () => {
      root.assertCurrent();
      const directory = assertContainedArtifactDirectory(root.path, DIRECTORY);
      if (directory === null) throw invalidPending();
      const identity = lstatSync(directory, { bigint: true });
      const assertCurrent = () => {
        root.assertCurrent();
        if (assertContainedArtifactDirectory(root.path, DIRECTORY) !== directory
          || !sameIdentity(identity, lstatSync(directory, { bigint: true }))) {
          throw artifactError("REVISION_CONFLICT", "Pending Relay directory changed", "Reopen the checkout before retrying the local save.");
        }
      };
      const count = inspectPendingDirectory(directory);
      let stored = tryReadContainedArtifact(root.path, path, MAX_BYTES);
      let preview: TeamRelayPreviewEnvelope;
      if (stored !== null) {
        retainedPath = path;
        const wrapper = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)) as unknown;
        boundedRelayJson(wrapper);
        preview = parseRelayPreviewValue(wrapper, "relay.draft.save");
      } else {
        if (count >= MAX_PENDING) throw invalidPending();
        preview = await create();
      }
      assertLocalCreate(preview, requestHash);
      assertCurrent();
      if (stored === null) {
        const wrapper = teamEnvelope({
          command: "relay.draft.save", mode: "preview", data: preview,
          diagnostics: preview.preview.diagnostics,
        });
        const bytes = `${boundedRelayJson(wrapper)}\n`;
        if (Buffer.byteLength(bytes, "utf8") > MAX_BYTES) throw invalidPending();
        preview = parseRelayPreviewValue(JSON.parse(bytes), "relay.draft.save");
        // Recheck capacity after the asynchronous preview before publishing private bytes.
        if (inspectPendingDirectory(directory) >= MAX_PENDING) throw invalidPending();
        atomicCreateArtifact(root.path, path, bytes, 0o600);
        retainedPath = path;
        stored = readContainedArtifact(root.path, path, MAX_BYTES);
      }
      assertCurrent();
      if (readContainedArtifact(root.path, path, MAX_BYTES).revision !== stored.revision) {
        throw artifactError("REVISION_CONFLICT", "Pending Relay preview changed", "The saved preview changed before apply.");
      }
      const result = await apply(preview);
      applied = { result };
      // A completed write stays successful even if optional receipt cleanup fails.
      try {
        assertCurrent();
        const current = readContainedArtifact(root.path, path, MAX_BYTES);
        if (current.revision === stored.revision) {
          unlinkSync(current.canonicalPath);
          retainedPath = undefined;
        }
      } catch { /* Retain the receipt for exact replay when cleanup is unavailable. */ }
      return result;
    });
  } catch (error) {
    if (applied !== undefined) return applied.result;
    const known = error instanceof MexPortError && MEX_ERROR_CODES.includes(error.problem.code);
    throw new MexPortError({
      code: known ? error.problem.code : "OPERATION_INTERRUPTED",
      status: known ? error.problem.status : 409,
      title: "Local Relay save did not complete",
      detail: retainedPath === undefined
        ? "The local save could not safely prepare a pending preview. Inspect local drafts before retrying."
        : "The original local preview is retained. Retry with the same operation ID and unchanged content, or apply the saved preview.",
      ...(retainedPath === undefined ? {} : { recovery: [{
        label: "Retry the original local Relay preview",
        command: `mex relay draft save --apply ${retainedPath} --json`,
      }] }),
    });
  }
}

function assertLocalCreate(preview: TeamRelayPreviewEnvelope, requestHash: string): void {
  if (hashRelayValue(normalizeTeamRelayCommand(preview.request)) !== requestHash) {
    throw artifactError("REVISION_CONFLICT", "Pending Relay request changed", "The operation ID already belongs to different local draft content.");
  }
  const changes = preview.preview.localChanges;
  if (!preview.preview.valid || preview.preview.scope !== "local" || preview.preview.changes.length !== 0
    || changes.length !== 1 || changes[0]?.namespace !== "relay-draft" || changes[0].beforeRevision !== null || changes[0].afterRevision === null
    || preview.request.action.kind !== "relay.draft.save" || preview.request.action.draftId !== undefined
    || preview.receipt.purposeIds.length !== 1 || preview.receipt.purposeIds[0]?.purpose !== "relay-draft"
    || preview.receipt.purposeIds[0].id !== changes[0].id) throw invalidPending();
}

function inspectPendingDirectory(directory: string): number {
  const entries = opendirSync(directory, { bufferSize: 8 });
  let count = 0;
  let receipts = 0;
  let visited = 0;
  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      if (++visited > MAX_PENDING + 2) throw invalidPending();
      if (entry.name === LOCK) continue;
      const receipt = /^[a-f0-9]{64}\.json$/u.test(entry.name);
      const inertStage = /^\.[a-f0-9]{64}\.json\.mex-tmp-[1-9][0-9]{0,9}-[a-f0-9]{16}$/u.test(entry.name);
      // A hard exit can strand an unpublished stage. It consumes capacity but
      // never becomes an apply candidate and is never silently removed.
      if (!receipt && !inertStage) throw invalidPending();
      if (receipt && ++receipts > MAX_PENDING) throw invalidPending();
      const stat = lstatSync(join(directory, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES
        || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw invalidPending();
      // Linking the 64th receipt can precede removal of its stage at hard exit.
      // Admit that one extra inert entry for retry; new saves still require <64.
      if (++count > MAX_PENDING + 1) throw invalidPending();
    }
  } finally { entries.closeSync(); }
  return count;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return right.isDirectory() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function invalidPending(): MexPortError {
  return artifactError("VALIDATION_FAILED", "Invalid pending Relay preview", "Pending local Relay previews require one exact local create and owner-only regular files of at most 64 KiB each. The directory allows at most 64 receipts and 65 total entries including inert stages; new saves require fewer than 64 entries.");
}
