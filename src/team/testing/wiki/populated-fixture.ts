import type { GroundingHealth } from "../../contracts/shared.js";
import type { WikiRelation } from "../../contracts/wiki.js";

/**
 * Semantic fixture data for consumer contract tests. This is not a canonical
 * Markdown schema and must not be used by the real Wiki adapter.
 */
export interface MockWikiPayload {
  summary: string;
  body: string;
  topics: readonly string[];
  sources: readonly Readonly<Record<string, unknown>>[];
  groundingCase?: "renamed" | "changed" | "ambiguous" | "missing" | "unverified";
}

export interface MockWikiEntitySeed {
  id: string;
  kind: string;
  title: string;
  sourcePath: string;
  lifecycleState: "in_flight" | "promoted" | "deprecated" | "archived";
  groundingHealth: GroundingHealth;
  semanticRevision: number;
  payload: MockWikiPayload;
}

export interface PopulatedWikiFixture {
  entities: readonly MockWikiEntitySeed[];
  relations: readonly WikiRelation[];
  refs: {
    topic: string;
    spec: string;
    requirement: string;
    acceptanceCriterion: string;
    currentDecision: string;
    oldDecision: string;
    pattern: string;
    risk: string;
    evidence: string;
    archivedDecision: string;
  };
}

const refs = {
  topic: "mx_01J00000000000000000000001",
  spec: "mx_01J00000000000000000000002",
  requirement: "mx_01J00000000000000000000003",
  acceptanceCriterion: "mx_01J00000000000000000000004",
  currentDecision: "mx_01J00000000000000000000005",
  oldDecision: "mx_01J00000000000000000000006",
  pattern: "mx_01J00000000000000000000007",
  risk: "mx_01J00000000000000000000008",
  evidence: "mx_01J00000000000000000000009",
  archivedDecision: "mx_01J0000000000000000000000B",
} as const;

export const POPULATED_WIKI_FIXTURE: PopulatedWikiFixture = {
  refs,
  entities: [
    {
      id: refs.topic,
      kind: "topic",
      title: "Checkout reliability",
      sourcePath: ".mex/topics/checkout-reliability.md",
      lifecycleState: "promoted",
      groundingHealth: "unverified",
      semanticRevision: 1,
      payload: {
        summary: "Knowledge related to safe and repeatable checkout processing.",
        body: "Checkout changes must remain recoverable across retries and delayed delivery.",
        topics: [],
        sources: [{ type: "manual", note: "Maintainer-defined topic" }],
        groundingCase: "unverified",
      },
    },
    {
      id: refs.spec,
      kind: "spec",
      title: "Idempotent payment capture",
      sourcePath: ".mex/specs/idempotent-payment-capture.md",
      lifecycleState: "promoted",
      groundingHealth: "fresh",
      semanticRevision: 3,
      payload: {
        summary: "Capture a payment at most once for one checkout attempt.",
        body: "Every capture request carries the attempt's stable idempotency key.",
        topics: [refs.topic],
        sources: [{ type: "commit", ref: "8f21a3c" }],
      },
    },
    {
      id: refs.requirement,
      kind: "requirement",
      title: "Persist attempt before gateway call",
      sourcePath: ".mex/specs/idempotent-payment-capture.md",
      lifecycleState: "promoted",
      groundingHealth: "changed",
      semanticRevision: 2,
      payload: {
        summary: "Record the capture attempt before calling the payment gateway.",
        body: "The attempt and retry key are durable before any external side effect.",
        topics: [refs.topic],
        sources: [{ type: "symbol", ref: "function:persistCaptureAttempt" }],
        groundingCase: "changed",
      },
    },
    {
      id: refs.acceptanceCriterion,
      kind: "acceptance_criterion",
      title: "Duplicate delivery charges once",
      sourcePath: ".mex/specs/idempotent-payment-capture.md",
      lifecycleState: "promoted",
      groundingHealth: "fresh",
      semanticRevision: 1,
      payload: {
        summary: "Repeated delivery produces one gateway charge.",
        body: "Given the same delivery twice, the gateway receives one capture operation.",
        topics: [refs.topic],
        sources: [{ type: "test", ref: "payment-capture-idempotency" }],
      },
    },
    {
      id: refs.currentDecision,
      kind: "decision",
      title: "Back off with a stable idempotency key",
      sourcePath: ".mex/context/decisions.md",
      lifecycleState: "promoted",
      groundingHealth: "fresh",
      semanticRevision: 4,
      payload: {
        summary: "Retry gateway timeouts with backoff and the original key.",
        body: "A reconciled symbol rename keeps this decision fresh and connected.",
        topics: [refs.topic],
        sources: [{ type: "symbol", ref: "function:retryPaymentCapture" }],
        groundingCase: "renamed",
      },
    },
    {
      id: refs.oldDecision,
      kind: "decision",
      title: "Retry immediately",
      sourcePath: ".mex/context/decisions.md",
      lifecycleState: "deprecated",
      groundingHealth: "fresh",
      semanticRevision: 2,
      payload: {
        summary: "Historical retry policy retained for provenance.",
        body: "Immediate retries were replaced after duplicate capture incidents.",
        topics: [refs.topic],
        sources: [{ type: "manual", note: "Historical decision" }],
      },
    },
    {
      id: refs.pattern,
      kind: "pattern",
      title: "Webhook inbox table",
      sourcePath: ".mex/patterns/webhook-inbox.md",
      lifecycleState: "promoted",
      groundingHealth: "ambiguous",
      semanticRevision: 1,
      payload: {
        summary: "Store webhook deliveries before processing and retry safely.",
        body: "The webhook inbox deduplicates delivery IDs before payment capture.",
        topics: [refs.topic],
        sources: [{ type: "symbol", ref: "method:handleWebhook" }],
        groundingCase: "ambiguous",
      },
    },
    {
      id: refs.risk,
      kind: "risk",
      title: "Double capture after timeout",
      sourcePath: ".mex/context/risks.md",
      lifecycleState: "in_flight",
      groundingHealth: "missing",
      semanticRevision: 1,
      payload: {
        summary: "A lost response can lead a caller to repeat a successful capture.",
        body: "The former gateway wrapper no longer exists in this checkout.",
        topics: [refs.topic],
        sources: [{ type: "issue", ref: "PAY-42" }],
        groundingCase: "missing",
      },
    },
    {
      id: refs.evidence,
      kind: "fact",
      title: "Payment retry integration evidence",
      sourcePath: ".mex/context/payment-evidence.md",
      lifecycleState: "promoted",
      groundingHealth: "unverified",
      semanticRevision: 1,
      payload: {
        summary: "The idempotency test passed in the integration fixture.",
        body: "The evidence is explicit but is not a code grounding.",
        topics: [refs.topic],
        sources: [{ type: "test", ref: "payment-capture-idempotency" }],
        groundingCase: "unverified",
      },
    },
    {
      id: refs.archivedDecision,
      kind: "decision",
      title: "Poll legacy webhooks continuously",
      sourcePath: ".mex/context/archived-decisions.md",
      lifecycleState: "archived",
      groundingHealth: "unverified",
      semanticRevision: 3,
      payload: {
        summary: "Archived polling policy retained only for historical review.",
        body: "Continuous webhook polling was retired when the inbox pattern shipped.",
        topics: [refs.topic],
        sources: [{ type: "manual", note: "Archived historical decision" }],
        groundingCase: "unverified",
      },
    },
  ],
  relations: [
    {
      type: "depends_on",
      source: { id: refs.spec, kind: "spec" },
      target: { id: refs.currentDecision, kind: "decision" },
    },
    {
      type: "derived_from",
      source: { id: refs.requirement, kind: "requirement" },
      target: { id: refs.spec, kind: "spec" },
    },
    {
      type: "verified_by",
      source: { id: refs.acceptanceCriterion, kind: "acceptance_criterion" },
      target: { id: refs.evidence, kind: "fact" },
    },
    {
      type: "supersedes",
      source: { id: refs.currentDecision, kind: "decision" },
      target: { id: refs.oldDecision, kind: "decision" },
    },
    {
      type: "implements",
      source: { id: refs.pattern, kind: "pattern" },
      target: { id: refs.currentDecision, kind: "decision" },
    },
    {
      type: "affects",
      source: { id: refs.risk, kind: "risk" },
      target: { id: refs.spec, kind: "spec" },
    },
  ],
};
