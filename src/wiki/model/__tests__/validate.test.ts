import { describe, it, expect } from "vitest";
import {
  childContext,
  collectDiagnostics,
  describe as describeValue,
  indexContext,
  isNonEmptyString,
  isPlainObject,
  optional,
  refine,
  reject,
  rootContext,
  succeed,
  validateArray,
  validateEnum,
  validateInteger,
  validateShape,
  validateString,
  type Validator,
} from "../validate.js";
import { contextDiagnostic } from "../validate.js";

function codes(result: { diagnostics: readonly { code: string }[] }): string[] {
  return result.diagnostics.map((entry) => entry.code);
}

describe("context paths", () => {
  it("builds a readable path into nested structures", () => {
    const context = indexContext(childContext(indexContext(childContext(rootContext(), "entities"), 3), "relations"), 1);
    expect(context.path).toBe("entities[3].relations[1]");
  });

  it("does not prefix a leading dot at the root", () => {
    expect(childContext(rootContext(), "title").path).toBe("title");
  });

  it("carries file and entity through descent", () => {
    const context = childContext({ path: "", file: "a.md", entityId: "mx_1" }, "title");
    expect(context.file).toBe("a.md");
    expect(context.entityId).toBe("mx_1");
  });

  it("omits an empty path from the diagnostic rather than emitting one", () => {
    expect(contextDiagnostic(rootContext(), "WIKI_PARSE_ERROR", "x").path).toBeUndefined();
    expect(contextDiagnostic({ path: "title" }, "WIKI_PARSE_ERROR", "x").path).toBe("title");
  });
});

describe("validators do not throw", () => {
  it("returns diagnostics for input of any shape", () => {
    // The whole contract: a malformed file reports, it does not abort.
    for (const input of [undefined, null, 0, "", [], {}, Symbol.iterator, () => {}, new Date()]) {
      expect(() => validateShape({ a: validateString() })(input, rootContext())).not.toThrow();
    }
  });
});

describe("validateString", () => {
  it("accepts a non-empty string and rejects an empty one", () => {
    expect(validateString()("hello", rootContext()).ok).toBe(true);
    expect(codes(validateString()("   ", rootContext()))).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(codes(validateString()(42, rootContext()))).toEqual(["INVALID_FIELD_TYPE"]);
  });

  it("allows an empty string when asked", () => {
    expect(validateString({ allowEmpty: true })("", rootContext()).ok).toBe(true);
  });
});

describe("validateInteger", () => {
  it("accepts integers and rejects everything else", () => {
    expect(validateInteger()(3, rootContext()).ok).toBe(true);
    expect(validateInteger()(3.5, rootContext()).ok).toBe(false);
    expect(validateInteger()("3", rootContext()).ok).toBe(false);
    expect(validateInteger()(Number.NaN, rootContext()).ok).toBe(false);
  });

  it("enforces bounds", () => {
    expect(validateInteger({ min: 1 })(0, rootContext()).ok).toBe(false);
    expect(validateInteger({ max: 6 })(7, rootContext()).ok).toBe(false);
    expect(validateInteger({ min: 1, max: 6 })(3, rootContext()).ok).toBe(true);
  });
});

describe("validateEnum", () => {
  it("carries the caller's code so consumers can tell which vocabulary broke", () => {
    const validator = validateEnum(["a", "b"] as const, "INVALID_RELATION_TYPE", "relation type");
    expect(validator("a", rootContext()).ok).toBe(true);
    expect(codes(validator("c", rootContext()))).toEqual(["INVALID_RELATION_TYPE"]);
  });

  it("names the allowed values in the message", () => {
    const validator = validateEnum(["a", "b"] as const, "INVALID_ENTITY_TYPE", "entity type");
    const result = validator("c", rootContext());
    expect(result.diagnostics[0]!.message).toContain("a, b");
  });
});

describe("validateArray", () => {
  const validator = validateArray(validateString());

  it("collects diagnostics from every bad element, not just the first", () => {
    // The reason this library exists: a user who has to re-run to see the
    // second problem gives up.
    const result = validator(["ok", 1, "fine", 2], rootContext());
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map((entry) => entry.path)).toEqual(["[1]", "[3]"]);
  });

  it("keeps the good elements alongside the diagnostics", () => {
    const result = validateArray(optional(validateString()))(["a", "b"], rootContext());
    expect(result.ok && result.value).toEqual(["a", "b"]);
  });

  it("rejects a non-array", () => {
    expect(codes(validator("not an array", rootContext()))).toEqual(["INVALID_FIELD_TYPE"]);
  });

  it("accepts an empty array", () => {
    expect(validator([], rootContext()).ok).toBe(true);
  });
});

describe("optional", () => {
  it("passes undefined through", () => {
    expect(optional(validateString())(undefined, rootContext())).toEqual({ ok: true, value: undefined, diagnostics: [] });
  });

  it("rejects null rather than treating it as absent", () => {
    // YAML distinguishes a missing key from one explicitly set to null, and the
    // second is nearly always a mistake worth reporting.
    expect(optional(validateString())(null, rootContext()).ok).toBe(false);
  });

  it("validates a present value", () => {
    expect(optional(validateString())(42, rootContext()).ok).toBe(false);
  });
});

describe("validateShape", () => {
  interface Sample {
    title: string;
    count?: number;
  }
  const validator = validateShape<Sample>({ title: validateString(), count: optional(validateInteger()) });

  it("narrows the type on success", () => {
    const result = validator({ title: "x", count: 2 }, rootContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const title: string = result.value.title;
      expect(title).toBe("x");
    }
  });

  it("reports every bad field in one pass", () => {
    const result = validator({ title: 1, count: "two" }, rootContext());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.path).sort()).toEqual(["count", "title"]);
  });

  it("omits absent optional fields rather than setting them to undefined", () => {
    // Keeps round-tripped YAML free of explicit nulls.
    const result = validator({ title: "x" }, rootContext());
    expect(result.ok && Object.hasOwn(result.value, "count")).toBe(false);
  });

  it("rejects a non-object, including an array", () => {
    expect(codes(validator([], rootContext()))).toEqual(["INVALID_FIELD_TYPE"]);
    expect(codes(validator(null, rootContext()))).toEqual(["INVALID_FIELD_TYPE"]);
  });

  it("ignores keys not in the shape", () => {
    const result = validator({ title: "x", extra: true }, rootContext());
    expect(result.ok && Object.hasOwn(result.value, "extra")).toBe(false);
  });
});

describe("refine", () => {
  const evenOnly: Validator<number> = refine(validateInteger(), (value, context) =>
    value % 2 === 0 ? [] : [contextDiagnostic(context, "INVALID_FIELD_TYPE", "Expected an even number.")],
  );

  it("applies the extra check after the inner validator", () => {
    expect(evenOnly(4, rootContext()).ok).toBe(true);
    expect(evenOnly(3, rootContext()).ok).toBe(false);
  });

  it("does not run when the inner validator already failed", () => {
    expect(codes(evenOnly("four", rootContext()))).toEqual(["INVALID_FIELD_TYPE"]);
  });

  it("keeps a non-error refinement as an advisory on a successful result", () => {
    const advisory: Validator<number> = refine(validateInteger(), (value, context) =>
      value > 100 ? [contextDiagnostic(context, "ORPHANED_ENTITY", "large", { severity: "info" })] : [],
    );
    const result = advisory(200, rootContext());
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(["ORPHANED_ENTITY"]);
  });
});

describe("helpers", () => {
  it("recognizes plain objects but not arrays or null", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it("recognizes non-empty strings", () => {
    expect(isNonEmptyString("a")).toBe(true);
    expect(isNonEmptyString("  ")).toBe(false);
    expect(isNonEmptyString(1)).toBe(false);
  });

  it("describes a value without dumping it", () => {
    expect(describeValue(null)).toBe("null");
    expect(describeValue([])).toBe("an array");
    expect(describeValue(undefined)).toBe("missing");
    expect(describeValue("x".repeat(200))).toContain("…");
  });

  it("collects diagnostics from several results", () => {
    const bad = reject(rootContext(), "WIKI_PARSE_ERROR", "x");
    expect(collectDiagnostics(succeed(1), bad, bad)).toHaveLength(2);
  });
});
