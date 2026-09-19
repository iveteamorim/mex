import { describe, expect, it, vi } from "vitest";
import { SetupProgressSchema, SetupRunSchema } from "./setup.js";

// Shared limits must not evaluate the full Hub schema barrel a second time
// when the production setup entry is loaded.
vi.mock("./index.js", () => {
  throw new Error("Setup must depend on leaf contracts, not the Hub barrel.");
});

describe("setup contract dependency boundary", () => {
  it("loads the standalone setup schemas", () => {
    expect(SetupProgressSchema.safeParse({ step: "detect", label: "Detect", detail: "x".repeat(1_024) }).success).toBe(true);
    expect(SetupProgressSchema.safeParse({ step: "detect", label: "Detect", detail: "x".repeat(1_025) }).success).toBe(false);
    expect(SetupRunSchema).toBeDefined();
  });
});
