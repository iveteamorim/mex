import { TeamMemberIdSchema } from "@mex/hub-contracts/ids";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  GitBranch,
  GitCommitHorizontal,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserPen,
  UsersRound,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useHubApi } from "../api/context";
import type {
  TeamCurrentActorResponse,
  TeamMember,
  TeamMemberListResponse,
  TeamOperationApplyResponse,
} from "../api/types";
import type { HubOutletContext } from "../app/HubLayout";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/primitives/alert";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import { ScrollArea } from "../components/primitives/scroll-area";
import { Skeleton } from "../components/primitives/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/primitives/tabs";
import { ErrorState, PageHeader, StatePanel, formatDate } from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import type { MembersOperation } from "./MembersMutationDialogs";
import styles from "../styles/members.module.css";

const LazyMembersMutationDialogs = lazy(() => import("./MembersMutationDialogs"));
const MEMBER_PAGE_SIZE = 50;
type MemberStatus = "active" | "inactive";
type MemberDiagnostic = TeamCurrentActorResponse["diagnostics"][number];

interface SuccessNotice {
  kind: "canonical" | "local";
  title: string;
  description: string;
  offerMember?: TeamMember;
}

function afterDialogUnmount(callback: () => void) {
  queueMicrotask(() => queueMicrotask(callback));
}

function actorLabel(actor: TeamCurrentActorResponse["actor"]): string {
  if (actor.kind === "member") return actor.displayName ?? "Team member";
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "No resolved identity";
}

function gitIdentityLines(actor: TeamCurrentActorResponse["actor"]): ReactNode {
  if (actor.kind !== "git") return null;
  return (
    <dl className={styles.gitIdentityFacts}>
      {actor.email ? <div><dt>Git email</dt><dd><Mail aria-hidden="true" /> {actor.email}</dd></div> : null}
      {actor.name ? <div><dt>Git name</dt><dd><CircleUserRound aria-hidden="true" /> {actor.name}</dd></div> : null}
    </dl>
  );
}

function diagnosticKey(diagnostic: MemberDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.path ?? ""}:${diagnostic.message}`;
}

function identityDiagnosticMessage(diagnostic: MemberDiagnostic): string {
  if (diagnostic.code === "ACTOR_MEMBER_MISSING") return "Your saved Member no longer exists.";
  if (diagnostic.code === "ACTOR_MEMBER_INACTIVE") return "Your saved Member is inactive.";
  if (diagnostic.code === "ACTOR_ALIAS_AMBIGUOUS") return "Your Git identity matches multiple active Members, so MEX did not guess.";
  if (diagnostic.code === "GIT_IDENTITY_UNAVAILABLE") return "MEX could not inspect a usable Git identity.";
  if (diagnostic.code === "GIT_IDENTITY_INVALID") return "The available Git identity could not be used safely.";
  return diagnostic.message;
}

function DiagnosticDetails({
  diagnostics,
  label,
  truncated,
}: {
  diagnostics: readonly MemberDiagnostic[];
  label: string;
  truncated: boolean;
}) {
  if (diagnostics.length === 0 && !truncated) return null;
  return (
    <Collapsible className={styles.diagnosticDisclosure}>
      <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
        <ChevronDown data-icon="inline-start" /> {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {diagnostics.length > 0 ? (
          <dl className={styles.technicalFacts}>
            {diagnostics.map((diagnostic, index) => (
              <div key={`${diagnosticKey(diagnostic)}:${index}`}>
                <dt>{diagnostic.code}</dt>
                <dd>{diagnostic.path ? <code>{diagnostic.path}</code> : "No source path recorded"}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {truncated ? <p className={styles.boundNote}>More diagnostics existed than this bounded response could include.</p> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function IdentityDiagnostics({ current }: { current: TeamCurrentActorResponse }) {
  if (current.diagnostics.length === 0 && !current.diagnosticsTruncated) return null;
  return (
    <Alert className={styles.identityDiagnostic}>
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Identity needs attention</AlertTitle>
      <AlertDescription>
        {current.diagnostics.length > 0 ? (
          <ul>
            {current.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnosticKey(diagnostic)}:${index}`}>{identityDiagnosticMessage(diagnostic)}</li>
            ))}
          </ul>
        ) : null}
        {current.diagnosticsTruncated ? <p>Additional identity diagnostics were omitted by the bounded response.</p> : null}
        <DiagnosticDetails diagnostics={current.diagnostics} label="Identity diagnostic details" truncated={current.diagnosticsTruncated} />
      </AlertDescription>
    </Alert>
  );
}

function YourIdentity({
  activeMembers,
  canonicalAvailable,
  canonicalReason,
  current,
  currentError,
  currentPending,
  localAvailable,
  localReason,
  onOpen,
}: {
  activeMembers: readonly TeamMember[];
  canonicalAvailable: boolean;
  canonicalReason?: string;
  current?: TeamCurrentActorResponse;
  currentError?: unknown;
  currentPending: boolean;
  localAvailable: boolean;
  localReason?: string;
  onOpen(operation: MembersOperation, event: MouseEvent<HTMLButtonElement>): void;
}) {
  let content: ReactNode;
  if (currentPending) {
    content = (
      <div className={styles.identitySkeleton} aria-label="Resolving your identity">
        <Skeleton className={styles.identitySkeletonIcon} />
        <span><Skeleton /><Skeleton /></span>
      </div>
    );
  } else if (currentError !== undefined) {
    content = <ErrorState error={currentError} />;
  } else if (current === undefined) {
    content = <StatePanel compact state="empty" title="Identity is unavailable" detail="MEX could not read the current checkout identity." />;
  } else {
    const staleSelection = current.selection !== null && current.source !== "configured-member";
    const ambiguous = current.diagnostics.some((diagnostic) => diagnostic.code === "ACTOR_ALIAS_AMBIGUOUS");
    const choose = (event: MouseEvent<HTMLButtonElement>) => onOpen({ kind: "choose", initialMembers: activeMembers }, event);
    const addSelf = (event: MouseEvent<HTMLButtonElement>) => onOpen({
      kind: "add",
      intent: "self",
      ...(current.actor.kind === "git"
        ? { prefill: { name: current.actor.name, email: current.actor.email } }
        : {}),
    }, event);
    if (staleSelection) {
      content = (
        <>
          <div className={styles.identityLead}>
            <div className={styles.identityIcon} data-tone="warning"><AlertTriangle aria-hidden="true" /></div>
            <div>
              <p className={styles.eyebrow}>Saved choice needs attention</p>
              <h3>Your saved identity choice must be removed first.</h3>
              <p>MEX cannot safely replace a missing or inactive saved choice in one step. Remove it, then MEX will resolve your Git identity again.</p>
            </div>
          </div>
          <IdentityDiagnostics current={current} />
          <div className={styles.identityActions}>
            <Button
              disabled={!localAvailable}
              onClick={(event) => onOpen({ kind: "clear" }, event)}
              type="button"
            >
              <X data-icon="inline-start" /> Remove saved choice
            </Button>
          </div>
          {!localAvailable ? <p className={styles.capabilityReason} role="status">{localReason ?? "Local identity changes are unavailable."}</p> : null}
        </>
      );
    } else if (current.source === "configured-member" && current.actor.kind === "member") {
      const name = actorLabel(current.actor);
      content = (
        <>
          <div className={styles.identityLead}>
            <div className={styles.identityIcon}><CircleUserRound aria-hidden="true" /></div>
            <div>
              <p className={styles.eyebrow}>Chosen for this checkout</p>
              <h3>You’re working as {name}.</h3>
              <p>This local choice takes precedence over your Git identity until you remove it.</p>
            </div>
            <Badge variant="secondary">Working as</Badge>
          </div>
          <div className={styles.identityActions}>
            <Button
              disabled={!localAvailable}
              onClick={(event) => onOpen({ kind: "clear" }, event)}
              type="button"
              variant="outline"
            >
              <GitBranch data-icon="inline-start" /> Use Git identity instead
            </Button>
          </div>
          {!localAvailable ? <p className={styles.capabilityReason} role="status">{localReason ?? "Local identity changes are unavailable."}</p> : null}
        </>
      );
    } else if (current.source === "git-alias" && current.actor.kind === "member") {
      const name = actorLabel(current.actor);
      content = (
        <>
          <div className={styles.identityLead}>
            <div className={styles.identityIcon}><CheckCircle2 aria-hidden="true" /></div>
            <div>
              <p className={styles.eyebrow}>Matched from Git</p>
              <h3>MEX recognizes you as {name}.</h3>
              <p>Matched automatically from your Git identity. No local override is saved.</p>
            </div>
            <Badge variant="secondary">You</Badge>
          </div>
          <div className={styles.identityActions}>
            <Button disabled={!localAvailable} onClick={choose} type="button" variant="outline">
              <UsersRound data-icon="inline-start" /> Choose an existing member
            </Button>
          </div>
          {!localAvailable ? <p className={styles.capabilityReason} role="status">{localReason ?? "Local identity changes are unavailable."}</p> : null}
          <IdentityDiagnostics current={current} />
        </>
      );
    } else if (ambiguous) {
      content = (
        <>
          <div className={styles.identityLead}>
            <div className={styles.identityIcon} data-tone="warning"><AlertTriangle aria-hidden="true" /></div>
            <div>
              <p className={styles.eyebrow}>Git match is ambiguous</p>
              <h3>Your Git identity matches more than one MEX member.</h3>
              <p>MEX kept the Git identity instead of guessing. Choose yourself locally, or edit the shared aliases so only one active Member matches.</p>
            </div>
          </div>
          {gitIdentityLines(current.actor)}
          <IdentityDiagnostics current={current} />
          <div className={styles.identityActions}>
            <Button disabled={!localAvailable} onClick={choose} type="button">
              <UsersRound data-icon="inline-start" /> Choose an existing member
            </Button>
          </div>
          {!localAvailable ? <p className={styles.capabilityReason} role="status">{localReason ?? "Local identity changes are unavailable."}</p> : null}
        </>
      );
    } else if (current.source === "git-fallback" && current.actor.kind === "git") {
      content = (
        <>
          <div className={styles.identityLead}>
            <div className={styles.identityIcon} data-tone="warning"><CircleUserRound aria-hidden="true" /></div>
            <div>
              <p className={styles.eyebrow}>Git identity is not linked</p>
              <h3>Your Git identity isn’t linked to a MEX member.</h3>
              <p>Add a shared Member for yourself, or choose an existing Member as a local override.</p>
            </div>
          </div>
          {gitIdentityLines(current.actor)}
          <IdentityDiagnostics current={current} />
          <div className={styles.identityActions}>
            <Button disabled={!canonicalAvailable} onClick={addSelf} type="button">
              <Plus data-icon="inline-start" /> Add myself
            </Button>
            <Button disabled={!localAvailable} onClick={choose} type="button" variant="outline">
              <UsersRound data-icon="inline-start" /> Choose an existing member
            </Button>
          </div>
          {!canonicalAvailable ? <p className={styles.capabilityReason} role="status">{canonicalReason ?? "Shared Member changes are unavailable."}</p> : null}
          {!localAvailable ? <p className={styles.capabilityReason} role="status">{localReason ?? "Local identity changes are unavailable."}</p> : null}
        </>
      );
    } else {
      content = (
        <>
          <div className={styles.identityLead}>
            <div className={styles.identityIcon} data-tone="warning"><CircleUserRound aria-hidden="true" /></div>
            <div>
              <p className={styles.eyebrow}>Identity unavailable</p>
              <h3>MEX could not find a usable Git identity.</h3>
              <p>You can create a Member manually or choose an existing Member for this checkout.</p>
            </div>
          </div>
          <IdentityDiagnostics current={current} />
          <div className={styles.identityActions}>
            <Button disabled={!canonicalAvailable} onClick={addSelf} type="button">
              <Plus data-icon="inline-start" /> Add myself
            </Button>
            <Button disabled={!localAvailable} onClick={choose} type="button" variant="outline">
              <UsersRound data-icon="inline-start" /> Choose an existing member
            </Button>
          </div>
          {!canonicalAvailable ? <p className={styles.capabilityReason} role="status">{canonicalReason ?? "Shared Member changes are unavailable."}</p> : null}
          {!localAvailable ? <p className={styles.capabilityReason} role="status">{localReason ?? "Local identity changes are unavailable."}</p> : null}
        </>
      );
    }
  }

  return (
    <Card aria-labelledby="your-identity-heading" className={styles.identityCard} role="region">
      <CardHeader className={styles.identityHeader}>
        <CardTitle><h2 id="your-identity-heading">Your identity</h2></CardTitle>
        <CardDescription>Who MEX uses when it attributes an action in this checkout.</CardDescription>
      </CardHeader>
      <CardContent className={styles.identityContent}>{content}</CardContent>
      <CardFooter className={styles.identityTrust}>
        <ShieldCheck aria-hidden="true" />
        <span>This controls how MEX attributes actions in this checkout. It is not authentication.</span>
      </CardFooter>
    </Card>
  );
}

function MemberListWarnings({ pages }: { pages: readonly TeamMemberListResponse[] }) {
  const diagnostics = useMemo(() => {
    const unique = new Map<string, MemberDiagnostic>();
    for (const page of pages) {
      for (const diagnostic of page.diagnostics) unique.set(diagnosticKey(diagnostic), diagnostic);
    }
    return [...unique.values()];
  }, [pages]);
  const sourceTruncated = pages.some((page) => page.sourceTruncated);
  const diagnosticsTruncated = pages.some((page) => page.diagnosticsTruncated);
  if (!sourceTruncated && !diagnosticsTruncated && diagnostics.length === 0) return null;
  return (
    <Alert className={styles.memberWarning}>
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Some Member records need attention</AlertTitle>
      <AlertDescription>
        {diagnostics.length > 0 ? (
          <ul>{diagnostics.map((diagnostic) => <li key={diagnosticKey(diagnostic)}>{diagnostic.message}</li>)}</ul>
        ) : null}
        {sourceTruncated ? <p>The Member source exceeded a safe read bound. Only the trustworthy bounded portion is shown.</p> : null}
        {diagnosticsTruncated ? <p>Additional diagnostics were omitted by the bounded response.</p> : null}
        <DiagnosticDetails diagnostics={diagnostics} label="Member list diagnostic details" truncated={diagnosticsTruncated} />
      </AlertDescription>
    </Alert>
  );
}

function MemberQueueSkeleton() {
  return (
    <div className={styles.queueSkeleton} aria-label="Loading team members">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index}><Skeleton /><span><Skeleton /><Skeleton /></span></div>
      ))}
    </div>
  );
}

function MemberQueue({
  effectiveMemberId,
  error,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  onLoadMore,
  onSelect,
  rows,
  selectedId,
  sourceBounded,
  status,
}: {
  effectiveMemberId: string | null;
  error?: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  onLoadMore(): void;
  onSelect(member: TeamMember): void;
  rows: readonly TeamMember[];
  selectedId: string | null;
  sourceBounded: boolean;
  status: MemberStatus;
}) {
  return (
    <Card className={styles.queuePane} role="region" aria-labelledby="member-queue-heading">
      <CardHeader className={styles.queueHeader}>
        <CardTitle><h3 id="member-queue-heading">{status === "active" ? "Active Members" : "Inactive Members"}</h3></CardTitle>
        <CardDescription>{status === "active" ? "People MEX can currently recognize and route handoffs to." : "Historical identities retained for attribution and context."}</CardDescription>
      </CardHeader>
      <CardContent className={styles.queueContent}>
        {isPending ? (
          <MemberQueueSkeleton />
        ) : error && rows.length === 0 ? (
          <ErrorState error={error} />
        ) : rows.length === 0 ? (
          <Empty className={styles.queueEmpty}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{status === "active" ? "No active team members" : "No inactive team members"}</EmptyTitle>
              <EmptyDescription>{status === "active" ? "Add a Member when the team is ready to share attribution through Git." : "Inactive Member history will remain readable here."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className={styles.queueScroll}>
            <ItemGroup className={styles.memberItems}>
              {rows.map((member) => {
                const isYou = effectiveMemberId === member.id;
                return (
                  <div key={member.id} role="listitem">
                    <Item
                      aria-current={selectedId === member.id ? "true" : undefined}
                      className={styles.memberItem}
                      data-member-id={member.id}
                      onClick={() => onSelect(member)}
                      render={<button type="button" />}
                      variant="outline"
                    >
                      <ItemMedia className={styles.avatar}>
                        {member.displayName.slice(0, 2).toUpperCase()}
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{member.displayName}{isYou ? <Badge variant="secondary">You</Badge> : null}</ItemTitle>
                        <ItemDescription>{member.gitAliases.find((alias) => alias.email)?.email ?? "No Git email recorded"}</ItemDescription>
                      </ItemContent>
                      <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
                    </Item>
                  </div>
                );
              })}
            </ItemGroup>
          </ScrollArea>
        )}
        {error && rows.length > 0 ? <div className={styles.paginationError}><ErrorState error={error} /></div> : null}
        {hasNextPage ? (
          <Button disabled={isFetchingNextPage} onClick={onLoadMore} type="button" variant="outline">
            {isFetchingNextPage ? "Loading…" : "Load more members"}
          </Button>
        ) : sourceBounded ? (
          <p className={styles.boundNote}>The browser’s bounded page limit was reached.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MemberDetail({
  canonicalAvailable,
  canonicalReason,
  current,
  detail,
  detailError,
  detailPending,
  effectiveMemberId,
  invalidSelection,
  onClearSelection,
  onEdit,
  onReactivate,
  onSwitchStatus,
  refreshGeneration,
  selectedId,
  status,
}: {
  canonicalAvailable: boolean;
  canonicalReason?: string;
  current?: TeamCurrentActorResponse;
  detail?: TeamMember;
  detailError?: unknown;
  detailPending: boolean;
  effectiveMemberId: string | null;
  invalidSelection: boolean;
  onClearSelection(): void;
  onEdit(member: TeamMember, event: MouseEvent<HTMLButtonElement>): void;
  onReactivate(member: TeamMember, event: MouseEvent<HTMLButtonElement>): void;
  onSwitchStatus(status: MemberStatus, memberId: string): void;
  refreshGeneration: number;
  selectedId: string | null;
  status: MemberStatus;
}) {
  let content: ReactNode;
  if (invalidSelection) {
    content = (
      <Empty className={styles.detailEmpty}>
        <EmptyHeader>
          <EmptyMedia variant="icon"><AlertTriangle aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>That Member link isn’t valid</EmptyTitle>
          <EmptyDescription>MEX did not request a Member with an invalid identifier.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button onClick={onClearSelection} type="button" variant="outline">Return to team list</Button></EmptyContent>
      </Empty>
    );
  } else if (selectedId === null) {
    content = (
      <Empty className={styles.detailEmpty}>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CircleUserRound aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Choose a team member</EmptyTitle>
          <EmptyDescription>Select a Member to see the Git identities MEX recognizes.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (detailPending) {
    content = <StatePanel compact state="loading" title="Loading Member" detail="Reading the selected shared identity record." />;
  } else if (detailError !== undefined) {
    content = (
      <div className={styles.detailError}>
        <ErrorState error={detailError} />
        <Button onClick={onClearSelection} type="button" variant="outline">Return to team list</Button>
      </div>
    );
  } else if (detail !== undefined && detail.active !== (status === "active")) {
    const target = detail.active ? "active" : "inactive";
    content = (
      <Empty className={styles.detailEmpty}>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CircleUserRound aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>{detail.displayName} is in {target} Members</EmptyTitle>
          <EmptyDescription>The selected Member does not belong to this roster view.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => onSwitchStatus(target, detail.id)} type="button" variant="outline">View {target} Members</Button>
        </EmptyContent>
      </Empty>
    );
  } else if (detail !== undefined) {
    const isYou = effectiveMemberId === detail.id;
    const locallyChosen = current?.source === "configured-member" && current.selection?.memberId === detail.id;
    content = (
      <>
        <CardHeader className={styles.detailHeader}>
          <div className={styles.detailHeading}>
            <span className={styles.detailAvatar} aria-hidden="true">{detail.displayName.slice(0, 2).toUpperCase()}</span>
            <div>
              <p>{detail.active ? "Active team member" : "Inactive team member"}</p>
              <CardTitle><h3>{detail.displayName}</h3></CardTitle>
              <div className={styles.detailBadges}>
                <Badge variant={detail.active ? "secondary" : "outline"}>{detail.active ? "Active" : "Inactive"}</Badge>
                {isYou ? <Badge>You</Badge> : null}
              </div>
            </div>
          </div>
          <CardAction>
            <Button disabled={!canonicalAvailable} onClick={(event) => onEdit(detail, event)} type="button" variant="outline">
              <UserPen data-icon="inline-start" /> Edit member
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className={styles.detailContent}>
          {!canonicalAvailable ? (
            <p className={styles.capabilityReason} role="status">
              Editing this Member is unavailable. {canonicalReason ?? "Shared Member changes are not connected."}
            </p>
          ) : null}
          {!detail.active ? <div className={styles.capabilityReason}>
            <p>This Member cannot take or resume Relays while inactive. Reactivation restores the same identity and handoff eligibility.</p>
            <Button disabled={!canonicalAvailable} onClick={(event) => onReactivate(detail, event)} type="button">Reactivate Member</Button>
          </div> : null}
          <section className={styles.aliases} aria-labelledby="member-aliases-heading">
            <div className={styles.sectionHeading}>
              <h4 id="member-aliases-heading">Recognized Git identities</h4>
              <span>{detail.gitAliases.length}</span>
            </div>
            {detail.gitAliases.length > 0 ? (
              <ul>
                {detail.gitAliases.map((alias, index) => (
                  <li key={`${alias.email ?? ""}:${alias.name ?? ""}:${index}`}>
                    <Mail aria-hidden="true" />
                    <span><strong>{alias.email ?? "No email"}</strong><small>{alias.name ?? "No Git name"}</small></span>
                  </li>
                ))}
              </ul>
            ) : <p>No Git identities are recorded for this Member.</p>}
          </section>
          <Collapsible className={styles.technicalDisclosure} key={`${detail.id}:${refreshGeneration}`}>
            <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
              <ChevronDown data-icon="inline-start" /> Technical details
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className={styles.technicalFacts}>
                <div><dt>Member ID</dt><dd><code>{detail.id}</code></dd></div>
                <div><dt>Source path</dt><dd><code>{detail.sourcePath}</code></dd></div>
                <div><dt>Exact revision</dt><dd><GitCommitHorizontal aria-hidden="true" /><code>{detail.revision}</code></dd></div>
                {locallyChosen && current?.selection ? (
                  <div><dt>Chosen in this checkout at</dt><dd>{formatDate(current.selection.updatedAt)}</dd></div>
                ) : null}
              </dl>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </>
    );
  } else {
    content = null;
  }
  return <Card aria-label="Selected Member detail" className={styles.detailPane} role="region">{content}</Card>;
}

export function MembersPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<HubOutletContext>();
  const [params, setParams] = useSearchParams();
  const [operation, setOperation] = useState<MembersOperation | null>(null);
  const [notice, setNotice] = useState<SuccessNotice | null>(null);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  const operationWasOpen = useRef(false);
  const focusNoticeAfterClose = useRef(false);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement | null>(null);

  const rawStatus = params.get("status");
  const status: MemberStatus = rawStatus === "inactive" ? "inactive" : "active";
  const rawMemberId = params.get("member");
  const parsedMemberId = rawMemberId === null ? null : TeamMemberIdSchema.safeParse(rawMemberId);
  const invalidSelection = parsedMemberId !== null && !parsedMemberId.success;
  const selectedId = parsedMemberId?.success ? parsedMemberId.data : null;
  const readAvailable = capabilities?.members.read.availability === "available";
  const canonicalAvailable = capabilities?.members.canonicalMutation.availability === "available";
  const localAvailable = capabilities?.members.localSelection.availability === "available";
  const canonicalReason = capabilities?.members.canonicalMutation.reason;
  const localReason = capabilities?.members.localSelection.reason;

  useEffect(() => {
    if (rawStatus === null || rawStatus === "active" || rawStatus === "inactive") return;
    const next = new URLSearchParams(params);
    next.set("status", "active");
    setParams(next, { replace: true });
  }, [params, rawStatus, setParams]);

  useEffect(() => {
    if (operationWasOpen.current && operation === null) {
      afterDialogUnmount(() => {
        if (focusNoticeAfterClose.current && noticeRef.current) {
          focusNoticeAfterClose.current = false;
          noticeRef.current.focus({ preventScroll: true });
        } else {
          operationTrigger.current?.focus({ preventScroll: true });
        }
      });
    }
    operationWasOpen.current = operation !== null;
  }, [operation]);

  const current = useQuery({
    queryKey: ["actor", "current"],
    queryFn: () => api.getCurrentActor(),
    enabled: readAvailable,
    retry: false,
  });
  const trustedCurrent = current.isError ? undefined : current.data;
  const members = useInfiniteQuery({
    queryKey: ["members", "directory", status],
    queryFn: ({ pageParam }) => api.getMembers({
      active: status === "active",
      limit: MEMBER_PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: readAvailable,
    retry: false,
  });
  const rows = useMemo(() => {
    const unique = new Map<string, TeamMember>();
    for (const page of members.data?.pages ?? []) {
      for (const member of page.items) unique.set(member.id, member);
    }
    return [...unique.values()];
  }, [members.data?.pages]);
  const effectiveMemberId = trustedCurrent?.actor.kind === "member" ? trustedCurrent.actor.memberId : null;
  const staleSelection = trustedCurrent?.selection !== null
    && trustedCurrent?.selection !== undefined
    && trustedCurrent.source !== "configured-member";
  const sharedActionAvailable = canonicalAvailable && trustedCurrent !== undefined && !staleSelection;
  const sharedActionReason = !canonicalAvailable
    ? canonicalReason
    : current.isPending
      ? "Wait until MEX finishes resolving your checkout identity."
      : current.isError
        ? "MEX could not resolve your checkout identity, so shared Member changes are unavailable."
        : trustedCurrent === undefined
          ? "Resolve your checkout identity before changing shared Members."
          : staleSelection
            ? "Remove the saved identity choice before changing shared Members."
            : undefined;

  useEffect(() => {
    if (
      rawMemberId !== null
      || status !== "active"
      || current.isError
      || current.data?.actor.kind !== "member"
    ) return;
    const next = new URLSearchParams(params);
    next.set("status", "active");
    next.set("member", current.data.actor.memberId);
    setParams(next, { replace: true });
  }, [current.data, current.isError, params, rawMemberId, setParams, status]);

  const detail = useQuery({
    queryKey: ["member", selectedId],
    queryFn: () => api.getMember(selectedId!),
    enabled: readAvailable && selectedId !== null,
    retry: false,
  });

  const setMemberSelection = (
    memberId: string | null,
    nextStatus: MemberStatus = status,
    replace = false,
  ) => {
    const next = new URLSearchParams(params);
    next.set("status", nextStatus);
    if (memberId === null) next.delete("member");
    else next.set("member", memberId);
    setParams(next, { replace });
  };
  const selectStatus = (nextStatus: string) => {
    if (nextStatus !== "active" && nextStatus !== "inactive") return;
    setMemberSelection(null, nextStatus);
  };
  const openOperation = (
    next: MembersOperation,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (trustedCurrent === undefined) return;
    if (staleSelection && next.kind !== "clear") return;
    operationTrigger.current = event.currentTarget;
    setOperation(next);
  };

  const invalidateIdentityDependents = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["actor", "current"] }),
      queryClient.invalidateQueries({ queryKey: ["home"] }),
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["inbox"] }),
      queryClient.invalidateQueries({ queryKey: ["relays"] }),
    ]);
    return queryClient.getQueryData<TeamCurrentActorResponse>(["actor", "current"]);
  };

  const onApplied = async (
    result: TeamOperationApplyResponse,
    appliedOperation: MembersOperation,
    localMember?: TeamMember,
  ) => {
    if (appliedOperation.kind === "choose" || appliedOperation.kind === "clear") {
      const resolved = await invalidateIdentityDependents();
      if (appliedOperation.kind === "choose") {
        const memberName = localMember?.displayName ?? actorLabel(resolved?.actor ?? { kind: "unknown" });
        setNotice({
          kind: "local",
          title: `You’re now working as ${memberName}`,
          description: `You’re now working as ${memberName} in this checkout. Nothing was written to Git or Activity.`,
        });
      } else {
        const description = resolved?.source === "git-alias" && resolved.actor.kind === "member"
          ? `MEX now recognizes you as ${actorLabel(resolved.actor)} from your Git identity. Nothing was written to Git.`
          : resolved?.actor.kind === "git"
            ? "MEX is now using your Git identity. Nothing was written to Git."
            : "MEX will use your Git identity when one becomes available. Nothing was written to Git.";
        setNotice({ kind: "local", title: "Saved identity removed", description });
      }
      focusNoticeAfterClose.current = true;
      return;
    }

    const affected = result.members[0]
      ?? (appliedOperation.kind === "update" || appliedOperation.kind === "reactivate" ? appliedOperation.member : undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["members"] }),
      ...(affected ? [queryClient.invalidateQueries({ queryKey: ["member", affected.id] })] : []),
      queryClient.invalidateQueries({ queryKey: ["activity"] }),
    ]);
    const resolved = await invalidateIdentityDependents();
    if (affected) setMemberSelection(affected.id, affected.active ? "active" : "inactive");
    if (appliedOperation.kind === "add") {
      const ready = affected !== undefined
        && resolved?.actor.kind === "member"
        && resolved.actor.memberId === affected.id;
      setNotice({
        kind: "canonical",
        title: "Member added",
        description: `Member added in your working tree. Commit and push to share this identity with teammates.${ready ? ` MEX now recognizes you as ${affected.displayName} from your Git identity.` : ""}`,
        ...(!ready && appliedOperation.intent === "self" && affected
          ? { offerMember: affected }
          : {}),
      });
    } else {
      setNotice({
        kind: "canonical",
        title: appliedOperation.kind === "reactivate" ? "Member reactivated" : "Member updated",
        description: `${appliedOperation.kind === "reactivate" ? "Member reactivated" : "Member updated"} in your working tree. Commit and push to share the change.`,
      });
    }
    focusNoticeAfterClose.current = true;
  };

  const refreshMembers = async () => {
    setRefreshing(true);
    setRefreshStatus("");
    setNotice(null);
    setRefreshGeneration((value) => value + 1);
    try {
      await Promise.all([
        queryClient.resetQueries({ queryKey: ["members"] }, { throwOnError: true }),
        queryClient.resetQueries({ queryKey: ["member"] }, { throwOnError: true }),
        queryClient.resetQueries({ queryKey: ["actor", "current"] }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["relays"] }),
      ]);
      setRefreshStatus("Members and identity refreshed.");
    } catch {
      setRefreshStatus("Members and identity could not be refreshed. Try again.");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={styles.page} data-members-workbench={readAvailable ? "ready" : "unavailable"}>
      <PageHeader
        eyebrow="Team identity"
        title="Members"
        description="Manage the shared directory MEX uses for human attribution and Relay routing."
        actions={(
          <Button
            disabled={!readAvailable || refreshing}
            onClick={() => void refreshMembers()}
            ref={refreshRef}
            size="sm"
            type="button"
            variant="outline"
          >
            <RefreshCw className={refreshing ? styles.refreshingIcon : undefined} data-icon="inline-start" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      />
      <div className={styles.liveStatus} aria-live="polite" role="status">{refreshStatus}</div>

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking Members" detail="Confirming the local Team workflow connection." />
      ) : !readAvailable ? (
        <StatePanel state="unavailable" title="Members are unavailable" detail={capabilities.members.read.reason ?? "Member reads are not connected in this Hub process."} />
      ) : (
        <>
          {notice ? (
            <Alert className={styles.successAlert} ref={noticeRef} tabIndex={-1}>
              {notice.kind === "canonical" ? <GitCommitHorizontal aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              <AlertTitle>{notice.title}</AlertTitle>
              <AlertDescription>{notice.description}</AlertDescription>
              <AlertAction>
                {notice.offerMember && trustedCurrent ? (
                  <Button
                    onClick={(event) => openOperation({
                      kind: "choose",
                      initialMembers: rows,
                      preselected: notice.offerMember,
                    }, event)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <CircleUserRound data-icon="inline-start" /> Use as me on this device
                  </Button>
                ) : null}
                <Button
                  aria-label="Dismiss Member notice"
                  onClick={() => {
                    setNotice(null);
                    afterDialogUnmount(() => refreshRef.current?.focus({ preventScroll: true }));
                  }}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <X data-icon="inline-start" />
                </Button>
              </AlertAction>
            </Alert>
          ) : null}

          <YourIdentity
            activeMembers={status === "active" ? rows : []}
            canonicalAvailable={sharedActionAvailable}
            canonicalReason={sharedActionReason}
            current={trustedCurrent}
            currentError={current.isError ? current.error : undefined}
            currentPending={current.isPending}
            localAvailable={localAvailable}
            localReason={localReason}
            onOpen={openOperation}
          />

          <section className={styles.teamSection} aria-labelledby="team-members-heading">
            <header className={styles.teamHeader}>
              <div>
                <p className={styles.eyebrow}>Shared through Git</p>
                <h2 id="team-members-heading">Team members</h2>
                <p>People MEX can recognize for attribution and Relay routing. This directory does not grant repository access.</p>
              </div>
              <Button
                disabled={!sharedActionAvailable}
                onClick={(event) => openOperation({ kind: "add", intent: "team" }, event)}
                type="button"
                variant="outline"
              >
                <Plus data-icon="inline-start" /> Add member
              </Button>
            </header>
            {!sharedActionAvailable ? (
              <p className={styles.capabilityReason} role="status">{sharedActionReason ?? "Shared Member editing is unavailable. The roster remains readable."}</p>
            ) : null}
            <MemberListWarnings pages={members.data?.pages ?? []} />
            <div className={styles.memberCount} aria-live="polite" role="status">
              {members.isPending ? "Loading team members" : `${rows.length} ${status} members shown`}
            </div>

            <Tabs className={styles.memberTabs} onValueChange={selectStatus} value={status}>
              <TabsList activateOnFocus aria-label="Team member status" className={styles.statusTabs} variant="line">
                <TabsTrigger value="active">Active</TabsTrigger>
                <TabsTrigger value="inactive">Inactive</TabsTrigger>
              </TabsList>
              {(["active", "inactive"] as const).map((view) => (
                <TabsContent className={styles.statusPanel} key={view} value={view}>
                  {view === status ? (
                    <div className={styles.workbench}>
                      <MemberQueue
                        effectiveMemberId={effectiveMemberId}
                        error={members.isError ? members.error : undefined}
                        hasNextPage={members.hasNextPage}
                        isFetchingNextPage={members.isFetchingNextPage}
                        isPending={members.isPending}
                        onLoadMore={() => void members.fetchNextPage()}
                        onSelect={(member) => setMemberSelection(member.id, status)}
                        rows={rows}
                        selectedId={selectedId}
                        sourceBounded={Boolean(
                          members.data
                          && members.data.pages.length >= MAX_WORKBENCH_PAGES
                          && members.data.pages[members.data.pages.length - 1]?.nextCursor !== null
                        )}
                        status={status}
                      />
                      <MemberDetail
                        canonicalAvailable={sharedActionAvailable}
                        canonicalReason={sharedActionReason}
                        current={trustedCurrent}
                        detail={detail.data}
                        detailError={detail.isError ? detail.error : undefined}
                        detailPending={detail.isPending}
                        effectiveMemberId={effectiveMemberId}
                        invalidSelection={invalidSelection}
                        onClearSelection={() => setMemberSelection(null, status)}
                        onEdit={(member, event) => openOperation({ kind: "update", member }, event)}
                        onReactivate={(member, event) => openOperation({ kind: "reactivate", member }, event)}
                        onSwitchStatus={(nextStatus, memberId) => setMemberSelection(memberId, nextStatus)}
                        refreshGeneration={refreshGeneration}
                        selectedId={selectedId}
                        status={status}
                      />
                    </div>
                  ) : null}
                </TabsContent>
              ))}
            </Tabs>
          </section>
        </>
      )}

      {operation && trustedCurrent ? (
        <Suspense fallback={<div className={styles.dialogLoading} aria-live="polite" role="status">Opening Member review…</div>}>
          <LazyMembersMutationDialogs
            currentActor={trustedCurrent}
            onApplied={onApplied}
            onClose={() => setOperation(null)}
            operation={operation}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
