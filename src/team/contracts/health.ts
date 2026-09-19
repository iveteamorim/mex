import type { Diagnostic, RepoState } from "./shared.js";
import type { GraphStatus } from "./graph.js";
import type { WikiIndexStatus } from "./wiki.js";

export type HealthStatus = "healthy" | "degraded" | "unavailable";

export interface ComponentHealth {
  status: HealthStatus;
  summary: string;
  diagnostics: readonly Diagnostic[];
}

type ComponentHealthDetails = Omit<ComponentHealth, "status">;
type AvailableHealthStatus = Exclude<HealthStatus, "unavailable">;

export type GitHealth = ComponentHealthDetails & (
  | { status: AvailableHealthStatus; repo: RepoState }
  | { status: "unavailable"; repo: null }
);

export type GraphHealth = ComponentHealthDetails & (
  | { status: AvailableHealthStatus; index: GraphStatus }
  | { status: "unavailable"; index: null }
);

export type WikiHealth = ComponentHealthDetails & (
  | { status: AvailableHealthStatus; index: WikiIndexStatus }
  | { status: "unavailable"; index: null }
);

export type MigrationState = "ready" | "required" | "failed";

export type MigrationHealth = ComponentHealthDetails & (
  | {
      status: "healthy" | "degraded";
      state: "ready";
      fromVersion: null;
      toVersion: null;
    }
  | {
      status: "degraded" | "unavailable";
      state: "required";
      fromVersion: string | null;
      toVersion: string;
    }
  | {
      status: "unavailable";
      state: "failed";
      fromVersion: string | null;
      toVersion: string | null;
    }
);

export type LocalStateStatus =
  | "ready"
  | "missing"
  | "migration_required"
  | "corrupt";

export type LocalStateHealth = ComponentHealthDetails & (
  | { status: "healthy" | "degraded"; state: "ready"; schemaVersion: number }
  | {
      status: "degraded" | "unavailable";
      state: "migration_required";
      schemaVersion: number | null;
    }
  | {
      status: "unavailable";
      state: "missing" | "corrupt";
      schemaVersion: null;
    }
);

/** Compatibility name for callers that inspect one fixed aggregate component. */
export type HealthComponent =
  | GitHealth
  | GraphHealth
  | WikiHealth
  | MigrationHealth
  | LocalStateHealth;

export interface ProjectHealth {
  status: HealthStatus;
  observedAt: string;
  git: GitHealth;
  graph: GraphHealth;
  wiki: WikiHealth;
  migration: MigrationHealth;
  localState: LocalStateHealth;
  diagnostics: readonly Diagnostic[];
}

/**
 * Fixed aggregate health seam. Inspection is strictly non-mutating; repairs
 * remain explicit operations on their owning ports.
 */
export interface HealthPort {
  inspect(): Promise<ProjectHealth>;
}
