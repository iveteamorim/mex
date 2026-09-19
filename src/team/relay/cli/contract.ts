import { TEAM_RELAY_LIMITS } from "../../contracts/workflow.js";
import type { TeamCommandIo, TeamOutputFlags } from "../../cli/commands.js";
import {
  exitCodeForTeamEnvelope,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
  TeamCliUsageError,
  type TeamCliEnvelope,
} from "../../cli/envelope.js";
import {
  RELAY_ACTION_CONTRACT_MAX_BYTES,
  RELAY_CONTRACT_ACTIONS,
  RELAY_CONTRACT_COMMAND,
  isRelayContractAction,
  relayActionContractData,
  relayContractCatalogData,
  type RelayActionContractData,
  type RelayContractCatalogData,
} from "./contract-catalog.js";

export interface RelayContractFlags extends TeamOutputFlags {
  action?: string;
}

/** Resolve Relay contracts without opening Git, Home, or a repository service. */
export function runRelayContract(flags: RelayContractFlags, io: TeamCommandIo): void {
  let envelope: TeamCliEnvelope<RelayContractCatalogData | RelayActionContractData>;
  try {
    if (flags.action !== undefined && !isRelayContractAction(flags.action)) {
      throw new TeamCliUsageError(
        `--action must be one of: ${RELAY_CONTRACT_ACTIONS.join(", ")}.`,
      );
    }
    envelope = teamEnvelope({
      command: "relay.contract",
      mode: "read",
      data: flags.action === undefined
        ? relayContractCatalogData()
        : relayActionContractData(flags.action),
    });
  } catch (error) {
    envelope = teamProblemEnvelope("relay.contract", "read", error);
  }
  let rendered = renderTeamEnvelope(envelope);
  const maxBytes = flags.action === undefined
    ? TEAM_RELAY_LIMITS.maxEnvelopeBytes
    : RELAY_ACTION_CONTRACT_MAX_BYTES;
  if (Buffer.byteLength(rendered, "utf8") > maxBytes) {
    envelope = teamProblemEnvelope(
      "relay.contract",
      "read",
      new Error("The static Relay contract result exceeded its bounded envelope."),
    );
    rendered = renderTeamEnvelope(envelope);
  }
  if (flags.json === true) io.write(rendered);
  else if (envelope.data === null) io.write(envelope.problem?.detail ?? "Relay contract resolution failed.");
  else if (flags.action === undefined) {
    io.write(`Run ${RELAY_CONTRACT_COMMAND} to emit the versioned machine contract catalog.`);
  } else {
    io.write(`Run mex relay contract --action ${flags.action} --json to emit the focused action contract.`);
  }
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}
