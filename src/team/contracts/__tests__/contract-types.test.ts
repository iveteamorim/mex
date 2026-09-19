import { describe, expect, it } from "vitest";
import type { HealthComponent } from "../index.js";
import type { GitHealth, MigrationHealth } from "../health.js";
import type { FileChange } from "../shared.js";
import type {
  ActivityEvent,
  ActivityEventV1,
  PortableWikiOperation,
  TeamWorkflowApplyRequest,
  TeamWorkflowCommand,
} from "../workflow.js";

type IsAssignable<TValue, TTarget> = [TValue] extends [TTarget] ? true : false;
type AssertTrue<TValue extends true> = TValue;
type AssertFalse<TValue extends false> = TValue;

type ValidCreateChange = {
  kind: "create";
  path: "docs/new.md";
  beforeRevision: null;
  afterRevision: string;
  diff: string;
};

type ImpossibleCreateChange = Omit<ValidCreateChange, "beforeRevision"> & {
  beforeRevision: string;
};

type RevisionBoundCommandWithoutExpectation = {
  operationId: "op-update";
  expectedRevisions: readonly [];
  action: {
    kind: "workstream.update";
    workstreamId: "ws_contract";
    patch: { summary: "updated" };
  };
};

type RevisionBoundCommandWithExpectation = Omit<
  RevisionBoundCommandWithoutExpectation,
  "expectedRevisions"
> & {
  expectedRevisions: readonly [{
    target: { kind: "entity"; id: "ws_contract" };
    revision: string;
    semanticRevision: 1;
  }];
};

type CommandWithForgedAuthority = RevisionBoundCommandWithExpectation & {
  actor: { kind: "unknown" };
  occurredAt: "2026-08-22T00:00:00.000Z";
};

type ApplyWithoutPreparedAuthority = {
  command: RevisionBoundCommandWithExpectation;
  expectedPreviewRevision: string;
};

type WikiOperationWithForgedAuthority = {
  opId: "wiki-op";
  type: "update-entry";
  payload: { summary: "updated" };
  actor: { kind: "human"; id: "forged" };
  timestamp: "2026-08-22T00:00:00.000Z";
};

type ImpossibleHealthyGit = {
  status: "healthy";
  summary: "clean";
  diagnostics: readonly [];
  repo: null;
};

type ImpossibleReadyMigration = {
  status: "unavailable";
  summary: "ready";
  diagnostics: readonly [];
  state: "ready";
  fromVersion: null;
  toVersion: null;
};

type ActivityWithFileAndCommitSubjects = Omit<ActivityEventV1, "subjects"> & {
  subjects: readonly [
    { kind: "file"; path: "src/index.ts" },
    { kind: "commit"; hash: "48da30c" },
  ];
};

type _CreateShapeAccepted = AssertTrue<IsAssignable<ValidCreateChange, FileChange>>;
type _ImpossibleCreateRejected = AssertFalse<
  IsAssignable<ImpossibleCreateChange, FileChange>
>;
type _UpdateWithExpectationAccepted = AssertTrue<
  IsAssignable<RevisionBoundCommandWithExpectation, TeamWorkflowCommand<unknown>>
>;
type _UpdateWithoutExpectationRejected = AssertFalse<
  IsAssignable<RevisionBoundCommandWithoutExpectation, TeamWorkflowCommand<unknown>>
>;
type _CallerAuthorityRejected = AssertFalse<
  IsAssignable<CommandWithForgedAuthority, TeamWorkflowCommand<unknown>>
>;
type _ApplyRequiresPreparedAuthority = AssertFalse<
  IsAssignable<ApplyWithoutPreparedAuthority, TeamWorkflowApplyRequest<unknown>>
>;
type _WikiAuthorityRejected = AssertFalse<
  IsAssignable<WikiOperationWithForgedAuthority, PortableWikiOperation<unknown>>
>;
type _HealthyGitRequiresRepo = AssertFalse<IsAssignable<ImpossibleHealthyGit, GitHealth>>;
type _UnavailableMigrationCannotBeReady = AssertFalse<
  IsAssignable<ImpossibleReadyMigration, MigrationHealth>
>;
type _ActivitySupportsRepositorySubjects = AssertTrue<
  IsAssignable<ActivityWithFileAndCommitSubjects, ActivityEvent>
>;
type _HealthComponentIsBarrelExported = AssertTrue<IsAssignable<GitHealth, HealthComponent>>;

describe("compiled team contract invariants", () => {
  it("is included in both TypeScript and Vitest verification", () => {
    expect(true).toBe(true);
  });
});
