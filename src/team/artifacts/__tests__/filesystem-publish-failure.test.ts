import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberArtifactPath, serializeMemberArtifact } from "../codecs.js";
import {
  atomicCreateArtifact,
  atomicReplaceArtifact,
} from "../filesystem.js";
import { revisionOf } from "../revision.js";
import { generateArtifactId } from "../ulid.js";

const publicationFault = vi.hoisted(() => ({ enabled: false }));
const stagingEdit = vi.hoisted(() => ({ target: "", stagedPath: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      const descriptor = actual.openSync(...args);
      if (stagingEdit.target !== "" && String(args[0]).includes(".mex-tmp-")) {
        stagingEdit.stagedPath = String(args[0]);
      }
      return descriptor;
    },
    fsyncSync(descriptor: number) {
      actual.fsyncSync(descriptor);
      if (stagingEdit.target !== "" && stagingEdit.stagedPath !== "") {
        // The replacement has been fully staged; an external editor changes the live file.
        const target = stagingEdit.target;
        stagingEdit.target = "";
        actual.writeFileSync(target, actual.readFileSync(target, "utf8").replaceAll("\n", "\r\n"));
      }
    },
    renameSync(source: Parameters<typeof actual.renameSync>[0], target: Parameters<typeof actual.renameSync>[1]) {
      if (publicationFault.enabled && String(source).includes(".mex-tmp-")) {
        throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
      }
      return actual.renameSync(source, target);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  publicationFault.enabled = false;
  stagingEdit.target = "";
  stagingEdit.stagedPath = "";
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contained artifact publication failure", () => {
  it("rechecks exact revisions after staging and preserves a concurrent CRLF edit", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-artifact-staging-edit-"));
    roots.push(root);
    const path = ".mex/local/agent-preferences.json";
    const absolutePath = join(root, path);
    const before = '{"schemaVersion":1,"mode":"manual"}\n';
    atomicCreateArtifact(root, path, before);
    stagingEdit.target = absolutePath;
    expect(() => atomicReplaceArtifact(root, path, revisionOf(before), "replacement\n", 1024, "exact"))
      .toThrowError(expect.objectContaining({ problem: expect.objectContaining({ code: "REVISION_CONFLICT" }) }));
    expect(stagingEdit.stagedPath).toContain(".mex-tmp-");
    expect(readFileSync(absolutePath, "utf8")).toBe(before.replaceAll("\n", "\r\n"));
    expect(readdirSync(dirname(absolutePath))).toEqual(["agent-preferences.json"]);
  });

  it("preserves canonical bytes and removes staged and lock files when replacement fails", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-artifact-publish-failure-"));
    roots.push(root);
    const id = generateArtifactId("member", {
      now: Date.UTC(2026, 7, 23),
      random: new Uint8Array(10).fill(7),
    });
    const path = memberArtifactPath(id);
    const absolutePath = join(root, ...path.split("/"));
    const before = serializeMemberArtifact({
      id,
      displayName: "Before Publish",
      gitAliases: [],
      active: true,
    });
    const after = serializeMemberArtifact({
      id,
      displayName: "After Publish",
      gitAliases: [],
      active: true,
    });
    atomicCreateArtifact(root, path, before);

    publicationFault.enabled = true;
    expect(() => atomicReplaceArtifact(root, path, revisionOf(before), after, 64 * 1024))
      .toThrow(/injected publication failure/);
    publicationFault.enabled = false;

    expect(readFileSync(absolutePath, "utf8")).toBe(before);
    expect(readdirSync(dirname(absolutePath))).toEqual([`${id}.md`]);
  });
});
