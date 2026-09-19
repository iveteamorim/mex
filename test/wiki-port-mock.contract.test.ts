import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EntityRef } from "../src/team/contracts/shared.js";
import type { WikiOperationRequest } from "../src/team/contracts/wiki.js";
import {
  MockWikiPort,
  type MockLegacyMigration,
  type MockWikiMigrationPlan,
  type MockWikiOperationPlan,
} from "../src/team/testing/wiki/mock-wiki-port.js";
import {
  POPULATED_WIKI_FIXTURE,
  type MockWikiEntitySeed,
  type MockWikiPayload,
  type PopulatedWikiFixture,
} from "../src/team/testing/wiki/populated-fixture.js";
import {
  defineWikiPortContract,
  type WikiContractOracle,
  type WikiContractScenario,
  type WikiPortContractHarness,
} from "./contracts/wiki-port.contract.js";

const refs = POPULATED_WIKI_FIXTURE.refs;

const oracle: WikiContractOracle = {
  lookup: ref(refs.spec),
  search: {
    text: "webhook",
    expected: ref(refs.pattern),
    kind: "pattern",
  },
  relation: {
    source: ref(refs.currentDecision),
    target: ref(refs.oldDecision),
    type: "supersedes",
  },
  groundingCases: {
    renamed: { ref: ref(refs.currentDecision), health: "fresh" },
    changed: { ref: ref(refs.requirement), health: "changed" },
    ambiguous: { ref: ref(refs.pattern), health: "ambiguous" },
    missing: { ref: ref(refs.risk), health: "missing" },
    unverified: { ref: ref(refs.evidence), health: "unverified" },
  },
  lifecycleCases: {
    changedButCurrent: ref(refs.requirement),
    deprecatedButFresh: ref(refs.oldDecision),
  },
  archived: ref(refs.archivedDecision),
};

defineWikiPortContract("in-memory mock", {
  async open(scenario) {
    return openMockHarness(scenario);
  },
});

async function openMockHarness(
  scenario: WikiContractScenario,
): Promise<WikiPortContractHarness<
  MockWikiPayload,
  MockWikiOperationPlan,
  MockWikiOperationPlan,
  MockWikiMigrationPlan
>> {
  const legacyMigration = scenario === "legacy" ? loadLegacyMigration() : undefined;
  const fixture = scenario === "invalid-reference" ? invalidReferenceFixture() : undefined;
  const indexState = scenario === "index-missing" ? "missing"
    : scenario === "index-stale" ? "stale"
      : scenario === "index-corrupt" ? "corrupt"
        : undefined;
  const port = new MockWikiPort({
    fixture,
    indexState,
    legacyMigration,
    failNextIndexRefresh: scenario === "index-refresh-failure",
  });
  const scenarioOracle: WikiContractOracle = scenario === "legacy"
    ? {
        ...oracle,
        legacy: {
          entity: legacyEntityRef(),
          sourcePath: ".mex/context/architecture.md",
          eventsPath: ".mex/events/decisions.jsonl",
          preservedFragments: [
            "The capture attempt is persisted before calling the payment gateway.",
            "mex://function:retryPaymentCapture",
            "grounds_to:",
          ],
        },
      }
    : oracle;

  return {
    port,
    oracle: scenarioOracle,
    async makeOperation(kind) {
      const current = await port.getEntity(refs.currentDecision);
      if (!current) throw new Error("Current decision fixture is missing.");
      const operationId = kind === "invalid-relation"
        ? "operation_invalid_relation"
        : kind === "valid-then-invalid"
          ? "operation_atomic_rollback"
          : "operation_update_decision";
      const plan: MockWikiOperationPlan = kind === "invalid-relation"
        ? {
            operations: [{
              type: "add-relation",
              relation: {
                type: "depends_on",
                source: ref(refs.currentDecision),
                target: { id: "mx_missing_target", kind: "component" },
              },
            }],
          }
        : kind === "valid-then-invalid"
          ? {
              operations: [
                {
                  type: "update-entry",
                  entityId: refs.currentDecision,
                  summary: "This valid first item must be rolled back.",
                },
                {
                  type: "add-relation",
                  relation: {
                    type: "depends_on",
                    source: ref(refs.currentDecision),
                    target: { id: "mx_missing_target", kind: "component" },
                  },
                },
              ],
            }
        : kind === "outside-path"
          ? {
              operations: [{
                type: "move-entry",
                entityId: refs.currentDecision,
                destinationPath: "../../outside.md",
              }],
            }
          : {
            operations: [{
              type: "update-entry",
              entityId: refs.currentDecision,
              body: kind === "changed-replay"
                ? "A different payload must not reuse an accepted operation ID."
                : "Retry gateway timeouts with bounded backoff and the original idempotency key.",
            }],
          };
      return {
        operation: {
          opId: operationId,
          type: plan.operations[0]?.type ?? "update-entry",
          entityId: kind === "envelope-target-mismatch"
            ? refs.pattern
            : refs.currentDecision,
          baseRevision: kind === "envelope-base-mismatch"
            ? current.version.semanticRevision + 1
            : current.version.semanticRevision,
          baseContentHash: current.version.contentHash,
          actor: { kind: "human", id: "member_contract_reviewer" },
          reason: "Exercise the reusable WikiPort contract.",
          timestamp: "2026-08-22T00:00:00.000Z",
          payload: plan,
        },
        expectedRevisions: kind === "missing-precondition" ? [] : [{
          target: { kind: "entity", id: refs.currentDecision },
          version: current.version,
        }],
      } satisfies WikiOperationRequest<MockWikiOperationPlan>;
    },
    async makeConcurrentEdit() {
      const current = await port.getEntity(refs.currentDecision);
      if (!current) throw new Error("Current decision fixture is missing.");
      const payload: MockWikiOperationPlan = {
        operations: [{
          type: "update-entry",
          entityId: refs.currentDecision,
          summary: "A teammate updated this decision after the first preview.",
        }],
      };
      const request: WikiOperationRequest<MockWikiOperationPlan> = {
        operation: {
          opId: "operation_concurrent_edit",
          type: "update-entry",
          entityId: refs.currentDecision,
          baseRevision: current.version.semanticRevision,
          baseContentHash: current.version.contentHash,
          actor: { kind: "human", id: "member_concurrent_editor" },
          reason: "Simulate a concurrent accepted edit.",
          timestamp: "2026-08-22T00:01:00.000Z",
          payload,
        },
        expectedRevisions: [{
          target: { kind: "entity", id: refs.currentDecision },
          version: current.version,
        }],
      };
      const preview = await port.previewOperations(request);
      await port.applyOperations({
        ...request,
        plan: preview.plan,
        expectedPreviewRevision: preview.previewRevision,
      });
    },
    async makeUnindexedCanonicalEdits() {
      const selected = await port.getEntity(refs.currentDecision);
      const untouched = await port.getEntity(refs.pattern);
      if (!selected || !untouched) throw new Error("Refresh fixture entities are missing.");
      const selectedBody = "Manual decision edit awaiting an explicit targeted refresh.";
      const untouchedBody = "Manual pattern edit that must remain stale after the first refresh.";
      port.simulateManualBodyEdit(selected.ref.id, selectedBody);
      port.simulateManualBodyEdit(untouched.ref.id, untouchedBody);
      return {
        selected: {
          entityId: selected.ref.id,
          path: selected.location.path,
          body: selectedBody,
        },
        untouched: {
          entityId: untouched.ref.id,
          path: untouched.location.path,
          body: untouchedBody,
        },
      };
    },
    async makeMigrationConcurrentEdit(path) {
      const current = port.snapshot().files[path];
      if (current === undefined) throw new Error(`Migration file ${path} is missing.`);
      port.simulateManualFileEdit(
        path,
        `${current}\nConcurrent manual edit that migration must not overwrite.\n`,
      );
    },
    async snapshot() {
      const snapshot = port.snapshot();
      return {
        canonicalDigest: snapshot.canonicalDigest,
        indexDigest: snapshot.indexDigest,
        files: snapshot.files,
        canonicalWrites: snapshot.effects.canonicalWrites,
        indexRebuilds: snapshot.effects.indexRebuilds,
        indexRefreshes: snapshot.effects.indexRefreshes,
        auditEntries: snapshot.effects.auditEntries,
        agentLaunches: snapshot.effects.agentLaunches,
      };
    },
    async close() {},
  };
}

function ref(id: string): EntityRef {
  const entity = POPULATED_WIKI_FIXTURE.entities.find((candidate) => candidate.id === id);
  if (!entity) throw new Error(`Unknown populated fixture entity ${id}.`);
  return { id: entity.id, kind: entity.kind };
}

function invalidReferenceFixture(): PopulatedWikiFixture {
  return {
    ...POPULATED_WIKI_FIXTURE,
    relations: [
      ...POPULATED_WIKI_FIXTURE.relations,
      {
        type: "depends_on",
        source: ref(refs.spec),
        target: { id: "mx_missing_target", kind: "component" },
      },
    ],
  };
}

function loadLegacyMigration(): MockLegacyMigration {
  const paths = [
    ".mex/ROUTER.md",
    ".mex/context/architecture.md",
    ".mex/patterns/webhook-inbox.md",
    ".mex/events/decisions.jsonl",
  ] as const;
  const documents = Object.fromEntries(paths.map((path) => [path, readLegacyFile(path)]));
  const architecture = documents[".mex/context/architecture.md"]!;
  const migratedArchitecture = architecture.replace(
    'last_updated: "2026-08-01"\n---',
    [
      'last_updated: "2026-08-01"',
      "mex:",
      `  id: ${legacyEntityRef().id}`,
      "  type: architecture",
      "  status: promoted",
      "  revision: 1",
      "---",
    ].join("\n"),
  );
  const entity: MockWikiEntitySeed = {
    id: legacyEntityRef().id,
    kind: "architecture",
    title: "Checkout architecture",
    sourcePath: ".mex/context/architecture.md",
    lifecycleState: "promoted",
    groundingHealth: "unverified",
    semanticRevision: 1,
    payload: {
      summary: "Migrated checkout architecture.",
      body: architecture,
      topics: [],
      sources: [{ type: "manual", note: "Migrated legacy Wiki page" }],
      groundingCase: "unverified",
    },
  };
  return {
    documents,
    migratedDocuments: {
      ...documents,
      ".mex/context/architecture.md": migratedArchitecture,
    },
    entities: [entity],
  };
}

function legacyEntityRef(): EntityRef {
  return { id: "mx_01J0000000000000000000000A", kind: "architecture" };
}

function readLegacyFile(path: string): string {
  const fixtureRoot = fileURLToPath(new URL("./fixtures/wiki/legacy-scaffold/", import.meta.url));
  return readFileSync(`${fixtureRoot}${path}`, "utf8");
}
