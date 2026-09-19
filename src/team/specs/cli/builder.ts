import { Command } from "commander";
import type { TeamCommandIo, TeamOutputFlags } from "../../cli/commands.js";
import {
  runSpecList,
  runSpecShow,
  type SpecListFlags,
} from "./commands.js";
import type { SpecCliServiceFactory } from "./service.js";

export interface SpecCommandBuilderOptions {
  service: SpecCliServiceFactory;
  io: TeamCommandIo;
}

/** Build, but deliberately do not register, the read-only `mex spec` tree. */
export function buildSpecCommand(options: SpecCommandBuilderOptions): Command {
  const spec = new Command("spec")
    .description("Read canonical Specs from the existing Wiki index");

  spec.command("list")
    .description("List root Spec entities")
    .option("--cursor <cursor>", "Continue a bounded revision-bound page")
    .option("--limit <n>", "Maximum results (1-100)")
    .option("--include-archived", "Include archived Specs")
    .option("--lifecycle <state>", "Filter by canonical lifecycle state")
    .option("--grounding <health>", "Filter by checkout-local grounding health")
    .option("--topic <entity-id>", "Filter by an explicit Wiki topic ID")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: SpecListFlags) => runSpecList(options.service, flags, options.io));

  spec.command("show")
    .description("Show one root Spec and its bounded explicit hierarchy")
    .argument("<spec-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runSpecShow(options.service, id, flags, options.io));

  return spec;
}
