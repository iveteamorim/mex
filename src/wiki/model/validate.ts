import {
  diagnostic,
  type DiagnosticSeverity,
  type WikiDiagnostic,
  type WikiDiagnosticCode,
} from "./diagnostic.js";

/**
 * A small validator-combinator library.
 *
 * Two properties are load-bearing and everything else here serves them:
 *
 * 1. **Validators return diagnostics; they never throw.** A `.mex` file with
 *    four problems must report four, with codes and locations, in one pass.
 * 2. **A validator narrows the type on success.** `ValidationResult<T>` is a
 *    discriminated union, so a caller that checks `result.ok` has a typed value
 *    without a cast.
 *
 * mex hand-rolls type guards elsewhere (`isGroundingArray` in `src/markdown.ts`
 * is the house style) and adds dependencies carefully, so this is deliberately
 * ~200 lines of plain functions rather than a schema library. The combinators
 * exist because the alternative — repeating "is it an object, does it have this
 * key, is that key a string, push a diagnostic naming the right path" across
 * seven model files — is where path-reporting bugs come from.
 */

/** Context threaded through validation so every diagnostic knows where it came from. */
export interface ValidationContext {
  /**
   * Structural path to the value under validation, e.g.
   * `entities[3].relations[1].target`. Empty at the root.
   */
  path: string;
  /** File the value was read from, when it came from one. */
  file?: string;
  /** Entity the value belongs to, when known. */
  entityId?: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; diagnostics: WikiDiagnostic[] }
  | { ok: false; diagnostics: WikiDiagnostic[] };

export type Validator<T> = (value: unknown, context: ValidationContext) => ValidationResult<T>;

/** Root context for a value with no enclosing file or entity. */
export function rootContext(options: Omit<ValidationContext, "path"> = {}): ValidationContext {
  return { path: "", ...options };
}

/** Descend into an object property, extending the diagnostic path. */
export function childContext(context: ValidationContext, key: string): ValidationContext {
  return { ...context, path: context.path === "" ? key : `${context.path}.${key}` };
}

/** Descend into an array element, extending the diagnostic path. */
export function indexContext(context: ValidationContext, index: number): ValidationContext {
  return { ...context, path: `${context.path}[${index}]` };
}

/** Build a diagnostic already carrying this context's path, file and entity. */
export function contextDiagnostic(
  context: ValidationContext,
  code: WikiDiagnosticCode,
  message: string,
  options: { severity?: DiagnosticSeverity; remediation?: string } = {},
): WikiDiagnostic {
  return diagnostic(code, message, {
    ...options,
    path: context.path === "" ? undefined : context.path,
    file: context.file,
    entityId: context.entityId,
  });
}

export function succeed<T>(value: T, diagnostics: WikiDiagnostic[] = []): ValidationResult<T> {
  return { ok: true, value, diagnostics };
}

export function failWith(...diagnostics: WikiDiagnostic[]): ValidationResult<never> {
  return { ok: false, diagnostics };
}

/**
 * Fail with one diagnostic built from this context.
 *
 * The overwhelmingly common failure shape, so it gets a one-liner — most
 * validators below are a type test plus a call to this.
 */
export function reject(
  context: ValidationContext,
  code: WikiDiagnosticCode,
  message: string,
  options: { severity?: DiagnosticSeverity; remediation?: string } = {},
): ValidationResult<never> {
  return failWith(contextDiagnostic(context, code, message, options));
}

/** Describe a value in a diagnostic message without dumping its contents. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "string") return `a string (${JSON.stringify(truncate(value as string))})`;
  if (type === "number" || type === "boolean") return String(value);
  if (type === "undefined") return "missing";
  return `a ${type}`;
}

function truncate(value: string, limit = 40): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

// -- Leaf validators ---------------------------------------------------------

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A plain object — excludes arrays and null, which `typeof` does not. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateString(options: { allowEmpty?: boolean } = {}): Validator<string> {
  return (value, context) => {
    if (typeof value !== "string") {
      return reject(context, "INVALID_FIELD_TYPE", `Expected a string, got ${describe(value)}.`);
    }
    if (!options.allowEmpty && value.trim().length === 0) {
      return reject(context, "MISSING_REQUIRED_FIELD", "Expected a non-empty string.");
    }
    return succeed(value);
  };
}

/**
 * A finite number in a closed range.
 *
 * Beside {@link validateInteger} rather than folded into it: a confidence is a
 * real number in [0, 1] and an integer validator that grew a "well, unless"
 * branch would be a worse home for both. `NaN` and the infinities fail on the
 * finiteness test rather than sliding through a comparison that is false for
 * every bound.
 */
export function validateNumber(options: { min?: number; max?: number } = {}): Validator<number> {
  return (value, context) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected a finite number, got ${describe(value)}.`);
    }
    if (options.min !== undefined && value < options.min) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected a number >= ${options.min}, got ${value}.`);
    }
    if (options.max !== undefined && value > options.max) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected a number <= ${options.max}, got ${value}.`);
    }
    return succeed(value);
  };
}

export function validateInteger(options: { min?: number; max?: number } = {}): Validator<number> {
  return (value, context) => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected an integer, got ${describe(value)}.`);
    }
    if (options.min !== undefined && value < options.min) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected an integer >= ${options.min}, got ${value}.`);
    }
    if (options.max !== undefined && value > options.max) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected an integer <= ${options.max}, got ${value}.`);
    }
    return succeed(value);
  };
}

/**
 * A value drawn from a fixed vocabulary.
 *
 * Takes the diagnostic code as an argument because the *same* combinator backs
 * entity types, lifecycle states, relation types and source kinds, and each has
 * its own code so a consumer can tell which vocabulary was violated.
 */
export function validateEnum<T extends string>(
  allowed: readonly T[],
  code: WikiDiagnosticCode,
  label: string,
): Validator<T> {
  const set = new Set<string>(allowed);
  return (value, context) => {
    if (typeof value !== "string" || !set.has(value)) {
      return reject(
        context,
        code,
        `Expected a ${label} (one of ${allowed.join(", ")}), got ${describe(value)}.`,
      );
    }
    return succeed(value as T);
  };
}

/**
 * Every element of an array, validated independently.
 *
 * Collects diagnostics from *all* elements rather than stopping at the first
 * bad one — the point of the whole library. A failing element drops out of the
 * result while the rest survive, so a caller can still index the good entities
 * in a file that has one broken relation.
 */
export function validateArray<T>(element: Validator<T>): Validator<T[]> {
  return (value, context) => {
    if (!Array.isArray(value)) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected an array, got ${describe(value)}.`);
    }
    const diagnostics: WikiDiagnostic[] = [];
    const values: T[] = [];
    let ok = true;
    for (let index = 0; index < value.length; index += 1) {
      const result = element(value[index], indexContext(context, index));
      diagnostics.push(...result.diagnostics);
      if (result.ok) values.push(result.value);
      else ok = false;
    }
    return ok ? succeed(values, diagnostics) : { ok: false, diagnostics };
  };
}

/**
 * An optional field: `undefined` and absent both pass, anything else is validated.
 *
 * `null` is rejected rather than treated as absent. YAML distinguishes a key
 * that is missing from one explicitly set to `null`, and the second is nearly
 * always a mistake worth reporting.
 */
export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, context) => {
    if (value === undefined) return succeed(undefined);
    return inner(value, context);
  };
}

/** Apply an extra predicate after an inner validator succeeds. */
export function refine<T>(
  inner: Validator<T>,
  check: (value: T, context: ValidationContext) => WikiDiagnostic[],
): Validator<T> {
  return (value, context) => {
    const result = inner(value, context);
    if (!result.ok) return result;
    const extra = check(result.value, context);
    const diagnostics = [...result.diagnostics, ...extra];
    return extra.some((entry) => entry.severity === "error")
      ? { ok: false, diagnostics }
      : succeed(result.value, diagnostics);
  };
}

// -- Object shapes -----------------------------------------------------------

export type ShapeOf<T> = { [K in keyof T]-?: Validator<T[K]> };

/**
 * Validate an object against a per-field validator map.
 *
 * Every field is attempted even after one fails, so one call reports every
 * problem in the object. Fields whose validator returned `undefined` are
 * omitted from the result rather than set to `undefined`, which keeps
 * round-tripped YAML free of explicit nulls.
 */
export function validateShape<T extends object>(shape: ShapeOf<T>): Validator<T> {
  return (value, context) => {
    if (!isPlainObject(value)) {
      return reject(context, "INVALID_FIELD_TYPE", `Expected an object, got ${describe(value)}.`);
    }
    const diagnostics: WikiDiagnostic[] = [];
    const result: Record<string, unknown> = {};
    let ok = true;
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      const fieldResult = shape[key](value[key], childContext(context, key));
      diagnostics.push(...fieldResult.diagnostics);
      if (!fieldResult.ok) {
        ok = false;
        continue;
      }
      if (fieldResult.value !== undefined) result[key] = fieldResult.value;
    }
    return ok ? succeed(result as T, diagnostics) : { ok: false, diagnostics };
  };
}

/** Run a validator over a root value with no enclosing file or entity. */
export function validate<T>(
  validator: Validator<T>,
  value: unknown,
  context: ValidationContext = rootContext(),
): ValidationResult<T> {
  return validator(value, context);
}

/** Collect diagnostics from several results, preserving order. */
export function collectDiagnostics(...results: readonly ValidationResult<unknown>[]): WikiDiagnostic[] {
  return results.flatMap((result) => result.diagnostics);
}
