import { parseStructuredAnswer } from "../../compare/lib/answer.mjs";
import { parseEventStream, toolMetrics, usageRecord } from "./shared.mjs";

function commandText(item) {
  if (typeof item.command === "string") return item.command;
  if (Array.isArray(item.command)) return item.command.join(" ");
  return "";
}

function itemOutput(item) {
  return typeof item.aggregated_output === "string" ? item.aggregated_output
    : typeof item.output === "string" ? item.output
      : null;
}

export const codexAdapter = {
  id: "codex",

  buildInvocation({ executable = "codex", prefix = [], prompt, model, schemaPath, subjectRoot }) {
    return {
      command: executable,
      args: [
        ...prefix,
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--json",
        "--color", "never",
        "--model", model,
        "--output-schema", schemaPath,
        "--add-dir", subjectRoot,
        prompt,
      ],
    };
  },

  parseTranscript(raw, task) {
    const { events, malformedLines } = parseEventStream(raw, "Codex stream");
    const rawUsage = [];
    let input = 0;
    let cached = 0;
    let output = 0;
    let reasoningOutput = 0;
    let resultValue = "";
    let turns = 0;
    const toolCalls = [];
    const byId = new Map();
    for (const event of events) {
      if (event.type === "turn.completed") {
        turns += 1;
        const value = event.usage ?? {};
        rawUsage.push(value);
        input += Number(value.input_tokens ?? 0);
        cached += Number(value.cached_input_tokens ?? 0);
        output += Number(value.output_tokens ?? 0);
        reasoningOutput += Number(value.reasoning_output_tokens ?? 0);
      } else if (event.type === "item.started" && event.item?.type === "command_execution") {
        const call = { id: event.item.id ?? null, name: "Bash", input: { command: commandText(event.item) }, status: "attempted", output: null };
        toolCalls.push(call);
        if (call.id) byId.set(call.id, call);
      } else if (event.type === "item.completed" && event.item?.type === "command_execution") {
        let call = byId.get(event.item.id);
        if (!call) {
          call = { id: event.item.id ?? null, name: "Bash", input: { command: commandText(event.item) }, status: "attempted", output: null };
          toolCalls.push(call);
        }
        call.output = itemOutput(event.item);
        const exitCode = Number(event.item.exit_code);
        call.status = event.item.status === "failed" || (Number.isFinite(exitCode) && exitCode !== 0) ? "error" : "executed";
      } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
        resultValue = event.item.text ?? resultValue;
      }
    }
    const uncachedInput = Math.max(0, input - cached);
    const usage = usageRecord({
      uncachedInput,
      cacheWrite: null,
      cacheRead: cached,
      output,
      reasoningOutput,
      reportedInput: input,
      reportedTotal: input + output,
      reportedCostUsd: null,
    }, rawUsage);
    const tools = toolMetrics(toolCalls, task);
    return {
      provider: "codex",
      usage,
      turns,
      toolCalls,
      ...tools,
      malformedLines,
      structured: parseStructuredAnswer(resultValue),
      rawResult: resultValue,
    };
  },
};
