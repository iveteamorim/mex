import { describe, expect, it } from "vitest";
import {
  appendBounded,
  appendBoundedUnique,
  boundedNextCursor,
  MAX_ACCUMULATED_WORKBENCH_ITEMS,
  MAX_OBSERVED_TERMINAL_JOB_IDS,
  MAX_WORKBENCH_PAGES,
  rememberBoundedId,
} from "./bounds";

describe("Hub workbench bounds", () => {
  it("caps accumulated rows while retaining root-page order", () => {
    const current = Array.from({ length: MAX_ACCUMULATED_WORKBENCH_ITEMS - 1 }, (_, index) => index);
    const result = appendBounded(current, [199, 200, 201]);

    expect(result.items).toHaveLength(MAX_ACCUMULATED_WORKBENCH_ITEMS);
    expect(result.items.at(-1)).toBe(199);
    expect(result.omitted).toBe(true);
  });

  it("deduplicates rows before enforcing the hard item cap", () => {
    const current = Array.from({ length: MAX_ACCUMULATED_WORKBENCH_ITEMS }, (_, index) => ({ id: String(index) }));
    const result = appendBoundedUnique(current, [{ id: "1" }, { id: "new" }], (item) => item.id);

    expect(result.items).toHaveLength(MAX_ACCUMULATED_WORKBENCH_ITEMS);
    expect(result.items.some((item) => item.id === "new")).toBe(false);
    expect(result.omitted).toBe(true);
  });

  it("stops exposing a next cursor at the retained-page bound", () => {
    expect(boundedNextCursor("next", MAX_WORKBENCH_PAGES - 1)).toBe("next");
    expect(boundedNextCursor("next", MAX_WORKBENCH_PAGES)).toBeUndefined();
  });

  it("retains only the newest terminal job IDs", () => {
    const ids = new Set<string>();
    for (let index = 0; index < MAX_OBSERVED_TERMINAL_JOB_IDS + 3; index += 1) {
      rememberBoundedId(ids, `job-${index}`);
    }

    expect(ids.size).toBe(MAX_OBSERVED_TERMINAL_JOB_IDS);
    expect(ids.has("job-0")).toBe(false);
    expect(ids.has(`job-${MAX_OBSERVED_TERMINAL_JOB_IDS + 2}`)).toBe(true);
  });
});
