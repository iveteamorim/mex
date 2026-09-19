import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { DriftIssue, ScaffoldFrontmatter } from "../../types.js";

/** Check that all YAML frontmatter edge targets exist */
export function checkEdges(
  frontmatter: ScaffoldFrontmatter | null,
  filePath: string,
  source: string,
  projectRoot: string,
  scaffoldRoot: string
): DriftIssue[] {
  if (!frontmatter?.edges) return [];

  const issues: DriftIssue[] = [];

  for (const edge of frontmatter.edges) {
    if (!edge.target) continue;

    // Try the declaring file's own directory first, then scaffold root, then
    // project root. Only ROUTER.md sits at the scaffold root, so resolving
    // from the roots alone made every relative edge written from a pattern
    // file -- `../context/architecture.md`, or a sibling pattern -- look dead
    // while the target was right there. Markdown links in the same scaffold
    // already resolve this way.
    const fromFile = resolve(dirname(filePath), edge.target);
    const fromScaffold = resolve(scaffoldRoot, edge.target);
    const fromProject = resolve(projectRoot, edge.target);
    if (!existsSync(fromFile) && !existsSync(fromScaffold) && !existsSync(fromProject)) {
      issues.push({
        code: "DEAD_EDGE",
        severity: "error",
        file: source,
        line: null,
        message: `Frontmatter edge target does not exist: ${edge.target}`,
      });
    }
  }

  return issues;
}
