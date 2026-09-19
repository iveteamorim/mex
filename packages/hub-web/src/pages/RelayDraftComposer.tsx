import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Plus, Save, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useHubApi } from "../api/context";
import { HubApiError } from "../api/client";
import { strictRelayPreviewEnvelope } from "../api/relay-client";
import type {
  RelayDraftDetail,
  RelayDraftInput,
  RelayEvidenceRef,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  TeamMember,
} from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/primitives/alert";
import { Button } from "../components/primitives/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "../components/primitives/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/primitives/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/primitives/field";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Separator } from "../components/primitives/separator";
import styles from "../styles/relay-draft-composer.module.css";

type RecipientRef = RelayDraftInput["recipients"][number];
type ReferenceRow = { kind: string; value: string; title: string };
type CodeRow = { kind: "file" | "symbol"; value: string; fingerprint: string };
type EvidenceRow = {
  kind: "entity" | "code" | "file" | "commit" | "external" | "manual";
  value: string;
  label: string;
  detail: string;
};
type PreviewAcceptance = "accepted" | "stale" | "mismatched";
type SaveProblem = {
  title: string;
  detail: string;
  diagnostics: readonly string[];
};
type RecipientChoice = {
  id: string;
  label: string;
  available: boolean;
  reference: RecipientRef;
};

export interface RelayDraftComposerProps {
  draft: RelayDraftDetail | null;
  members: readonly TeamMember[];
  membersError?: unknown;
  finalFocus(): HTMLElement | null;
  onClose(): void;
  onApplied(result: RelayOperationApplyResponse): Promise<void>;
  onRetryMembers?(): void;
  onAudienceChange(audience: "team" | "members"): void;
}

const PREVIEW_IDENTITY_ERROR = "The signed Relay preview did not exactly match the submitted request.";
const MEMBER_ID_PATTERN = /^member_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function canonicalRequestJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalRequestJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalRequestJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalRelaySet<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const leftKey = canonicalRequestJson(left);
    const rightKey = canonicalRequestJson(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function canonicalRelayRequest(request: RelayOperationPreviewRequest): RelayOperationPreviewRequest {
  if (request.action.kind !== "relay.draft.save") return request;
  return {
    ...request,
    action: {
      ...request.action,
      draft: {
        ...request.action.draft,
        recipients: canonicalRelaySet(request.action.draft.recipients),
        decisions: canonicalRelaySet(request.action.draft.decisions),
        changedFiles: canonicalRelaySet(request.action.draft.changedFiles),
        code: canonicalRelaySet(request.action.draft.code),
      },
    },
  };
}

function previewAcceptance(
  currentAttempt: number,
  expectedAttempt: number,
  expectedRequest: RelayOperationPreviewRequest,
  envelope: RelayOperationPreviewResponse,
): PreviewAcceptance {
  if (currentAttempt !== expectedAttempt) return "stale";
  const strictEnvelope = strictRelayPreviewEnvelope(envelope);
  if (!strictEnvelope) return "mismatched";
  if (
    strictEnvelope.request.operationId !== expectedRequest.operationId
    || canonicalRequestJson(canonicalRelayRequest(strictEnvelope.request))
      !== canonicalRequestJson(canonicalRelayRequest(expectedRequest))
  ) {
    return "mismatched";
  }
  return "accepted";
}

function operationId(): string {
  return `hub_relay_draft_save_${crypto.randomUUID().replaceAll("-", "")}`;
}

function draftExpectation(draft: RelayDraftDetail) {
  return {
    target: { kind: "local" as const, namespace: "relay-draft" as const, id: draft.id },
    revision: draft.revision,
  };
}

function evidenceToRows(evidence: readonly RelayEvidenceRef[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const item of evidence) {
    if (item.kind === "entity") rows.push({ kind: "entity", value: item.entity.id, label: item.entity.title ?? "", detail: item.entity.kind });
    if (item.kind === "code") rows.push({ kind: "code", value: item.code.kind === "file" ? item.code.path : item.code.symbolId, label: item.code.fingerprint ?? "", detail: item.code.kind });
    if (item.kind === "file") rows.push({ kind: "file", value: item.path, label: "", detail: "" });
    if (item.kind === "commit") rows.push({ kind: "commit", value: item.hash, label: "", detail: "" });
    if (item.kind === "external") rows.push({ kind: "external", value: item.uri, label: item.label ?? "", detail: "" });
    if (item.kind === "manual") rows.push({ kind: "manual", value: item.note, label: "", detail: "" });
  }
  return rows;
}

function StringRows({
  id,
  label,
  values,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  onChange(values: string[]): void;
}) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>{label}</FieldLegend>
      <div className={styles.repeatableRows}>
        {values.map((value, index) => (
          <div className={styles.repeatableRow} key={`${id}-${index}`}>
            <Input
              aria-label={`${label} ${index + 1}`}
              id={`${id}-${index}`}
              maxLength={4_096}
              onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
              value={value}
            />
            <Button
              aria-label={`Remove ${label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button disabled={values.length >= 64} onClick={() => onChange([...values, ""])} size="sm" type="button" variant="outline">
          <Plus aria-hidden="true" data-icon="inline-start" /> Add {label.toLowerCase()}
        </Button>
      </div>
    </FieldSet>
  );
}

function ReferenceRows({ values, onChange }: { values: ReferenceRow[]; onChange(values: ReferenceRow[]): void }) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>Decisions</FieldLegend>
      <FieldDescription>Optional Knowledge references that help explain the handoff.</FieldDescription>
      <div className={styles.repeatableRows}>
        {values.map((row, index) => (
          <div className={styles.referenceRow} key={`decision-${index}`}>
            <Input aria-label={`Decision title ${index + 1}`} maxLength={512} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} placeholder="Human-readable title" value={row.title} />
            <Input aria-label={`Decision kind ${index + 1}`} maxLength={64} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value } : item))} placeholder="Kind" value={row.kind} />
            <Input aria-label={`Decision ID ${index + 1}`} maxLength={256} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder="Knowledge ID" value={row.value} />
            <Button aria-label={`Remove decision ${index + 1}`} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
        ))}
        <Button disabled={values.length >= 64} onClick={() => onChange([...values, { kind: "decision", value: "", title: "" }])} size="sm" type="button" variant="outline"><Plus aria-hidden="true" data-icon="inline-start" /> Add decision</Button>
      </div>
    </FieldSet>
  );
}

function CodeRows({ values, onChange }: { values: CodeRow[]; onChange(values: CodeRow[]): void }) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>Code references</FieldLegend>
      <div className={styles.repeatableRows}>
        {values.map((row, index) => (
          <div className={styles.contextRow} key={`code-${index}`}>
            <NativeSelect aria-label={`Code type ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value as CodeRow["kind"] } : item))} value={row.kind}>
              <NativeSelectOption value="file">File</NativeSelectOption>
              <NativeSelectOption value="symbol">Symbol</NativeSelectOption>
            </NativeSelect>
            <Input aria-label={`Code reference ${index + 1}`} maxLength={1_024} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder={row.kind === "file" ? "src/path.ts" : "Symbol.name"} value={row.value} />
            <Button aria-label={`Remove code reference ${index + 1}`} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
        ))}
        <Button disabled={values.length >= 64} onClick={() => onChange([...values, { kind: "file", value: "", fingerprint: "" }])} size="sm" type="button" variant="outline"><Plus aria-hidden="true" data-icon="inline-start" /> Add code reference</Button>
      </div>
    </FieldSet>
  );
}

function EvidenceRows({ values, onChange }: { values: EvidenceRow[]; onChange(values: EvidenceRow[]): void }) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>Evidence</FieldLegend>
      <div className={styles.repeatableRows}>
        {values.map((row, index) => (
          <div className={styles.evidenceRow} key={`evidence-${index}`}>
            <NativeSelect aria-label={`Evidence type ${index + 1}`} onChange={(event) => {
              const kind = event.target.value as EvidenceRow["kind"];
              onChange(values.map((item, itemIndex) => itemIndex === index
                ? {
                    ...item,
                    kind,
                    detail: kind === "code"
                      ? (item.detail === "symbol" ? "symbol" : "file")
                      : kind === "entity" ? item.detail : "",
                  }
                : item));
            }} value={row.kind}>
              <NativeSelectOption value="entity">Knowledge</NativeSelectOption>
              <NativeSelectOption value="code">Code</NativeSelectOption>
              <NativeSelectOption value="file">File</NativeSelectOption>
              <NativeSelectOption value="commit">Commit</NativeSelectOption>
              <NativeSelectOption value="external">External link</NativeSelectOption>
              <NativeSelectOption value="manual">Note</NativeSelectOption>
            </NativeSelect>
            {row.kind === "code" ? (
              <NativeSelect aria-label={`Evidence code type ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, detail: event.target.value } : item))} value={row.detail || "file"}>
                <NativeSelectOption value="file">File</NativeSelectOption>
                <NativeSelectOption value="symbol">Symbol</NativeSelectOption>
              </NativeSelect>
            ) : row.kind === "entity" ? (
              <Input aria-label={`Evidence entity kind ${index + 1}`} maxLength={64} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, detail: event.target.value } : item))} placeholder="Knowledge kind" value={row.detail} />
            ) : <span className={styles.rowSpacer} aria-hidden="true" />}
            <Input aria-label={`Evidence value ${index + 1}`} maxLength={4_096} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder={row.kind === "external" ? "https://…" : row.kind === "file" || (row.kind === "code" && row.detail === "file") ? "path/to/file" : row.kind === "commit" ? "Git hash" : row.kind === "manual" ? "Evidence note" : "Reference ID"} value={row.value} />
            {row.kind === "external" || row.kind === "entity" ? (
              <Input aria-label={`Evidence label ${index + 1}`} maxLength={512} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder="Human-readable label" value={row.label} />
            ) : <span className={styles.rowSpacer} aria-hidden="true" />}
            <Button aria-label={`Remove evidence ${index + 1}`} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
        ))}
        <Button disabled={values.length >= 64} onClick={() => onChange([...values, { kind: "manual", value: "", label: "", detail: "" }])} size="sm" type="button" variant="outline"><Plus aria-hidden="true" data-icon="inline-start" /> Add evidence</Button>
      </div>
    </FieldSet>
  );
}

function technicalError(error: unknown): string[] {
  if (error instanceof HubApiError) {
    return [`${error.problem.code}: ${error.problem.detail}`, `Request: ${error.problem.requestId}`];
  }
  return error instanceof Error ? [error.message] : ["The operation failed without structured diagnostics."];
}

function humanError(error: unknown, fallback: string): SaveProblem {
  if (error instanceof HubApiError) {
    return { title: error.problem.title, detail: error.problem.detail, diagnostics: technicalError(error) };
  }
  return { title: "Draft not saved", detail: fallback, diagnostics: technicalError(error) };
}

export default function RelayDraftComposer({
  draft,
  members,
  membersError,
  finalFocus,
  onClose,
  onApplied,
  onRetryMembers,
  onAudienceChange,
}: RelayDraftComposerProps) {
  const api = useHubApi();
  const recipientsInputId = useId();
  const [audience, setAudience] = useState<"team" | "members">(draft ? draft.input.audience ?? "members" : "team");
  useEffect(() => { onAudienceChange(audience); }, [audience, onAudienceChange]);
  const recipientsAnchor = useComboboxAnchor();
  const eligibleMembers = useMemo(() => members.filter((member) => member.active), [members]);
  const [recipients, setRecipients] = useState<RecipientRef[]>(draft?.input.recipients ? [...draft.input.recipients] : []);
  const [manualRecipientId, setManualRecipientId] = useState("");
  const [summary, setSummary] = useState(draft?.input.summary ?? "");
  const [completed, setCompleted] = useState<string[]>(draft?.input.completed ? [...draft.input.completed] : []);
  const [inProgress, setInProgress] = useState<string[]>(draft?.input.inProgress ? [...draft.input.inProgress] : []);
  const [blockers, setBlockers] = useState<string[]>(draft?.input.blockers ? [...draft.input.blockers] : []);
  const [questions, setQuestions] = useState<string[]>(draft?.input.unresolvedQuestions ? [...draft.input.unresolvedQuestions] : []);
  const [files, setFiles] = useState<string[]>(draft?.input.changedFiles ? [...draft.input.changedFiles] : []);
  const [nextActions, setNextActions] = useState<string[]>(draft?.input.nextActions ? [...draft.input.nextActions] : []);
  const [decisions, setDecisions] = useState<ReferenceRow[]>(draft?.input.decisions.map((item) => ({ kind: item.kind, value: item.id, title: item.title ?? "" })) ?? []);
  const [code, setCode] = useState<CodeRow[]>(draft?.input.code.map((item) => ({ kind: item.kind, value: item.kind === "file" ? item.path : item.symbolId, fingerprint: item.fingerprint ?? "" })) ?? []);
  const [evidence, setEvidence] = useState<EvidenceRow[]>(draft ? evidenceToRows(draft.input.evidence) : []);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const generation = useRef(0);

  const recipientChoices = useMemo(() => {
    const choices = new Map<string, RecipientChoice>();
    for (const member of eligibleMembers) {
      const retainedReference = recipients.find((recipient) => recipient.memberId === member.id);
      choices.set(member.id, {
        id: member.id,
        label: member.displayName,
        available: true,
        reference: retainedReference
          ?? { kind: "member", memberId: member.id, displayName: member.displayName },
      });
    }
    for (const recipient of recipients) {
      if (!choices.has(recipient.memberId)) {
        choices.set(recipient.memberId, {
          id: recipient.memberId,
          label: recipient.displayName ?? "Unavailable team member",
          available: false,
          reference: recipient,
        });
      }
    }
    return [...choices.values()];
  }, [eligibleMembers, recipients]);
  const selectedRecipients = useMemo(() => {
    const choices = new Map(recipientChoices.map((choice) => [choice.id, choice]));
    return recipients.flatMap((recipient) => {
      const choice = choices.get(recipient.memberId);
      return choice ? [choice] : [];
    });
  }, [recipientChoices, recipients]);

  const apply = useMutation({
    mutationFn: async (envelope: RelayOperationPreviewResponse) => {
      const result = await api.applyRelayOperation(envelope);
      await onApplied(result);
      return result;
    },
    onSuccess: () => {
      onClose();
      queueMicrotask(() => finalFocus()?.focus({ preventScroll: true }));
    },
    onError: (error) => setProblem(humanError(error, "The exact local preview was not applied. Your draft content remains in the editor.")),
  });
  const preview = useMutation({
    mutationFn: ({ request }: { request: RelayOperationPreviewRequest; attempt: number }) => api.previewRelayOperation(request),
  });

  useEffect(() => () => { generation.current += 1; }, []);

  const invalidate = () => {
    generation.current += 1;
    setProblem(null);
  };
  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    invalidate();
    setter(value);
  };
  const close = () => {
    if (preview.isPending || apply.isPending) return;
    onClose();
    queueMicrotask(() => finalFocus()?.focus({ preventScroll: true }));
  };
  const addRecipientById = () => {
    const memberId = manualRecipientId.trim();
    if (!MEMBER_ID_PATTERN.test(memberId)) {
      setProblem({
        title: "Enter a valid Member ID",
        detail: "Use the Member ID recorded in project memory, or choose an active teammate in the searchable selector.",
        diagnostics: [],
      });
      return;
    }
    if (recipients.some((recipient) => recipient.memberId === memberId)) {
      setProblem({
        title: "That recipient is already included",
        detail: "Choose another Member or continue editing the handoff.",
        diagnostics: [],
      });
      return;
    }
    if (recipients.length >= 32) {
      setProblem({
        title: "Recipient limit reached",
        detail: "A Relay draft can record at most 32 eligible recipients.",
        diagnostics: [],
      });
      return;
    }
    invalidate();
    setRecipients([...recipients, { kind: "member", memberId }]);
    setManualRecipientId("");
  };
  const buildInput = (): RelayDraftInput | null => {
    const clean = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
    const invalidEvidence = evidence.some((row) => row.value.trim() && (
      (row.kind === "entity" && !row.detail.trim())
      || (row.kind === "code" && row.detail !== "file" && row.detail !== "symbol")
    ));
    if (
      !summary.trim()
      || recipients.length > 32
      || recipients.some((recipient) => !MEMBER_ID_PATTERN.test(recipient.memberId))
      || invalidEvidence
    ) {
      setProblem({
        title: "Finish the required handoff details",
        detail: "Add a summary and complete any Knowledge or code evidence fields before saving. Recipients can be chosen before publication.",
        diagnostics: [],
      });
      return null;
    }
    return {
      ...(audience === "members" && draft !== null && draft.input.audience === undefined ? {} : { audience }),
      recipients: audience === "team" ? [] : recipients,
      summary: summary.trim(),
      completed: clean(completed),
      inProgress: clean(inProgress),
      decisions: decisions.filter((row) => row.kind.trim() && row.value.trim()).map((row) => ({ id: row.value.trim(), kind: row.kind.trim(), ...(row.title.trim() ? { title: row.title.trim() } : {}) })),
      blockers: clean(blockers),
      unresolvedQuestions: clean(questions),
      changedFiles: clean(files),
      code: code.filter((row) => row.value.trim()).map((row) => row.kind === "file"
        ? { kind: "file" as const, path: row.value.trim(), ...(row.fingerprint.trim() ? { fingerprint: row.fingerprint.trim() } : {}) }
        : { kind: "symbol" as const, symbolId: row.value.trim(), ...(row.fingerprint.trim() ? { fingerprint: row.fingerprint.trim() } : {}) }),
      evidence: evidence.filter((row) => row.value.trim()).map((row) => {
        if (row.kind === "entity") {
          return { kind: "entity" as const, entity: { id: row.value.trim(), kind: row.detail.trim(), ...(row.label.trim() ? { title: row.label.trim() } : {}) } };
        }
        if (row.kind === "code") {
          return row.detail === "symbol"
            ? { kind: "code" as const, code: { kind: "symbol" as const, symbolId: row.value.trim(), ...(row.label.trim() ? { fingerprint: row.label.trim() } : {}) } }
            : { kind: "code" as const, code: { kind: "file" as const, path: row.value.trim(), ...(row.label.trim() ? { fingerprint: row.label.trim() } : {}) } };
        }
        if (row.kind === "file") return { kind: "file" as const, path: row.value.trim() };
        if (row.kind === "commit") return { kind: "commit" as const, hash: row.value.trim() };
        if (row.kind === "external") return { kind: "external" as const, uri: row.value.trim(), ...(row.label.trim() ? { label: row.label.trim() } : {}) };
        return { kind: "manual" as const, note: row.value.trim() };
      }),
      nextActions: clean(nextActions),
    };
  };
  const save = () => {
    const input = buildInput();
    if (!input) return;
    const attempt = ++generation.current;
    setProblem(null);
    const request: RelayOperationPreviewRequest = {
      operationId: operationId(),
      action: { kind: "relay.draft.save", ...(draft ? { draftId: draft.id } : {}), draft: input },
      expectedRevisions: draft ? [draftExpectation(draft)] : [],
    };
    preview.mutate({ request, attempt }, {
      onError: (error) => {
        if (generation.current !== attempt) return;
        setProblem(humanError(error, "MEX could not safely check this local draft. Nothing was applied."));
      },
      onSuccess: (result) => {
        const acceptance = previewAcceptance(generation.current, attempt, request, result);
        if (acceptance === "stale") return;
        if (acceptance === "mismatched") {
          setProblem({
            title: "The draft changed while it was being checked",
            detail: "Nothing was applied. Save again to prepare a fresh local preview.",
            diagnostics: [PREVIEW_IDENTITY_ERROR],
          });
          return;
        }
        if (!result.preview.valid) {
          setProblem({
            title: "This draft cannot be saved yet",
            detail: "The current checkout did not pass every required safety check. Nothing was applied.",
            diagnostics: result.preview.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
          });
          return;
        }
        apply.mutate(result);
      },
    });
  };
  const busy = preview.isPending || apply.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent aria-busy={busy || undefined} className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>{draft ? "Edit handoff draft" : "Create handoff draft"}</DialogTitle>
          <DialogDescription>
            Keep the handoff focused on what the next teammate needs. Saving changes only this checkout-local draft.
          </DialogDescription>
        </DialogHeader>

        <div className={styles.scrollRegion} inert={apply.isPending || undefined}>
          {audience === "members" && membersError ? (
            <Alert className={styles.referenceWarning}>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Some project references could not be loaded</AlertTitle>
              <AlertDescription>
                {membersError ? <p>{membersError instanceof HubApiError ? membersError.problem.detail : "The active Member list is unavailable. Use an existing recipient or add a raw Member ID under Advanced."}</p> : null}
                <span className={styles.referenceWarningActions}>
                  {membersError && onRetryMembers ? <Button onClick={onRetryMembers} size="sm" type="button" variant="outline">Retry Members</Button> : null}
                </span>
              </AlertDescription>
            </Alert>
          ) : null}
          <section className={styles.formSection} aria-labelledby="relay-draft-core-heading">
            <div className={styles.sectionHeading}>
              <p>Core handoff</p>
              <h3 id="relay-draft-core-heading">What your teammate needs</h3>
            </div>
            <FieldGroup className={styles.fieldGroup}>
              <Field>
                <FieldLabel htmlFor="relay-draft-audience">Who can take this handoff?</FieldLabel>
                <NativeSelect className={styles.audienceSelect} id="relay-draft-audience" value={audience} onChange={(event) => change(setAudience)(event.target.value as "team" | "members")}>
                  <NativeSelectOption value="team">Open to team</NativeSelectOption>
                  <NativeSelectOption value="members">Named Members</NativeSelectOption>
                </NativeSelect>
                <FieldDescription>{audience === "team"
                  ? "Any active Member can take the published handoff, including teammates who join later."
                  : "Only the Members you name can take it. You can choose them later while this is a local draft."}</FieldDescription>
              </Field>
              {audience === "members" ? <Field>
                <FieldLabel htmlFor={recipientsInputId}>Eligible recipients</FieldLabel>
                <Combobox
                  isItemEqualToValue={(item: RecipientChoice, value: RecipientChoice) => item.id === value.id}
                  itemToStringLabel={(item: RecipientChoice) => item.label}
                  itemToStringValue={(item: RecipientChoice) => item.id}
                  items={recipientChoices}
                  multiple
                  onValueChange={(choices: RecipientChoice[]) => change(setRecipients)(choices.slice(0, 32).map((choice) => choice.reference))}
                  value={selectedRecipients}
                >
                  <ComboboxChips className={styles.recipientChips} ref={recipientsAnchor}>
                    <ComboboxValue>
                      {(choices: RecipientChoice[]) => (
                        <>
                          {choices.map((choice) => <ComboboxChip key={choice.id} removeAriaLabel={`Remove ${choice.label}`}>{choice.label}</ComboboxChip>)}
                          <ComboboxChipsInput
                            id={recipientsInputId}
                            placeholder={choices.length ? "Add another teammate…" : "Search active team members…"}
                          />
                        </>
                      )}
                    </ComboboxValue>
                  </ComboboxChips>
                  <ComboboxContent anchor={recipientsAnchor}>
                    <ComboboxEmpty>No eligible Members found.</ComboboxEmpty>
                    <ComboboxList>
                      {recipientChoices.map((choice) => (
                        <ComboboxItem key={choice.id} value={choice}>
                          <span className={styles.recipientOption}>
                            <strong>{choice.label}</strong>
                            {!choice.available ? <small>Unavailable for new publication</small> : null}
                          </span>
                        </ComboboxItem>
                      ))}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <FieldDescription>Optional for a local draft. Publication requires at least one active Member.</FieldDescription>
              </Field> : null}

              <Field data-invalid={!summary.trim() || undefined}>
                <FieldLabel htmlFor="relay-draft-summary">Summary</FieldLabel>
                <Input aria-invalid={!summary.trim()} id="relay-draft-summary" maxLength={8_192} onChange={(event) => change(setSummary)(event.target.value)} placeholder="What should the next person understand first?" value={summary} />
              </Field>
            </FieldGroup>

            <div className={styles.coreGrid}>
              <StringRows id="relay-draft-actions" label="Next actions" onChange={change(setNextActions)} values={nextActions} />
              <StringRows id="relay-draft-progress" label="In progress" onChange={change(setInProgress)} values={inProgress} />
              <StringRows id="relay-draft-blockers" label="Blockers" onChange={change(setBlockers)} values={blockers} />
              <StringRows id="relay-draft-questions" label="Unresolved questions" onChange={change(setQuestions)} values={questions} />
            </div>
          </section>

          <Separator />

          <Collapsible className={styles.disclosure}>
            <CollapsibleTrigger aria-label="Additional context" render={<Button type="button" variant="ghost" />}>
              <ChevronDown aria-hidden="true" data-icon="inline-start" />
              <span><strong>Additional context</strong><small>Completed work, decisions, files, code, and evidence</small></span>
            </CollapsibleTrigger>
            <CollapsibleContent className={styles.disclosureContent}>
              <StringRows id="relay-draft-completed" label="Completed" onChange={change(setCompleted)} values={completed} />
              <ReferenceRows onChange={change(setDecisions)} values={decisions} />
              <StringRows id="relay-draft-files" label="Files involved" onChange={change(setFiles)} values={files} />
              <CodeRows onChange={change(setCode)} values={code} />
              <EvidenceRows onChange={change(setEvidence)} values={evidence} />
            </CollapsibleContent>
          </Collapsible>

          <Collapsible className={styles.disclosure} onOpenChange={setAdvancedOpen} open={advancedOpen}>
            <CollapsibleTrigger aria-label="Advanced" render={<Button type="button" variant="ghost" />}>
              <ChevronDown aria-hidden="true" data-icon="inline-start" />
              <span><strong>Advanced</strong><small>Structural IDs and fingerprints</small></span>
            </CollapsibleTrigger>
            <CollapsibleContent className={styles.disclosureContent}>
              {draft ? (
                <dl className={styles.technicalMeta}>
                  <div><dt>Draft ID</dt><dd><code>{draft.id}</code></dd></div>
                  <div><dt>Exact draft revision</dt><dd><code>{draft.revision}</code></dd></div>
                </dl>
              ) : null}

              {audience === "members" ? <FieldSet className={styles.fieldSet}>
                <FieldLegend>Recipient references</FieldLegend>
                <div className={styles.technicalList}>
                  {recipients.length ? recipients.map((recipient) => (
                    <p key={recipient.memberId}><span>{recipient.displayName ?? "Team member"}</span><code>{recipient.memberId}</code></p>
                  )) : <p>No recipient references selected.</p>}
                </div>
                <div className={styles.advancedPair}>
                  <Input
                    aria-label="Recipient Member ID"
                    maxLength={33}
                    onChange={(event) => change(setManualRecipientId)(event.target.value)}
                    placeholder="member_…"
                    value={manualRecipientId}
                  />
                  <Button onClick={addRecipientById} type="button" variant="outline">
                    <Plus aria-hidden="true" data-icon="inline-start" /> Add recipient ID
                  </Button>
                </div>
                <FieldDescription>Use a raw Member ID only when the project Member list cannot be read. Publication still verifies that recipient exactly.</FieldDescription>
              </FieldSet> : null}

              {code.length || evidence.some((row) => row.kind === "code") ? (
                <FieldSet className={styles.fieldSet}>
                  <FieldLegend>Code fingerprints</FieldLegend>
                  <FieldDescription>Optional exact fingerprints are preserved even when this section stays closed.</FieldDescription>
                  <div className={styles.repeatableRows}>
                    {code.map((row, index) => (
                      <div className={styles.fingerprintRow} key={`code-fingerprint-${index}`}>
                        <code>{row.value || `Code reference ${index + 1}`}</code>
                        <Input aria-label={`Code fingerprint ${index + 1}`} maxLength={1_024} onChange={(event) => change(setCode)(code.map((item, itemIndex) => itemIndex === index ? { ...item, fingerprint: event.target.value } : item))} placeholder="Fingerprint (optional)" value={row.fingerprint} />
                      </div>
                    ))}
                    {evidence.map((row, index) => row.kind === "code" ? (
                      <div className={styles.fingerprintRow} key={`evidence-fingerprint-${index}`}>
                        <code>{row.value || `Evidence reference ${index + 1}`}</code>
                        <Input aria-label={`Evidence code fingerprint ${index + 1}`} maxLength={1_024} onChange={(event) => change(setEvidence)(evidence.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder="Fingerprint (optional)" value={row.label} />
                      </div>
                    ) : null)}
                  </div>
                </FieldSet>
              ) : null}
            </CollapsibleContent>
          </Collapsible>

          <div aria-live="assertive" className={styles.status}>
            {problem ? (
              <div>
                <Alert variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{problem.title}</AlertTitle>
                  <AlertDescription>{problem.detail}</AlertDescription>
                </Alert>
                {problem.diagnostics.length ? (
                  <Collapsible className={styles.diagnostics}>
                    <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
                      <ChevronDown aria-hidden="true" data-icon="inline-start" /> Technical details
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul>{problem.diagnostics.map((diagnostic, index) => <li key={`${index}:${diagnostic}`}><code>{diagnostic}</code></li>)}</ul>
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button disabled={busy} onClick={close} type="button" variant="outline">Cancel</Button>
          <Button disabled={busy} onClick={save} type="button">
            <Save aria-hidden="true" data-icon="inline-start" />
            {apply.isPending ? "Saving…" : preview.isPending ? "Checking…" : "Save draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
