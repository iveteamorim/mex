import type { GitPort } from "./contracts/git.js";
import { MexPortError, type Revision } from "./contracts/shared.js";
import type { MemberRepositoryOptions } from "./identity/member-repository.js";
import {
  ActivityRepository,
  TimelineReader,
  type ActivityCreateInput,
  type ActivityCreatePreview,
} from "./activity/repository.js";
import { createRepositoryGitPort } from "./git/git-port.js";
import {
  ActorResolver,
  MemberRepository,
  type ActorResolution,
} from "./identity/index.js";
import { TeamLocalState } from "./local-state/index.js";

export interface TeamIdentityActivityOptions {
  projectRoot: string;
  scaffoldId: string;
  git?: GitPort;
  now?: () => Date;
  memberRepository?: MemberRepositoryOptions;
  activityIdFactory?: (timestampMs: number) => string;
}

export interface ResolvedActivityPreview {
  actorResolution: ActorResolution;
  activity: ActivityCreatePreview;
}

/**
 * Internal Lane C composition root. It deliberately exposes primitives rather
 * than the broad Wiki-dependent TeamWorkflowPort or any package-root API.
 */
export class TeamIdentityActivityFoundation {
  readonly git: GitPort;
  readonly members: MemberRepository;
  readonly localState: TeamLocalState;
  readonly actors: ActorResolver;
  readonly timeline: TimelineReader;
  readonly #activity: ActivityRepository;

  constructor(options: TeamIdentityActivityOptions) {
    const now = options.now ?? (() => new Date());
    this.git = options.git ?? createRepositoryGitPort(options.projectRoot, { now });
    this.members = new MemberRepository(options.projectRoot, options.memberRepository);
    this.localState = new TeamLocalState({
      projectRoot: options.projectRoot,
      scaffoldId: options.scaffoldId,
      now: () => now().toISOString(),
    });
    this.actors = new ActorResolver(this.members, this.git);
    this.#activity = new ActivityRepository({
      projectRoot: options.projectRoot,
      git: this.git,
      now,
      ...(options.activityIdFactory === undefined
        ? {}
        : { generateId: options.activityIdFactory }),
    });
    this.timeline = new TimelineReader(options.projectRoot, this.#activity, this.actors);
  }

  async resolveCurrentActor(): Promise<ActorResolution> {
    const configured = this.localState.getConfiguredMember();
    return this.actors.resolveDetailed(
      configured === null ? {} : { configuredMemberId: configured.memberId },
    );
  }

  /** Resolve the current actor and capture Git state; neither value is caller-forgeable. */
  async previewActivity(
    input: Omit<ActivityCreateInput, "actor">,
  ): Promise<ResolvedActivityPreview> {
    const actorResolution = await this.resolveCurrentActor();
    const activity = await this.#activity.previewCreate({
      ...input,
      actor: actorResolution.actor,
    });
    return { actorResolution, activity };
  }

  async applyActivity(
    preview: ResolvedActivityPreview,
    expectedPreviewRevision: Revision,
  ) {
    const currentActor = await this.resolveCurrentActor();
    if (!sameActor(currentActor.actor, preview.activity.event.actor)) {
      throw new MexPortError({
        title: "Activity actor changed",
        status: 409,
        code: "REVISION_CONFLICT",
        detail: "The resolved actor changed after activity preview; preview the event again.",
      });
    }
    return this.#activity.applyCreate(preview.activity, expectedPreviewRevision);
  }

  listActivity(request: Parameters<ActivityRepository["list"]>[0] = {}) {
    return this.#activity.list(request);
  }

  /** Exact count of valid, non-conflicting canonical events. */
  getActivitySummary(): { count: number; diagnostics: ReturnType<ActivityRepository["readAll"]>["diagnostics"] } {
    const read = this.#activity.readAll();
    if (read.sourceTruncated) {
      throw new MexPortError({
        title: "Activity corpus is incomplete",
        status: 422,
        code: "VALIDATION_FAILED",
        detail: "The canonical activity corpus exceeded its safe read bound.",
      });
    }
    return { count: read.events.length, diagnostics: read.diagnostics };
  }
}

function sameActor(left: ActorResolution["actor"], right: ActorResolution["actor"]): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unknown" && right.kind === "unknown") return true;
  if (left.kind === "member" && right.kind === "member") {
    return left.memberId === right.memberId && left.displayName === right.displayName;
  }
  return left.kind === "git" && right.kind === "git"
    && left.name === right.name && left.email === right.email;
}
