import type { AgentAssetAction } from "./types.js";

/**
 * Render only the bounded managed-block delta carried by an instruction action.
 * User-owned bytes outside the markers are intentionally never included.
 */
export function renderInstructionChangePreview(
  action: AgentAssetAction,
): string | null {
  const change = action.instructionChange;
  if (action.kind !== "instructions" || change === undefined) return null;
  return [
    `Instruction change (${change.scope}) for ${action.path}:`,
    "--- before MEX managed block ---",
    change.before ?? "(none)",
    "--- after MEX managed block ---",
    change.after,
  ].join("\n");
}
