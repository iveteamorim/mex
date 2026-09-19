import { Command } from "commander";
import { findConfig } from "../config.js";
import { MexPortError, isRevision } from "../team/contracts/shared.js";
import { artifactError } from "../team/artifacts/errors.js";
import {
  isAgentLoggingMode,
  readAgentLoggingPolicy,
  setAgentLoggingPolicy,
  type AgentLoggingPolicy,
} from "./policy.js";

interface LoggingCommandOptions {
  projectRoot?: () => string;
  write?: (message: string) => void;
  setExitCode?: (code: number) => void;
}

/** Small checkout-only CLI shared with the Hub preference adapter. */
export function buildLoggingCommand(options: LoggingCommandOptions = {}): Command {
  const write = options.write ?? ((message) => console.log(message));
  const setExitCode = options.setExitCode ?? ((code) => { process.exitCode = code; });
  return new Command("logging")
    .description("Read or set this checkout's advisory agent logging cadence")
    .argument("[mode]", "significant (default), checkpoints, or manual")
    .option("--expected-revision <revision>", "Require an exact preference revision, or none for an absent preference")
    .option("--json", "Emit a bounded logging preference JSON envelope")
    .action(async (mode: string | undefined, flags: { expectedRevision?: string; json?: boolean }) => {
      try {
        if ((mode !== undefined && !isAgentLoggingMode(mode))
          || (mode === undefined && flags.expectedRevision !== undefined)
          || (flags.expectedRevision !== undefined && flags.expectedRevision !== "none" && !isRevision(flags.expectedRevision))) {
          throw artifactError("INVALID_REQUEST", "Invalid logging command", "Use mex logging [significant|checkpoints|manual] [--expected-revision <revision|none>] --json.");
        }
        const projectRoot = options.projectRoot?.() ?? findConfig().projectRoot;
        const current = readAgentLoggingPolicy(projectRoot);
        const policy = mode === undefined ? current : await setAgentLoggingPolicy(projectRoot, {
          mode,
          expectedRevision: flags.expectedRevision === undefined
            ? current.revision
            : flags.expectedRevision === "none" ? null : flags.expectedRevision,
        });
        if (flags.json) write(JSON.stringify({ schemaVersion: 1, command: "logging", ok: true, scope: "checkout", data: policy, problem: null }));
        else write(renderPolicy(policy, mode !== undefined));
        setExitCode(0);
      } catch (error) {
        const problem = error instanceof MexPortError ? error.problem : {
          code: "INVALID_REQUEST", status: 422, title: "Logging preference unavailable",
          detail: "Run mex logging from an existing MEX project with a readable checkout preference.",
        };
        if (flags.json) write(JSON.stringify({ schemaVersion: 1, command: "logging", ok: false, scope: "checkout", data: null, problem }));
        else write(`${problem.code}: ${problem.detail}`);
        setExitCode(problem.code === "REVISION_CONFLICT" ? 4 : 1);
      }
    });
}

function renderPolicy(policy: AgentLoggingPolicy, changed: boolean): string {
  const explanation = policy.mode === "significant"
    ? "Record meaningful decisions, risks, and durable discoveries; skip routine progress."
    : policy.mode === "checkpoints"
      ? "Batch useful optional notes at task or session boundaries."
      : "Write optional notes only when the user requests them.";
  return `${changed ? "Saved" : "Agent logging:"} ${policy.mode} (${policy.source}, this checkout only). ${explanation} Explicit user log requests and required workflow Activity are always honored.`;
}
