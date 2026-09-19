export type OwnershipClass =
  | "canonical"
  | "derived"
  | "local"
  | "ephemeral";

export interface DataOwnershipRule {
  data: string;
  location: string;
  ownership: OwnershipClass;
  gitTracked: boolean;
  owner: "repository" | "wiki-adapter" | "team-workflows" | "process";
}

/**
 * Consumer-side path and ownership lock from the human-team build specification.
 * The Wiki adapter must confirm that its parser accepts these canonical paths.
 * `owner` means canonical mutation owner, not exclusive reader: the Wiki may
 * index team-workflow Markdown, but only TeamWorkflowPort may author it.
 */
export const DATA_OWNERSHIP: readonly DataOwnershipRule[] = [
  {
    data: "Repository code and Git history",
    location: ".",
    ownership: "canonical",
    gitTracked: true,
    owner: "repository",
  },
  {
    data: "Wiki context entities",
    location: ".mex/context/**",
    ownership: "canonical",
    gitTracked: true,
    owner: "wiki-adapter",
  },
  {
    data: "Wiki pattern entities",
    location: ".mex/patterns/**",
    ownership: "canonical",
    gitTracked: true,
    owner: "wiki-adapter",
  },
  {
    data: "Team members",
    location: ".mex/team/members/<member-id>.md",
    ownership: "canonical",
    gitTracked: true,
    owner: "team-workflows",
  },
  {
    data: "Workstreams",
    location: ".mex/workstreams/<workstream-id>.md",
    ownership: "canonical",
    gitTracked: true,
    owner: "team-workflows",
  },
  {
    data: "Published Inbox proposals",
    location: ".mex/inbox/<proposal-id>.md",
    ownership: "canonical",
    gitTracked: true,
    owner: "team-workflows",
  },
  {
    data: "Published Relays",
    location: ".mex/relays/<relay-id>.md",
    ownership: "canonical",
    gitTracked: true,
    owner: "team-workflows",
  },
  {
    data: "Specs and requirements",
    location: ".mex/specs/**",
    ownership: "canonical",
    gitTracked: true,
    owner: "wiki-adapter",
  },
  {
    data: "Optional topic entities",
    location: ".mex/topics/**",
    ownership: "canonical",
    gitTracked: true,
    owner: "wiki-adapter",
  },
  {
    data: "Playbooks and shared runs",
    location: ".mex/playbooks/**",
    ownership: "canonical",
    gitTracked: true,
    owner: "team-workflows",
  },
  {
    data: "Team activity",
    location: ".mex/events/activity/YYYY-MM/<event-id>.md",
    ownership: "canonical",
    gitTracked: true,
    owner: "team-workflows",
  },
  {
    data: "Legacy decision events",
    location: ".mex/events/decisions.jsonl",
    ownership: "canonical",
    gitTracked: true,
    owner: "repository",
  },
  {
    data: "Accepted Wiki operation audit",
    location: ".mex/events/operations.jsonl",
    ownership: "canonical",
    gitTracked: true,
    owner: "wiki-adapter",
  },
  {
    data: "Code graph",
    location: ".mex/graph.db*",
    ownership: "derived",
    gitTracked: false,
    owner: "repository",
  },
  {
    data: "Wiki index",
    location: ".mex/wiki.db*",
    ownership: "derived",
    gitTracked: false,
    owner: "wiki-adapter",
  },
  {
    data: "Drafts, cursors, and local jobs",
    location: ".mex/local/team.db*",
    ownership: "local",
    gitTracked: false,
    owner: "team-workflows",
  },
  {
    data: "Identity and Activity preview signing credential",
    location: ".mex/local/identity-activity-signing.key",
    ownership: "local",
    gitTracked: false,
    owner: "team-workflows",
  },
  {
    data: "Hub session token",
    location: "process memory",
    ownership: "ephemeral",
    gitTracked: false,
    owner: "process",
  },
  {
    data: "Optional AI Catch Up narration",
    location: "UI or CLI output",
    ownership: "ephemeral",
    gitTracked: false,
    owner: "process",
  },
] as const;

export const TEAM_ARTIFACT_PATHS = {
  members: ".mex/team/members",
  workstreams: ".mex/workstreams",
  inbox: ".mex/inbox",
  relays: ".mex/relays",
  specs: ".mex/specs",
  topics: ".mex/topics",
  playbooks: ".mex/playbooks",
  playbookRuns: ".mex/playbooks/runs",
  activity: ".mex/events/activity",
  wikiOperations: ".mex/events/operations.jsonl",
  localState: ".mex/local/team.db",
  localReceiptSigner: ".mex/local/identity-activity-signing.key",
} as const;
