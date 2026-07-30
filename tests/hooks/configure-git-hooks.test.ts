import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const INSTALLER = join(REPO_ROOT, "scripts", "configure-git-hooks.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("worktree-local Git hook installation", () => {
  let fixtureRoot: string;
  let linkedWorktree: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "js2-hooks-"));
    linkedWorktree = join(fixtureRoot, "linked");
    git(fixtureRoot, "init");
    mkdirSync(join(fixtureRoot, ".husky"));
    writeFileSync(join(fixtureRoot, ".husky", "pre-push"), "#!/bin/sh\n");
    writeFileSync(join(fixtureRoot, "tracked"), "fixture\n");
    git(fixtureRoot, "add", ".");
    git(fixtureRoot, "-c", "user.name=Hook Test", "-c", "user.email=hooks@example.invalid", "commit", "-m", "fixture");
    git(fixtureRoot, "config", "core.hooksPath", "/workspace/.husky");
    git(fixtureRoot, "worktree", "add", "-b", "linked-fixture", linkedWorktree);
  });

  afterAll(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("replaces a stale shared absolute path only in the linked worktree", () => {
    execFileSync("/bin/sh", [INSTALLER, linkedWorktree]);

    expect(git(linkedWorktree, "config", "--get", "core.hooksPath")).toBe(".husky");
    expect(git(fixtureRoot, "config", "--get", "core.hooksPath")).toBe("/workspace/.husky");
  });

  it("also installs the relative hook path in the main worktree", () => {
    execFileSync("/bin/sh", [INSTALLER, fixtureRoot]);

    expect(git(fixtureRoot, "config", "--get", "core.hooksPath")).toBe(".husky");
  });
});
