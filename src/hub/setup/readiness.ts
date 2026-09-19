import type { SetupStatus } from "@mex/hub-contracts/setup";
import { inspectSetupStatus } from "../../setup/headless.js";
import { setupCommitCheckpointCommands } from "../../setup/index.js";
import { createRepositoryTeamWorkflowPort } from "../../team/workflow/repository-team-workflow-port.js";

/** Use the same read-only authority check as production; never provision state. */
export async function hasCommittedHubIdentity(projectRoot: string): Promise<boolean> {
  try {
    await createRepositoryTeamWorkflowPort(projectRoot);
    return true;
  } catch {
    return false;
  }
}

export async function projectSetupStatus(projectRoot: string): Promise<SetupStatus> {
  const status = inspectSetupStatus(projectRoot);
  const ready = status.ready && status.mode === "code-repo"
    && await hasCommittedHubIdentity(projectRoot);
  return {
    mode: status.mode,
    projectName: status.projectName,
    hasGit: status.hasGit,
    hasScaffold: status.hasScaffold,
    populated: status.populated,
    graphReady: status.graphReady,
    wikiReady: status.wikiReady,
    state: status.state,
    stage: status.ready ? status.mode === "agent-memory" ? "complete" : ready ? "ready" : "needs_commit" : status.stage,
    configuredTools: status.configuredTools,
    tools: [...status.tools],
    ready,
    commitCommands: status.mode === "code-repo" && status.ready
      ? setupCommitCheckpointCommands(status.configuredTools)
      : [],
  };
}

/** The initial snapshot requires no Git subprocesses or asynchronous constructor. */
export function initialSetupStatus(projectRoot: string): SetupStatus {
  const status = inspectSetupStatus(projectRoot);
  return {
    mode: status.mode,
    projectName: status.projectName,
    hasGit: status.hasGit,
    hasScaffold: status.hasScaffold,
    populated: status.populated,
    graphReady: status.graphReady,
    wikiReady: status.wikiReady,
    state: status.state,
    stage: status.ready ? status.mode === "agent-memory" ? "complete" : "needs_commit" : status.stage,
    configuredTools: status.configuredTools,
    tools: [...status.tools],
    ready: false,
    commitCommands: status.mode === "code-repo" && status.ready
      ? setupCommitCheckpointCommands(status.configuredTools)
      : [],
  };
}
