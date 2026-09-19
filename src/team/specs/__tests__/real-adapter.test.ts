import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryWikiPort } from "../../../wiki/application-adapter.js";
import { createSpecReadService } from "../service.js";

const SPEC = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const REQUIREMENT = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const CRITERION = "mx_01KRWG9F3TMHZ2PB6XKV7Q4YE8";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may retain a just-closed immutable SQLite descriptor briefly.
    }
  }
});

describe("Spec service over the repository Wiki adapter", () => {
  it("projects a real indexed hierarchy without changing canonical or disposable files", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-spec-reader-real-"));
    roots.push(root);
    const specs = join(root, ".mex", "specs");
    mkdirSync(specs, { recursive: true });
    writeFileSync(join(specs, "token-rotation.md"), `<!-- mex:entity
id: ${SPEC}
type: spec
status: promoted
revision: 1
title: Token rotation
sources:
  - type: manual
    note: Reviewed by the security team
-->
## Token rotation

Refresh tokens must not live forever.

<!-- mex:entity
id: ${REQUIREMENT}
type: requirement
status: promoted
revision: 1
title: Rotate within the hour
relations:
  - type: derived_from
    target: ${SPEC}
-->
### Rotate within the hour

A refresh token is rotated at most one hour after issue.

<!-- mex:entity
id: ${CRITERION}
type: acceptance_criterion
status: promoted
revision: 1
title: An expired token is refused
relations:
  - type: verified_by
    target: ${REQUIREMENT}
-->
### An expired token is refused

Presenting an expired refresh token returns 401.
`, "utf8");

    const wiki = createRepositoryWikiPort(root);
    await expect(wiki.rebuildIndex()).resolves.toMatchObject({ entitiesIndexed: 3 });
    const before = snapshot(root);
    const service = createSpecReadService(wiki);

    const list = await service.list();
    expect(list.availability).toBe("ready");
    if (list.availability !== "ready") throw new Error("expected ready list");
    expect(list.page.items.map((entry) => entry.id)).toEqual([SPEC]);

    const show = await service.show(SPEC);
    expect(show.availability).toBe("ready");
    if (show.availability !== "ready") throw new Error("expected ready detail");
    expect(show.detail.body).toContain("must not live forever");
    expect(show.detail.sources).toEqual([{
      type: "manual",
      note: "Reviewed by the security team",
    }]);
    expect(show.detail.hierarchy.requirements.map((entry) => entry.id)).toEqual([REQUIREMENT]);
    expect(show.detail.hierarchy.acceptanceCriteria.map((entry) => entry.id)).toEqual([CRITERION]);
    expect(show.detail.hierarchy.relations).toHaveLength(2);
    expect(snapshot(root)).toEqual(before);
  });
});

function snapshot(root: string): Readonly<Record<string, string>> {
  const files: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).isFile()) {
        files.push([relative(root, path).replaceAll("\\", "/"), readFileSync(path).toString("base64")]);
      }
    }
  };
  visit(root);
  files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.fromEntries(files);
}
