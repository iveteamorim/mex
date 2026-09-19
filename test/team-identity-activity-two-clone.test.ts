import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamIdentityActivityFoundation } from "../src/team/foundation.js";

const roots: string[] = [];
const NOW = new Date("2026-08-23T04:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Lane C two-clone convergence", () => {
  it("merges independent member and event files without a same-file conflict", async () => {
    const workspace = temporaryRoot();
    const remote = join(workspace, "remote.git");
    const seed = join(workspace, "seed");
    const cloneA = join(workspace, "clone-a");
    const cloneB = join(workspace, "clone-b");
    git(workspace, "init", "--bare", remote);
    git(workspace, "init", "-b", "main", seed);
    configureGit(seed, "Seed", "seed@example.test");
    writeFileSync(join(seed, "README.md"), "# fixture\n", "utf8");
    writeFileSync(
      join(seed, ".gitignore"),
      readFileSync(join(process.cwd(), ".gitignore"), "utf8"),
      "utf8",
    );
    git(seed, "add", "README.md", ".gitignore");
    git(seed, "commit", "-m", "fixture: seed repository");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    git(workspace, "clone", remote, cloneA);
    git(workspace, "clone", remote, cloneB);
    configureGit(cloneA, "Alice", "alice@example.test");
    configureGit(cloneB, "Bob", "bob@example.test");

    const headBefore = gitText(cloneA, "rev-parse", "HEAD");
    await createCloneArtifacts(
      cloneA,
      "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "event_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      "Alice",
      "alice@example.test",
    );
    await createCloneArtifacts(
      cloneB,
      "member_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "event_01ARZ3NDEKTSV4RRFFQ69G5FAC",
      "Bob",
      "bob@example.test",
    );

    // Production Lane C writes files only; the test harness owns Git publication.
    expect(gitStatus(cloneA, "diff", "--cached", "--quiet")).toBe(0);
    expect(gitText(cloneA, "rev-parse", "HEAD")).toBe(headBefore);
    expect(gitText(cloneA, "status", "--porcelain")).toContain(".mex/");
    expect(gitStatus(cloneA, "check-ignore", "-q", ".mex/local/team.db")).toBe(0);
    expect(gitText(cloneA, "status", "--porcelain", "--", ".mex/local")).toBe("");

    git(cloneA, "add", ".mex/team", ".mex/events/activity");
    git(cloneA, "commit", "-m", "test: add Alice activity");
    git(cloneA, "push", "origin", "main");

    git(cloneB, "add", ".mex/team", ".mex/events/activity");
    git(cloneB, "commit", "-m", "test: add Bob activity");
    git(cloneB, "fetch", "origin");
    git(cloneB, "merge", "--no-edit", "origin/main");
    git(cloneB, "push", "origin", "main");
    git(cloneA, "pull", "--ff-only", "origin", "main");

    const timelineA = createReadFoundation(cloneA).timeline.list();
    const timelineB = createReadFoundation(cloneB).timeline.list();
    expect(timelineA.diagnostics).toEqual([]);
    expect(timelineB.diagnostics).toEqual([]);
    expect(timelineA.items.map((item) => item.id)).toEqual([
      "event_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      "event_01ARZ3NDEKTSV4RRFFQ69G5FAC",
    ]);
    expect(timelineB.items).toEqual(timelineA.items);
    expect(timelineB.deterministicRevision).toBe(timelineA.deterministicRevision);
  }, 30_000);
});

async function createCloneArtifacts(
  root: string,
  memberId: string,
  eventId: string,
  name: string,
  email: string,
): Promise<void> {
  const foundation = new TeamIdentityActivityFoundation({
    projectRoot: root,
    scaffoldId: `scaffold-${name.toLowerCase()}`,
    now: () => new Date(NOW),
    memberRepository: { idFactory: () => memberId },
    activityIdFactory: () => eventId,
  });
  await foundation.members.create({
    displayName: name,
    gitAliases: [{ name, email }],
  });
  foundation.localState.configureMember({ memberId, expectedRevision: null });
  const preview = await foundation.previewActivity({
    action: "member.registered",
    subjects: [{ kind: "entity", entity: { id: memberId, kind: "member", title: name } }],
  });
  expect(preview.actorResolution.actor).toMatchObject({ kind: "member", memberId });
  await foundation.applyActivity(preview, preview.activity.previewRevision);
}

function createReadFoundation(root: string): TeamIdentityActivityFoundation {
  return new TeamIdentityActivityFoundation({
    projectRoot: root,
    scaffoldId: "scaffold-reader",
    now: () => new Date(NOW),
  });
}

function configureGit(root: string, name: string, email: string): void {
  git(root, "config", "user.name", name);
  git(root, "config", "user.email", email);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: "pipe",
  });
}

function gitText(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
  }).trim();
}

function gitStatus(cwd: string, ...args: string[]): number {
  try {
    git(cwd, ...args);
    return 0;
  } catch (error) {
    return typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : -1;
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-two-clone-"));
  roots.push(root);
  return root;
}
