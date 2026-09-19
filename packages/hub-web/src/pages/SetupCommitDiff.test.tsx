import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SetupCommitDiff } from "./SetupCommitDiff";
import { parseSetupDiff } from "./setup-commit-diff";

const diff = "diff --git a/x b/x\nindex abcd123..def4567 100644\n--- a/x\n+++ b/x\n@@ -8,2 +8,2 @@\n context\n-old\n+\t<img src=x onerror=alert(1)> &  \n\\ No newline at end of file\n";

describe("setup diff rendering", () => {
  it("renders escaped source with line-number gutters, explicit change markers, and no Git metadata", () => {
    const { container } = render(<SetupCommitDiff path="x" diff={diff} parsed={parseSetupDiff(diff)} expanded />);
    const region = screen.getByRole("region", { name: "Diff for x" });
    expect(within(region).getByRole("columnheader", { name: "Old line" })).toBeInTheDocument();
    expect(within(region).getByRole("cell", { name: "Added" })).toHaveTextContent("+");
    expect(within(region).getByRole("cell", { name: "Removed" })).toHaveTextContent("−");
    const addition = container.querySelector('[data-diff-kind="addition"]')!;
    expect(addition.querySelector('[data-line-side="old"]')).toBeEmptyDOMElement();
    expect(addition.querySelector('[data-line-side="new"]')).toHaveTextContent("9");
    expect(addition.querySelector("[data-diff-content]")?.textContent).toBe("\t<img src=x onerror=alert(1)> &  ");
    expect(container.querySelector("img")).toBeNull();
    expect(region.textContent).not.toMatch(/diff --git|index abcd|--- a\/x|\+\+\+ b\/x/u);
    expect(within(region).getByText("No newline at end of file")).toBeInTheDocument();
  });

  it("mounts no source rows inside a closed file and releases them again when closed", () => {
    const parsed = parseSetupDiff(diff);
    const { container, rerender } = render(<SetupCommitDiff path="x" diff={diff} parsed={parsed} expanded={false} />);
    expect(screen.getByRole("region", { name: "Diff for x" })).toBeEmptyDOMElement();
    rerender(<SetupCommitDiff path="x" diff={diff} parsed={parsed} expanded />);
    expect(container.querySelectorAll("[data-diff-kind]")).toHaveLength(5);
    rerender(<SetupCommitDiff path="x" diff={diff} parsed={parsed} expanded={false} />);
    expect(container.querySelectorAll("[data-diff-kind]")).toHaveLength(0);
  });

  it("explains mode-only changes while preserving exact permission values", () => {
    const raw = "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n";
    render(<SetupCommitDiff path="x" diff={raw} parsed={parseSetupDiff(raw)} expanded />);
    expect(screen.getByText("Previous file permissions: 100644")).toBeVisible();
    expect(screen.getByText("File permissions changed to 100755 (executable)")).toBeVisible();
  });

  it.each([false, true])("shows the exact escaped raw data on malformed/truncated fallback (%s)", (truncated) => {
    const raw = "diff --git a/x b/x\n+<script>bad()</script>\n\t trailing  \n";
    const { container } = render(<SetupCommitDiff path="x" diff={raw} parsed={parseSetupDiff(raw, truncated)} expanded />);
    expect(container.querySelector("pre")?.textContent).toBe(raw);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getByText(truncated ? /This diff was shortened/ : /could not be formatted safely/)).toBeVisible();
  });

  it("keeps all pathological diff content in one raw text node", () => {
    const raw = "@@ -0,0 +1,16000 @@\n" + "+\n".repeat(16_000);
    const { container } = render(<SetupCommitDiff path="x" diff={raw} parsed={parseSetupDiff(raw)} expanded />);
    expect(container.querySelector("pre")?.textContent).toBe(raw);
    expect(container.querySelectorAll("[data-diff-kind]")).toHaveLength(0);
    expect(screen.getByText(/complete raw diff to keep this review responsive/)).toBeVisible();
  });
});
