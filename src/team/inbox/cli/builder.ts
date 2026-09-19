import { Command } from "commander";
import type { RepositoryWikiPort } from "../../../wiki/application-adapter.js";
import type {
  TeamCommandIo,
  TeamMutationFlags,
  TeamOutputFlags,
  TeamPageFlags,
} from "../../cli/commands.js";
import {
  runInboxDraftList,
  runInboxDraftShow,
  runInboxMutation,
  runInboxProposalList,
  runInboxProposalShow,
  runInboxTarget,
  type InboxProposalListFlags,
} from "./commands.js";
import type { InboxMutationCommandName } from "./request-file.js";
import type { TeamInboxSpecCliServiceFactory } from "./service.js";
import { runInboxContract, type InboxContractFlags } from "./contract.js";

export interface InboxCommandBuilderOptions {
  service: TeamInboxSpecCliServiceFactory;
  targetService?: () => Pick<RepositoryWikiPort, "readInboxTarget"> | Promise<Pick<RepositoryWikiPort, "readInboxTarget">>;
  io: TeamCommandIo;
}

/** Build, but do not register, the governed `mex inbox` product tree. */
export function buildInboxCommand(options: InboxCommandBuilderOptions): Command {
  const inbox = new Command("inbox")
    .description("Propose and review additions or corrections to project knowledge");

  inbox.command("target")
    .description("Resolve an existing knowledge record and exact revision for a correction")
    .argument("<entity-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runInboxTarget(
      options.targetService ?? (() => { throw new Error("Inbox target reader is unavailable."); }),
      id, flags, options.io,
    ));

  inbox.command("contract")
    .description("Resolve the bounded versioned Inbox JSON Schema catalog")
    .option("--action <command-id>", "Resolve only one supported mutation command contract")
    .option("--json", "Emit the schema v1 Team envelope")
    .action((flags: InboxContractFlags) => runInboxContract(flags, options.io));

  const draft = inbox.command("draft").description("Manage checkout-local Inbox drafts");
  draft.command("list")
    .description("List bounded local draft summaries")
    .option("--cursor <cursor>", "Continue a bounded revision-bound page")
    .option("--limit <n>", "Maximum results (1-100)")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: TeamPageFlags) => runInboxDraftList(options.service, flags, options.io));
  draft.command("show")
    .description("Show one complete local Inbox draft")
    .argument("<draft-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runInboxDraftShow(options.service, id, flags, options.io));
  addMutation(draft, "save", "Preview or apply saving one local draft", "inbox.draft.save", options);
  addMutation(draft, "delete", "Preview or apply deleting one exact local draft", "inbox.draft.delete", options);

  const proposal = inbox.command("proposal").description("Review canonical portable Inbox proposals");
  proposal.command("list")
    .description("List bounded canonical proposal summaries")
    .option("--state <state>", "Filter by proposal lifecycle state; repeatable", collect)
    .option("--cursor <cursor>", "Continue a bounded revision-bound page")
    .option("--limit <n>", "Maximum results (1-100)")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: InboxProposalListFlags) => runInboxProposalList(options.service, flags, options.io));
  proposal.command("show")
    .description("Show one complete canonical proposal")
    .argument("<proposal-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runInboxProposalShow(options.service, id, flags, options.io));
  addMutation(proposal, "approve", "Preview or apply approval and the exact knowledge write", "inbox.proposal.approve", options);
  addMutation(proposal, "reject", "Preview or apply proposal rejection", "inbox.proposal.reject", options);
  addMutation(proposal, "withdraw", "Preview or apply proposal withdrawal", "inbox.proposal.withdraw", options);
  addMutation(proposal, "mark-stale", "Preview or apply a proven stale transition", "inbox.proposal.mark-stale", options);
  addMutation(proposal, "repair", "Preview or apply stale proposal repair", "inbox.proposal.repair", options);

  addMutation(inbox, "publish", "Preview or apply publishing one local draft", "inbox.publish", options);
  return inbox;
}

function addMutation(
  parent: Command,
  name: string,
  description: string,
  command: InboxMutationCommandName,
  options: InboxCommandBuilderOptions,
): void {
  parent.command(name)
    .description(description)
    .argument("[request-file]", "Caller-authored schema v1 Inbox request for preview")
    .option("--apply <preview-envelope>", "Apply the exact complete JSON envelope emitted by preview")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (requestFile: string | undefined, flags: TeamMutationFlags) => {
      await runInboxMutation(options.service, command, requestFile, flags, options.io);
    });
}

function collect(value: string, previous: readonly string[] = []): readonly string[] {
  return [...previous, value];
}
