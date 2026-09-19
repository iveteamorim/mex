/**
 * §16 `wiki_validate` — the whole-scaffold pass, behind the service contract.
 *
 * A thin adapter on purpose. Every decision lives in `validation/validate.ts`;
 * this maps its report onto `ServiceResult` so `ok` and the exit status are
 * derived by the same envelope every other command uses.
 */

import { validateScaffold, type ValidateOptions, type ValidationReport } from "../validation/validate.js";
import type { ServiceResult } from "./read.js";

export interface ValidateData {
  filesScanned: number;
  entitiesChecked: number;
  counts: ValidationReport["counts"];
  /** True when a bound stopped the diagnostic list — data, never a diagnostic. */
  truncated: boolean;
  /**
   * True when there were groundings and not one of them produced a verdict.
   *
   * Reported in `data` rather than as a diagnostic because it is not a problem
   * with the scaffold: it is a statement about how much of the scaffold was
   * actually checked, and a caller in CI needs to be able to tell a clean run
   * from an unread one.
   *
   * Two causes, so it is never enough on its own: read it with
   * {@link ValidateData.codeGraphAvailable}.
   */
  groundingsUnverified: boolean;
  /** Whether a code graph was supplied — the discriminator for the flag above. */
  codeGraphAvailable: boolean;
}

export function wikiValidate(options: ValidateOptions): ServiceResult<ValidateData> {
  const report = validateScaffold(options);
  return {
    data: {
      filesScanned: report.filesScanned,
      entitiesChecked: report.entitiesChecked,
      counts: report.counts,
      truncated: report.truncated,
      groundingsUnverified: report.groundingsUnverified,
      codeGraphAvailable: report.codeGraphAvailable,
    },
    diagnostics: report.diagnostics,
  };
}
