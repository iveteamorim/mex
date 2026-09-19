import { Command } from "commander";
import type {
  TeamCommandIo,
  TeamOutputFlags,
  TeamPageFlags,
} from "../../cli/commands.js";
import {
  runRelayDraftList,
  runRelayDraftShow,
  runRelayList,
  runRelayMutation,
  runRelayShow,
  type RelayListFlags,
  type RelayMutationFlags,
} from "./commands.js";
import { runRelayContract, type RelayContractFlags } from "./contract.js";
import type { RelayMutationCommandName } from "./request-file.js";
import type { TeamRelayCliServiceFactory } from "./service.js";

export interface RelayCommandBuilderOptions {
  service: TeamRelayCliServiceFactory;
  io: TeamCommandIo;
}

/** Build the governed `mex relay` product tree for root CLI composition. */
export function buildRelayCommand(options: RelayCommandBuilderOptions): Command {
  const relay = new Command("relay")
    .description("Draft, publish, claim, and close repository-native team handoffs");

  relay.command("contract")
    .description("Resolve the bounded versioned Relay JSON Schema catalog")
    .option("--action <command-id>", "Resolve only one supported mutation command contract")
    .option("--json", "Emit the schema v1 Team envelope")
    .action((flags: RelayContractFlags) => runRelayContract(flags, options.io));

  const draft = relay.command("draft").description("Manage checkout-local Relay drafts");
  draft.command("list")
    .description("List bounded local Relay draft summaries")
    .option("--cursor <cursor>", "Continue a bounded revision-bound page")
    .option("--limit <n>", "Maximum results (1-100)")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: TeamPageFlags) => runRelayDraftList(options.service, flags, options.io));
  draft.command("show")
    .description("Show one complete local Relay draft")
    .argument("<draft-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runRelayDraftShow(options.service, id, flags, options.io));
  addMutation(draft, "save", "Preview or apply saving one local Relay draft", "relay.draft.save", options);
  addMutation(draft, "delete", "Preview or apply deleting one exact local Relay draft", "relay.draft.delete", options);

  relay.command("list")
    .description("List bounded canonical Relays")
    .option("--perspective <perspective>", "Filter by all, mine, or sent")
    .option("--state <state>", "Filter by Relay lifecycle state; repeatable", collect)
    .option(
      "--workstream <workstream-id>",
      "Filter legacy schema-v1/v2 Relays by their recorded Workstream",
    )
    .option("--cursor <cursor>", "Continue a bounded revision-bound page")
    .option("--limit <n>", "Maximum results (1-100)")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: RelayListFlags) => runRelayList(options.service, flags, options.io));
  relay.command("show")
    .description("Show one complete canonical Relay")
    .argument("<relay-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runRelayShow(options.service, id, flags, options.io));

  addMutation(relay, "publish", "Preview or apply publishing one local Relay draft", "relay.publish", options);
  addMutation(relay, "acknowledge", "Preview or apply claiming one published Relay", "relay.acknowledge", options);
  addMutation(relay, "close", "Preview or apply closing one acknowledged Relay", "relay.close", options);
  return relay;
}

function addMutation(
  parent: Command,
  name: string,
  description: string,
  command: RelayMutationCommandName,
  options: RelayCommandBuilderOptions,
): void {
  const mutation = parent.command(name)
    .description(description)
    .argument("[request-file]", "Caller-authored schema v1 Relay request for preview")
    .option("--apply <preview-envelope>", "Apply the exact complete JSON envelope emitted by preview")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (requestFile: string | undefined, flags: RelayMutationFlags) => {
      await runRelayMutation(options.service, command, requestFile, flags, options.io);
    });
  if (command === "relay.draft.save") {
    mutation.option("--from <draft-file>", "Create a local draft from sparse JSON content; internally preview and apply without publishing")
      .option("--operation-id <id>", "Use a stable operation ID for --from");
  }
}

function collect(value: string, previous: readonly string[] = []): readonly string[] {
  return [...previous, value];
}
