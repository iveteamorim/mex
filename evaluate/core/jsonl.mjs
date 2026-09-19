export function parseJsonLines(raw, label = "JSONL") {
  const records = [];
  const errors = [];
  const lines = String(raw).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try {
      const record = JSON.parse(lines[index]);
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        errors.push(`${label} line ${index + 1} is not an object`);
      } else {
        records.push(record);
      }
    } catch (error) {
      errors.push(`${label} line ${index + 1} is malformed JSON: ${error.message}`);
    }
  }
  if (records.length === 0 && errors.length === 0) errors.push(`${label} is empty`);
  return { records, errors };
}

export function validateGraphResponse(records, expectedCommand, options = {}) {
  const errors = [];
  if (!records.length) return ["graph response contains no records"];
  if (options.allowTerminalError && records.every((record) => record.type === "error")) return errors;
  const meta = records[0];
  const summary = records.at(-1);
  if (meta?.type !== "meta") errors.push("graph response does not start with a meta record");
  if (meta?.command !== expectedCommand) {
    errors.push(`graph response command is ${JSON.stringify(meta?.command)}, expected ${JSON.stringify(expectedCommand)}`);
  }
  if (summary?.type !== "summary" && !options.allowTerminalError) {
    errors.push("graph response does not end with a summary record");
  }
  if (records.some((record) => record.type === "error") && !options.allowErrorRecords) {
    const codes = records.filter((record) => record.type === "error").map((record) => record.code ?? "UNKNOWN");
    errors.push(`graph response contains error record(s): ${codes.join(", ")}`);
  }
  return errors;
}
