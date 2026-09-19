import type { Diagnostic } from "../contracts/shared.js";
import type { GitIdentity, GitPort } from "../contracts/git.js";
import type {
  ActorResolutionRequest,
  MemberGitAlias,
  TeamMember,
} from "../contracts/workflow.js";
import type { ActorRef } from "../contracts/shared.js";
import { artifactError } from "../artifacts/errors.js";
import {
  membersMatchingEmail,
  membersMatchingName,
  normalizeGitIdentity,
} from "./aliases.js";
import type { MemberReader } from "./member-repository.js";

export type ActorResolutionSource =
  | "configured-member"
  | "git-alias"
  | "git-fallback"
  | "unknown";

export interface ActorResolution {
  actor: ActorRef;
  source: ActorResolutionSource;
  diagnostics: readonly Diagnostic[];
}

export interface HistoricalActorResolution {
  /** Exact immutable actor stored in the event. */
  recordedActor: ActorRef;
  /** Current member/display projection; never written back to the event. */
  resolvedActor: ActorRef;
  diagnostics: readonly Diagnostic[];
}

export interface GitIdentityReader {
  getIdentity(): Promise<GitIdentity>;
}

const MAX_GIT_ACTOR_NAME_BYTES = 200;
const MAX_GIT_ACTOR_EMAIL_BYTES = 320;
const MAX_ACTOR_DIAGNOSTIC_IDS = 100;

/** Resolve configured human identity first, then Git identity, then unknown. */
export class ActorResolver {
  readonly #members: MemberReader;
  readonly #git: Pick<GitPort, "getIdentity"> | GitIdentityReader | null;

  constructor(
    members: MemberReader,
    git: Pick<GitPort, "getIdentity"> | GitIdentityReader | null = null,
  ) {
    this.#members = members;
    this.#git = git;
  }

  async resolve(request: ActorResolutionRequest = {}): Promise<ActorRef> {
    return (await this.resolveDetailed(request)).actor;
  }

  async resolveDetailed(request: ActorResolutionRequest = {}): Promise<ActorResolution> {
    if (request.configuredMemberId !== undefined) {
      const configured = await this.#members.get(request.configuredMemberId);
      if (configured === null) {
        throw artifactError(
          "NOT_FOUND",
          "Configured member not found",
          `Configured member ${request.configuredMemberId} does not exist. Select an active member before continuing.`,
        );
      }
      if (!configured.active) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Configured member is inactive",
          `Configured member ${request.configuredMemberId} is inactive. Select an active member before continuing.`,
          configured.sourcePath,
        );
      }
      return {
        actor: memberActor(configured),
        source: "configured-member",
        diagnostics: [],
      };
    }

    return this.#resolveUnconfigured(request.gitIdentity);
  }

  /**
   * Read projection for a persisted local selection. A stale selection remains
   * visible to the caller while actor authority falls back to bounded Git
   * resolution so the user can explicitly clear it.
   */
  async resolveCurrentDetailed(
    request: ActorResolutionRequest = {},
  ): Promise<ActorResolution> {
    if (request.configuredMemberId === undefined) {
      return this.#resolveUnconfigured(request.gitIdentity);
    }
    const configured = await this.#members.get(request.configuredMemberId);
    if (configured?.active === true) {
      return {
        actor: memberActor(configured),
        source: "configured-member",
        diagnostics: [],
      };
    }
    const fallback = await this.#resolveUnconfigured(request.gitIdentity);
    const diagnostic: Diagnostic = configured === null
      ? {
          code: "ACTOR_MEMBER_MISSING",
          severity: "warning",
          message: `Configured member ${request.configuredMemberId} no longer exists; clear the stale local selection.`,
        }
      : {
          code: "ACTOR_MEMBER_INACTIVE",
          severity: "warning",
          message: `Configured member ${request.configuredMemberId} is inactive; clear the stale local selection.`,
          path: configured.sourcePath,
        };
    return {
      ...fallback,
      diagnostics: [diagnostic, ...fallback.diagnostics],
    };
  }

  async #resolveUnconfigured(
    gitIdentity: MemberGitAlias | undefined,
  ): Promise<ActorResolution> {
    const identityResult = await this.#readIdentity(gitIdentity);
    if (identityResult.identity === null) {
      return {
        actor: { kind: "unknown" },
        source: "unknown",
        diagnostics: identityResult.diagnostics,
      };
    }

    const activeMembers = (await this.#members.list()).filter((member) => member.active);
    const emailMatches = identityResult.identity.email === null
      ? []
      : membersMatchingEmail(activeMembers, identityResult.identity.email);
    const nameMatches = identityResult.identity.name === null
      ? []
      : membersMatchingName(activeMembers, identityResult.identity.name);
    const matches = mergeMemberMatches(emailMatches, nameMatches);
    if (matches.length === 1) {
      return {
        actor: memberActor(matches[0]!),
        source: "git-alias",
        diagnostics: identityResult.diagnostics,
      };
    }
    if (matches.length > 1) {
      return gitFallback(identityResult.identity, [
        ...identityResult.diagnostics,
        ambiguousDiagnostic(matches),
      ]);
    }
    return gitFallback(identityResult.identity, identityResult.diagnostics);
  }

  async resolveHistorical(recordedActor: ActorRef): Promise<HistoricalActorResolution> {
    if (recordedActor.kind === "unknown") {
      return { recordedActor, resolvedActor: recordedActor, diagnostics: [] };
    }
    if (recordedActor.kind === "git") {
      const current = await this.resolveDetailed({
        gitIdentity: { name: recordedActor.name, email: recordedActor.email },
      });
      return {
        recordedActor,
        resolvedActor: current.actor,
        diagnostics: current.diagnostics,
      };
    }

    const member = await this.#members.get(recordedActor.memberId);
    if (member === null) {
      return {
        recordedActor,
        resolvedActor: recordedActor,
        diagnostics: [{
          code: "ACTOR_MEMBER_MISSING",
          severity: "warning",
          message: `Recorded member ${recordedActor.memberId} no longer exists; preserving the recorded actor.`,
        }],
      };
    }
    return {
      recordedActor,
      resolvedActor: memberActor(member),
      diagnostics: member.active
        ? []
        : [{
            code: "ACTOR_MEMBER_INACTIVE",
            severity: "warning",
            message: `Recorded member ${recordedActor.memberId} is currently inactive.`,
            path: member.sourcePath,
          }],
    };
  }

  async #readIdentity(
    supplied: MemberGitAlias | undefined,
  ): Promise<{ identity: GitIdentity | null; diagnostics: readonly Diagnostic[] }> {
    if (supplied !== undefined) {
      return boundedIdentityResult(supplied);
    }
    if (this.#git === null) return { identity: null, diagnostics: [] };
    try {
      return boundedIdentityResult(await this.#git.getIdentity());
    } catch {
      return {
        identity: null,
        diagnostics: [{
          code: "GIT_IDENTITY_UNAVAILABLE",
          severity: "warning",
          message: "Git identity could not be inspected.",
        }],
      };
    }
  }
}

function memberActor(member: TeamMember): ActorRef {
  return {
    kind: "member",
    memberId: member.ref.id,
    displayName: member.displayName,
  };
}

function gitFallback(identity: GitIdentity, diagnostics: readonly Diagnostic[]): ActorResolution {
  return {
    actor: { kind: "git", name: identity.name, email: identity.email },
    source: "git-fallback",
    diagnostics,
  };
}

function ambiguousDiagnostic(matches: readonly TeamMember[]): Diagnostic {
  const memberIds = matches.slice(0, MAX_ACTOR_DIAGNOSTIC_IDS).map((member) => member.ref.id);
  return {
    code: "ACTOR_ALIAS_AMBIGUOUS",
    severity: "warning",
    message: "Git identity matches multiple active members; preserving the Git fallback identity.",
    detail: {
      memberIds,
      ...(matches.length > memberIds.length ? { truncated: true } : {}),
    },
  };
}

function boundedIdentityResult(
  value: GitIdentity | MemberGitAlias,
): { identity: GitIdentity | null; diagnostics: readonly Diagnostic[] } {
  const identity = normalizeGitIdentity(value);
  if (identity === null) return { identity: null, diagnostics: [] };
  if (
    !boundedIdentityField(identity.name, MAX_GIT_ACTOR_NAME_BYTES)
    || !boundedIdentityField(identity.email, MAX_GIT_ACTOR_EMAIL_BYTES)
  ) {
    return {
      identity: null,
      diagnostics: [{
        code: "GIT_IDENTITY_INVALID",
        severity: "warning",
        message: "Git identity exceeds the bounded actor contract and was ignored.",
      }],
    };
  }
  return { identity, diagnostics: [] };
}

function boundedIdentityField(value: string | null, maxBytes: number): boolean {
  return value === null
    || (!/[\u0000-\u001f\u007f]/u.test(value)
      && Buffer.byteLength(value, "utf8") <= maxBytes);
}

function mergeMemberMatches(
  emailMatches: readonly TeamMember[],
  nameMatches: readonly TeamMember[],
): readonly TeamMember[] {
  const byId = new Map<string, TeamMember>();
  for (const member of [...emailMatches, ...nameMatches]) byId.set(member.ref.id, member);
  return [...byId.values()].sort((left, right) => compareCodePoints(left.ref.id, right.ref.id));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
