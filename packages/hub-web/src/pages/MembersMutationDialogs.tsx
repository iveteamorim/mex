import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleUserRound,
  GitBranch,
  Mail,
  Plus,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useHubApi } from "../api/context";
import type {
  TeamCurrentActorResponse,
  TeamGitAlias,
  TeamMember,
  TeamOperationApplyResponse,
  TeamOperationPreviewRequest,
  TeamOperationPreviewResponse,
} from "../api/types";
import { TeamOperationPreviewPanel } from "../components/TeamOperationReview";
import { Alert, AlertDescription, AlertTitle } from "../components/primitives/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Button } from "../components/primitives/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../components/primitives/combobox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/primitives/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/primitives/field";
import { Input } from "../components/primitives/input";
import { ErrorState } from "../components/ui";
import styles from "../styles/members-mutations.module.css";

const MAX_ALIASES = 32;
const textEncoder = new TextEncoder();

interface AliasRow {
  key: string;
  name: string;
  email: string;
}

interface MemberChoice {
  id: string;
  label: string;
  email: string | null;
  member: TeamMember;
}

interface OperationProblem {
  title: string;
  detail: string;
}

export type MembersOperation =
  | {
    kind: "add";
    intent: "self" | "team";
    prefill?: { name: string | null; email: string | null };
  }
  | { kind: "update"; member: TeamMember }
  | { kind: "reactivate"; member: TeamMember }
  | {
    kind: "choose";
    initialMembers: readonly TeamMember[];
    preselected?: TeamMember;
  }
  | { kind: "clear" };

function operationId(kind: MembersOperation["kind"]): string {
  return `hub_member_${kind}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function memberExpectation(member: TeamMember) {
  return {
    target: { kind: "artifact" as const, path: member.sourcePath },
    revision: member.revision,
  };
}

function selectionExpectation(current: TeamCurrentActorResponse | undefined) {
  return {
    target: {
      kind: "local" as const,
      namespace: "member-selection" as const,
      id: "current" as const,
    },
    revision: current?.selection?.revision ?? null,
  };
}

function stableRequest(value: TeamOperationPreviewRequest): string {
  return JSON.stringify(value);
}

function canonicalField(value: string): string {
  return value.trim().normalize("NFC");
}

function aliasSortKey(alias: TeamGitAlias): string {
  return `${alias.email?.toLowerCase() ?? ""}\0${alias.name ?? ""}`;
}

function canonicalAliases(aliases: readonly TeamGitAlias[]): TeamGitAlias[] {
  return aliases
    .map((alias) => ({
      name: alias.name === null ? null : canonicalField(alias.name),
      email: alias.email === null ? null : canonicalField(alias.email),
    }))
    .sort((left, right) => {
      const leftKey = aliasSortKey(left);
      const rightKey = aliasSortKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function aliasRows(aliases: readonly TeamGitAlias[]): AliasRow[] {
  return aliases.map((alias) => ({
    key: crypto.randomUUID(),
    name: alias.name ?? "",
    email: alias.email ?? "",
  }));
}

function prepareAliases(rows: readonly AliasRow[]): {
  aliases: TeamGitAlias[];
  error: string | null;
  hasNameOnly: boolean;
} {
  if (rows.length > MAX_ALIASES) {
    return { aliases: [], error: `Use no more than ${MAX_ALIASES} Git identities.`, hasNameOnly: false };
  }
  const aliases: TeamGitAlias[] = [];
  const seen = new Set<string>();
  let hasNameOnly = false;
  for (const row of rows) {
    const name = canonicalField(row.name) || null;
    const email = canonicalField(row.email) || null;
    if (name === null && email === null) {
      return {
        aliases: [],
        error: "Enter a Git name or email for each identity, or remove the empty identity.",
        hasNameOnly: false,
      };
    }
    if (name !== null && textEncoder.encode(name).byteLength > 200) {
      return { aliases: [], error: "A Git name is too long.", hasNameOnly: false };
    }
    if (email !== null && textEncoder.encode(email).byteLength > 320) {
      return { aliases: [], error: "A Git email is too long.", hasNameOnly: false };
    }
    if (email !== null && (!email.includes("@") || /\s/.test(email))) {
      return { aliases: [], error: `Enter a valid Git email for ${email}.`, hasNameOnly: false };
    }
    const alias = { name, email };
    const key = aliasSortKey(alias);
    if (seen.has(key)) {
      return { aliases: [], error: "Each Git identity must be unique.", hasNameOnly: false };
    }
    seen.add(key);
    hasNameOnly ||= name !== null && email === null;
    aliases.push(alias);
  }
  return { aliases: canonicalAliases(aliases), error: null, hasNameOnly };
}

function memberChoice(member: TeamMember): MemberChoice {
  return {
    id: member.id,
    label: member.displayName,
    email: member.gitAliases.find((alias) => alias.email !== null)?.email ?? null,
    member,
  };
}

function PreviewTechnicalDetails({ envelope }: { envelope: TeamOperationPreviewResponse }) {
  return (
    <Collapsible className={styles.technicalDisclosure}>
      <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
        <ChevronDown data-icon="inline-start" /> Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className={styles.technicalContent}>
        <TeamOperationPreviewPanel envelope={envelope} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function CanonicalMemberDialog({
  operation,
  onApplied,
  onClose,
}: {
  operation: Extract<MembersOperation, { kind: "add" | "update" }>;
  onApplied(result: TeamOperationApplyResponse, operation: MembersOperation, member?: TeamMember): Promise<void>;
  onClose(): void;
}) {
  const api = useHubApi();
  const displayNameId = useId();
  const operationKey = useRef(operationId(operation.kind));
  const generation = useRef(0);
  const initialAliases = operation.kind === "update"
    ? operation.member.gitAliases
    : operation.prefill && (operation.prefill.name !== null || operation.prefill.email !== null)
      ? [{ name: operation.prefill.name, email: operation.prefill.email }]
      : [];
  const [displayName, setDisplayName] = useState(
    operation.kind === "update" ? operation.member.displayName : operation.prefill?.name ?? "",
  );
  const [rows, setRows] = useState<AliasRow[]>(() => (
    initialAliases.length > 0
      ? aliasRows(initialAliases)
      : operation.kind === "add"
        ? [{ key: crypto.randomUUID(), name: "", email: "" }]
        : []
  ));
  const [envelope, setEnvelope] = useState<TeamOperationPreviewResponse | null>(null);
  const [invalidEnvelope, setInvalidEnvelope] = useState<TeamOperationPreviewResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [problem, setProblem] = useState<OperationProblem | null>(null);
  const aliases = useMemo(() => prepareAliases(rows), [rows]);
  const cleanName = canonicalField(displayName);
  const nameError = cleanName.length === 0
    ? "Enter a display name."
    : textEncoder.encode(cleanName).byteLength > 200
      ? "Display name is too long."
      : null;
  const unchanged = operation.kind === "update"
    && cleanName === operation.member.displayName
    && JSON.stringify(aliases.aliases) === JSON.stringify(canonicalAliases(operation.member.gitAliases));
  const canReview = nameError === null && aliases.error === null && !unchanged;

  const invalidate = () => {
    generation.current += 1;
    operationKey.current = operationId(operation.kind);
    setEnvelope(null);
    setInvalidEnvelope(null);
    setConfirmOpen(false);
    setProblem(null);
    if (!preview.isPending) preview.reset();
    if (!apply.isPending) apply.reset();
  };

  const setAliasValue = (key: string, field: "name" | "email", value: string) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, [field]: value } : row));
    invalidate();
  };

  const buildRequest = (): TeamOperationPreviewRequest => operation.kind === "add"
    ? {
      operationId: operationKey.current,
      action: {
        kind: "member.add",
        member: { displayName: cleanName, gitAliases: aliases.aliases },
      },
      expectedRevisions: [],
    }
    : {
      operationId: operationKey.current,
      action: {
        kind: "member.update",
        memberId: operation.member.id,
        patch: { displayName: cleanName, gitAliases: aliases.aliases },
      },
      expectedRevisions: [memberExpectation(operation.member)],
    };

  const preview = useMutation({
    mutationFn: ({ request }: { request: TeamOperationPreviewRequest; attempt: number }) => (
      api.previewTeamOperation(request)
    ),
    onError: (_error, variables) => {
      if (variables.attempt !== generation.current) {
        setProblem({
          title: "The member fields changed while MEX was checking them",
          detail: "Nothing was applied. Review the current fields again.",
        });
      }
    },
    onSuccess: (result, variables) => {
      if (variables.attempt !== generation.current) {
        setProblem({
          title: "The member fields changed while MEX was checking them",
          detail: "Nothing was applied. Review the current fields again.",
        });
        return;
      }
      if (stableRequest(result.request) !== stableRequest(variables.request)) {
        setProblem({
          title: "The reviewed member did not match this form",
          detail: "Nothing was applied. Close this dialog and try again.",
        });
        return;
      }
      if (!result.preview.valid) {
        setInvalidEnvelope(result);
        setProblem({
          title: "This member cannot be saved yet",
          detail: "The checkout did not pass every required safety check. Nothing was applied.",
        });
        return;
      }
      setEnvelope(result);
      setConfirmOpen(true);
    },
  });
  const apply = useMutation({
    mutationFn: (accepted: TeamOperationPreviewResponse) => api.applyTeamOperation(accepted),
    onSuccess: async (result) => {
      setConfirmOpen(false);
      await onApplied(result, operation);
      onClose();
    },
  });
  const review = () => {
    const attempt = generation.current;
    const request = buildRequest();
    setProblem(null);
    setInvalidEnvelope(null);
    preview.mutate({ request, attempt });
  };
  const busy = preview.isPending || apply.isPending;
  const title = operation.kind === "update"
    ? `Edit ${operation.member.displayName}`
    : operation.intent === "self"
      ? "Add yourself"
      : "Add team member";

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        aria-busy={busy || undefined}
        className={styles.memberDialog}
        finalFocus={false}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {operation.kind === "add"
              ? "Create a shared MEX identity record for attribution and handoff routing."
              : "Update the name and Git identities MEX uses for attribution."}
          </DialogDescription>
        </DialogHeader>

        <div className={styles.formScroll} inert={apply.isPending || undefined}>
          <Alert className={styles.privacyAlert}>
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>Shared through Git, not an invitation</AlertTitle>
            <AlertDescription>
              Names and emails are committed to the repository and may become public history in a public repository. This does not invite anyone or grant repository access.
            </AlertDescription>
          </Alert>

          <FieldGroup className={styles.fieldGroup}>
            <Field data-invalid={nameError !== null || undefined}>
              <FieldLabel htmlFor={displayNameId}>Display name</FieldLabel>
              <Input
                aria-invalid={nameError !== null || undefined}
                autoFocus
                id={displayNameId}
                maxLength={200}
                onChange={(event) => {
                  setDisplayName(event.currentTarget.value);
                  invalidate();
                }}
                placeholder="Ada Lovelace"
                value={displayName}
              />
              <FieldDescription>The human name teammates will see in MEX.</FieldDescription>
              {displayName.length > 0 ? <FieldError>{nameError}</FieldError> : null}
            </Field>

            <FieldSet className={styles.aliasFieldset}>
              <FieldLegend>Recognized Git identities</FieldLegend>
              <p className={styles.legendDescription}>Email is the more reliable matcher. A name without an email can match more than one teammate.</p>
              <div className={styles.aliasRows}>
                {rows.map((row, index) => (
                  <div className={styles.aliasRow} key={row.key}>
                    <Field>
                      <FieldLabel htmlFor={`${displayNameId}-email-${index}`}>Git email</FieldLabel>
                      <Input
                        autoComplete="email"
                        id={`${displayNameId}-email-${index}`}
                        maxLength={320}
                        onChange={(event) => setAliasValue(row.key, "email", event.currentTarget.value)}
                        placeholder="ada@example.com"
                        type="email"
                        value={row.email}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${displayNameId}-name-${index}`}>Git name <span>optional</span></FieldLabel>
                      <Input
                        id={`${displayNameId}-name-${index}`}
                        maxLength={200}
                        onChange={(event) => setAliasValue(row.key, "name", event.currentTarget.value)}
                        placeholder="Ada Lovelace"
                        value={row.name}
                      />
                    </Field>
                    <Button
                      onClick={() => {
                        setRows((current) => current.filter((candidate) => candidate.key !== row.key));
                        invalidate();
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 data-icon="inline-start" /> Remove identity
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                disabled={rows.length >= MAX_ALIASES}
                onClick={() => {
                  setRows((current) => [...current, { key: crypto.randomUUID(), name: "", email: "" }]);
                  invalidate();
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <Plus data-icon="inline-start" /> Add another identity
              </Button>
              {aliases.error ? <FieldError>{aliases.error}</FieldError> : null}
              {aliases.hasNameOnly && aliases.error === null ? (
                <p className={styles.aliasWarning} role="status">
                  <AlertTriangle aria-hidden="true" /> Name-only matching can be ambiguous. Add the Git email when possible.
                </p>
              ) : null}
            </FieldSet>
          </FieldGroup>

          {unchanged ? <p className={styles.noChange} role="status">Change the display name or a Git identity before reviewing.</p> : null}
          {problem ? (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>{problem.title}</AlertTitle>
              <AlertDescription>{problem.detail}</AlertDescription>
            </Alert>
          ) : null}
          {preview.isError ? <ErrorState error={preview.error} retry={review} /> : null}
          {invalidEnvelope ? <PreviewTechnicalDetails envelope={invalidEnvelope} /> : null}
        </div>

        <div className="sr-only" aria-live="polite" role="status">
          {preview.isPending ? "Reviewing member" : ""}
          {apply.isPending ? "Saving member" : ""}
        </div>
        <DialogFooter>
          <DialogClose render={<Button disabled={busy} variant="outline" />}>Cancel</DialogClose>
          <Button disabled={!canReview || busy} onClick={review} type="button">
            {preview.isPending ? "Reviewing…" : "Review member"}
          </Button>
        </DialogFooter>

        {envelope ? (
          <AlertDialog
            open={confirmOpen}
            onOpenChange={(open) => { if (!open && !apply.isPending) setConfirmOpen(false); }}
          >
            <AlertDialogContent className={styles.confirmation}>
              <AlertDialogHeader>
                <AlertDialogMedia><CheckCircle2 aria-hidden="true" /></AlertDialogMedia>
                <AlertDialogTitle>
                  {operation.kind === "add" ? "Add this member?" : `Save changes to ${operation.member.displayName}?`}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This writes a shared Member record and one Activity entry in your working tree. Commit and push are still required to share it with teammates.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <PreviewTechnicalDetails envelope={envelope} />
              {apply.isError ? <ErrorState error={apply.error} /> : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={apply.isPending}>Keep editing</AlertDialogCancel>
                <AlertDialogAction
                  disabled={apply.isPending || !envelope.preview.valid}
                  onClick={() => apply.mutate(envelope)}
                >
                  {apply.isPending ? "Saving…" : operation.kind === "add" ? "Add member" : "Save member"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LocalConfirmation({
  currentActor,
  member,
  onApplied,
  onCancel,
  onClose,
  open,
  operation,
}: {
  currentActor: TeamCurrentActorResponse;
  member?: TeamMember;
  onApplied(result: TeamOperationApplyResponse, operation: MembersOperation, member?: TeamMember): Promise<void>;
  onCancel(): void;
  onClose(): void;
  open: boolean;
  operation: Extract<MembersOperation, { kind: "choose" | "clear" }>;
}) {
  const api = useHubApi();
  const operationKey = useRef(operationId(operation.kind));
  const [invalidEnvelope, setInvalidEnvelope] = useState<TeamOperationPreviewResponse | null>(null);
  const request = (): TeamOperationPreviewRequest => operation.kind === "clear"
    ? {
      operationId: operationKey.current,
      action: { kind: "member.clear" },
      expectedRevisions: [selectionExpectation(currentActor)],
    }
    : {
      operationId: operationKey.current,
      action: { kind: "member.select", memberId: member!.id },
      expectedRevisions: [memberExpectation(member!), selectionExpectation(currentActor)],
    };
  const applyLocal = useMutation({
    mutationFn: async () => {
      const planned = request();
      const envelope = await api.previewTeamOperation(planned);
      if (stableRequest(envelope.request) !== stableRequest(planned)) {
        throw new Error("The local identity preview did not match the requested change.");
      }
      if (!envelope.preview.valid) return { kind: "invalid" as const, envelope };
      return {
        kind: "applied" as const,
        envelope,
        result: await api.applyTeamOperation(envelope),
      };
    },
    onError: () => {
      operationKey.current = operationId(operation.kind);
    },
    onSuccess: async (outcome) => {
      if (outcome.kind === "invalid") {
        setInvalidEnvelope(outcome.envelope);
        operationKey.current = operationId(operation.kind);
        return;
      }
      await onApplied(outcome.result, operation, member);
      onClose();
    },
  });
  const clear = operation.kind === "clear";
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => { if (!next && !applyLocal.isPending) onCancel(); }}
    >
      <AlertDialogContent className={styles.localConfirmation}>
        <AlertDialogHeader>
          <AlertDialogMedia>
            {clear ? <GitBranch aria-hidden="true" /> : <UserRoundCheck aria-hidden="true" />}
          </AlertDialogMedia>
          <AlertDialogTitle>
            {clear ? "Remove your saved identity choice?" : `Work as ${member?.displayName ?? "this member"} in this checkout?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {clear
              ? "MEX will resolve your identity again from Git. This changes only this checkout and writes neither Git files nor Activity."
              : "This is a local identity override for this checkout. It is not sign-in, writes no Git files, and creates no Activity."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {invalidEnvelope ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>This identity change cannot be applied yet</AlertTitle>
            <AlertDescription>Nothing was written. Review the exact diagnostics and try again.</AlertDescription>
          </Alert>
        ) : null}
        {invalidEnvelope ? <PreviewTechnicalDetails envelope={invalidEnvelope} /> : null}
        {applyLocal.isError ? <ErrorState error={applyLocal.error} /> : null}
        <div className="sr-only" aria-live="polite" role="status">
          {applyLocal.isPending ? "Applying local identity change" : ""}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={applyLocal.isPending}>
            {clear ? "Keep saved choice" : "Keep current identity"}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={applyLocal.isPending}
            onClick={() => {
              setInvalidEnvelope(null);
              applyLocal.mutate();
            }}
          >
            {applyLocal.isPending
              ? "Applying…"
              : clear
                ? "Remove saved choice"
                : "Use as me"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ChooseIdentityDialog({
  currentActor,
  operation,
  onApplied,
  onClose,
}: {
  currentActor: TeamCurrentActorResponse;
  operation: Extract<MembersOperation, { kind: "choose" }>;
  onApplied(result: TeamOperationApplyResponse, operation: MembersOperation, member?: TeamMember): Promise<void>;
  onClose(): void;
}) {
  const api = useHubApi();
  const [selected, setSelected] = useState<TeamMember | null>(operation.preselected ?? null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const activeMembers = useQuery({
    queryKey: ["members", "identity-picker", "active"],
    queryFn: () => api.getMembers({ active: true, limit: 100 }),
    enabled: operation.initialMembers.length === 0,
    retry: false,
  });
  const members = useMemo(() => {
    const unique = new Map<string, TeamMember>();
    for (const member of operation.initialMembers) {
      if (member.active) unique.set(member.id, member);
    }
    for (const member of activeMembers.data?.items ?? []) unique.set(member.id, member);
    if (operation.preselected?.active) unique.set(operation.preselected.id, operation.preselected);
    return [...unique.values()];
  }, [activeMembers.data?.items, operation.initialMembers, operation.preselected]);
  const choices = useMemo(() => members.map(memberChoice), [members]);
  const selectedChoice = selected === null ? null : memberChoice(selected);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={styles.identityDialog} finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Choose your identity</DialogTitle>
          <DialogDescription>
            Choose an active Member as a local identity override for this checkout. This is not sign-in.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="member-identity-picker">Team member</FieldLabel>
          <Combobox
            isItemEqualToValue={(item: MemberChoice, value: MemberChoice) => item.id === value.id}
            itemToStringLabel={(item: MemberChoice) => item.label}
            itemToStringValue={(item: MemberChoice) => item.id}
            items={choices}
            onValueChange={(choice: MemberChoice | null) => setSelected(choice?.member ?? null)}
            value={selectedChoice}
          >
            <ComboboxInput
              autoFocus
              id="member-identity-picker"
              placeholder="Search active team members…"
              showClear
            />
            <ComboboxContent>
              <ComboboxEmpty>No active Members found.</ComboboxEmpty>
              <ComboboxList>
                {choices.map((choice) => (
                  <ComboboxItem key={choice.id} value={choice}>
                    <span className={styles.memberOption}>
                      <strong>{choice.label}</strong>
                      {choice.email ? <small>{choice.email}</small> : null}
                    </span>
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <FieldDescription>The override stays only in this checkout and can be removed later.</FieldDescription>
        </Field>
        {activeMembers.isPending ? <p className={styles.pickerStatus}>Loading active Members…</p> : null}
        {activeMembers.isError ? <ErrorState error={activeMembers.error} retry={() => void activeMembers.refetch()} /> : null}
        {activeMembers.data?.nextCursor ? <p className={styles.pickerStatus}>More than 100 active Members exist. Use the roster to load and inspect the complete bounded list.</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={selected === null} onClick={() => setConfirmOpen(true)} type="button">
            Review local override
          </Button>
        </DialogFooter>
        {selected ? (
          <LocalConfirmation
            currentActor={currentActor}
            member={selected}
            onApplied={onApplied}
            onCancel={() => setConfirmOpen(false)}
            onClose={onClose}
            open={confirmOpen}
            operation={operation}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReactivateMemberDialog({
  operation, onApplied, onClose,
}: {
  operation: Extract<MembersOperation, { kind: "reactivate" }>;
  onApplied(result: TeamOperationApplyResponse, operation: MembersOperation): Promise<void>;
  onClose(): void;
}) {
  const api = useHubApi();
  const [envelope, setEnvelope] = useState<TeamOperationPreviewResponse | null>(null);
  const generation = useRef(0);
  const request = useRef<TeamOperationPreviewRequest>({
    operationId: operationId("reactivate"),
    action: { kind: "member.reactivate", memberId: operation.member.id },
    expectedRevisions: [memberExpectation(operation.member)],
  });
  const preview = useMutation({
    mutationFn: async () => {
      const result = await api.previewTeamOperation(request.current);
      if (stableRequest(result.request) !== stableRequest(request.current)) {
        throw new Error("The reviewed Member did not match this reactivation. Nothing was applied.");
      }
      return result;
    },
  });
  const apply = useMutation({
    mutationFn: (accepted: TeamOperationPreviewResponse) => api.applyTeamOperation(accepted),
    onSuccess: async (result) => {
      await onApplied(result, operation);
      onClose();
    },
  });
  const review = () => {
    const attempt = ++generation.current;
    setEnvelope(null);
    apply.reset();
    preview.mutate(undefined, { onSuccess: (result) => {
      if (attempt === generation.current) setEnvelope(result);
    } });
  };
  useEffect(() => {
    review();
    return () => { generation.current += 1; };
  // One immutable Member revision is reviewed for this mounted dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !apply.isPending) onClose(); }}>
      <AlertDialogContent className={styles.confirmation}>
        <AlertDialogHeader>
          <AlertDialogMedia><UserRoundCheck aria-hidden="true" /></AlertDialogMedia>
          <AlertDialogTitle>Reactivate {operation.member.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Restore this existing Member to active status so they can take eligible Relays and resume their handoffs. Their identity and recorded history stay the same.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p>This updates the Member record and adds one Activity entry in your working tree. Commit and push to share it through Git.</p>
        {preview.isPending ? <p role="status">Checking the current Member record…</p> : null}
        {preview.isError ? <ErrorState error={preview.error} retry={review} /> : null}
        {envelope && !envelope.preview.valid ? <p role="alert">This Member cannot be reactivated yet. Nothing was applied.</p> : null}
        {envelope ? <PreviewTechnicalDetails envelope={envelope} /> : null}
        {apply.isError ? <ErrorState error={apply.error} retry={review} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={apply.isPending}>Keep inactive</AlertDialogCancel>
          <AlertDialogAction disabled={!envelope?.preview.valid || apply.isPending || apply.isError} onClick={() => { if (envelope) apply.mutate(envelope); }}>
            {apply.isPending ? "Reactivating…" : "Reactivate Member"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function MembersMutationDialogs({
  currentActor,
  onApplied,
  onClose,
  operation,
}: {
  currentActor: TeamCurrentActorResponse;
  onApplied(result: TeamOperationApplyResponse, operation: MembersOperation, member?: TeamMember): Promise<void>;
  onClose(): void;
  operation: MembersOperation;
}) {
  if (operation.kind === "reactivate") {
    return <ReactivateMemberDialog operation={operation} onApplied={onApplied} onClose={onClose} />;
  }
  if (operation.kind === "add" || operation.kind === "update") {
    return (
      <CanonicalMemberDialog
        onApplied={onApplied}
        onClose={onClose}
        operation={operation}
      />
    );
  }
  if (operation.kind === "choose") {
    return (
      <ChooseIdentityDialog
        currentActor={currentActor}
        onApplied={onApplied}
        onClose={onClose}
        operation={operation}
      />
    );
  }
  return (
    <LocalConfirmation
      currentActor={currentActor}
      onApplied={onApplied}
      onCancel={onClose}
      onClose={onClose}
      open
      operation={operation}
    />
  );
}
