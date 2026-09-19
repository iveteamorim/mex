import {
  INBOX_ACTION_CONTRACT_MAX_BYTES,
  INBOX_CONTRACT_ACTIONS,
  inboxActionContractData,
  inboxContractCatalogData,
  INBOX_CONTRACT_COMMAND,
  isInboxContractAction,
  type InboxActionContractData,
  type InboxContractCatalogData,
} from "../../../capabilities.js";
import { TEAM_INBOX_SPEC_LIMITS } from "../../contracts/workflow.js";
import type { TeamCommandIo, TeamOutputFlags } from "../../cli/commands.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
  TeamCliUsageError,
  type TeamCliEnvelope,
} from "../../cli/envelope.js";

export interface InboxContractFlags extends TeamOutputFlags {
  action?: string;
}

/**
 * Resolve the governed Inbox contracts without opening a repository service.
 *
 * This command is intentionally static: it is usable before Git or `.mex`
 * exists, never initializes Team state, and carries the ordinary Team JSON
 * envelope so malformed JSON-mode invocations keep the same typed exits.
 */
export function runInboxContract(flags: InboxContractFlags, io: TeamCommandIo): void {
  let envelope: TeamCliEnvelope<InboxContractCatalogData | InboxActionContractData>;
  try {
    if (flags.action !== undefined && !isInboxContractAction(flags.action)) {
      throw new TeamCliUsageError(
        `--action must be one of: ${INBOX_CONTRACT_ACTIONS.join(", ")}.`,
      );
    }
    envelope = teamEnvelope({
      command: "inbox.contract",
      mode: "read",
      data: flags.action === undefined
        ? inboxContractCatalogData()
        : inboxActionContractData(flags.action),
    });
  } catch (error) {
    envelope = teamProblemEnvelope("inbox.contract", "read", error);
  }
  let rendered = renderTeamEnvelope(envelope);
  const maxBytes = flags.action === undefined
    ? TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes
    : INBOX_ACTION_CONTRACT_MAX_BYTES;
  if (Buffer.byteLength(rendered, "utf8") > maxBytes) {
    envelope = teamProblemEnvelope(
      "inbox.contract",
      "read",
      new Error("The static Inbox contract result exceeded its bounded envelope."),
    );
    rendered = renderTeamEnvelope(envelope);
  }
  if (flags.json === true) io.write(rendered);
  else if (envelope.data === null) io.write(envelope.problem?.detail ?? "Inbox contract resolution failed.");
  else if (flags.action === undefined) {
    io.write(`Run ${INBOX_CONTRACT_COMMAND} to emit the versioned machine contract catalog.`);
  } else {
    io.write(`Run mex inbox contract --action ${flags.action} --json to emit the focused action contract.`);
  }
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}
