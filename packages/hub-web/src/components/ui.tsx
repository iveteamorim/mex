import type { HTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { AlertTriangle, ArrowRight, LoaderCircle, PackageOpen, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";
import { HubApiError } from "../api/client";
import type { JobState, Tone } from "../api/types";
import { Badge } from "./primitives/badge";
import { Button, buttonVariants } from "./primitives/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "./primitives/empty";
import { cn } from "../lib/utils";
import styles from "../styles/ui.module.css";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  const compact = !eyebrow && !description;
  return (
    <header className={styles.pageHeader} data-compact={compact || undefined}>
      <div>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className={styles.pageDescription}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  );
}

export function Panel({
  children,
  className = "",
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
  return (
    <section className={`${styles.panel} ${className}`} {...props}>
      {children}
    </section>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.panelHeader}>
      <div>
        {eyebrow ? <p className={styles.panelEyebrow}>{eyebrow}</p> : null}
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function StatePanel({
  state,
  title,
  detail,
  action,
  compact = false,
}: {
  state: "loading" | "empty" | "error" | "unavailable";
  title: string;
  detail: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  const Icon = state === "loading"
    ? LoaderCircle
    : state === "empty"
      ? PackageOpen
      : state === "unavailable"
        ? WifiOff
        : AlertTriangle;
  return (
    <Empty
      className={`${styles.statePanel} ${compact ? styles.statePanelCompact : ""}`}
      role={state === "error" ? "alert" : "status"}
    >
      <EmptyMedia className={styles.stateIcon} data-state={state} variant="icon">
        <Icon aria-hidden="true" className={state === "loading" ? styles.spin : ""} />
      </EmptyMedia>
      <EmptyHeader>
        <h2>{title}</h2>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </Empty>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const problem = error instanceof HubApiError ? error.problem : null;
  return (
    <StatePanel
      state="error"
      title={problem?.title ?? "This view could not be loaded"}
      detail={problem?.detail ?? "The Hub kept the last trustworthy state. Try the request again."}
      action={
        retry ? (
          <Button variant="outline" size="sm" type="button" onClick={retry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

export function StatusPill({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: Tone }>) {
  return <Badge className={styles.statusPill} data-tone={tone} variant="outline">{children}</Badge>;
}

export function stateTone(state: JobState | string): Tone {
  if (["succeeded", "healthy", "fresh", "ready", "available"].includes(state)) return "success";
  if (["failed", "corrupt"].includes(state)) return "danger";
  if (["running"].includes(state)) return "info";
  if (["queued", "degraded", "stale", "missing", "rebuild_required", "migration_required", "interrupted"].includes(state)) {
    return "warning";
  }
  return "neutral";
}

export function InlineLink({ to, children }: PropsWithChildren<{ to: string }>) {
  return (
    <Link className={cn(buttonVariants({ variant: "link", size: "sm" }), styles.inlineLink)} to={to}>
      {children}
      <ArrowRight aria-hidden="true" />
    </Link>
  );
}

export function formatDate(value?: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return `${new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function formatTime(value?: string | null): string {
  if (!value) return "This process only";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "This process only";
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function sentenceCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
