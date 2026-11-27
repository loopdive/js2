// #7558 — scripts/hooks/changed-root-tests.sh is the one selector for "the root
// test files this change adds or modifies": pre-push runs it, and so does the
// merge queue's `quality` job, where it is the only gate for forks.
//
// Two properties the queue depends on:
//   * the base is the merge-base with main, not the commit's first parent — in
//     a merge group the PRs ahead of this one are not on main yet, and their own
//     queue runs are cancelled when the group merges first, so a first-parent
//     diff would let their changed tests merge unrun;
//   * every way of failing to compute the selection exits non-zero.
//
// Driven against a throwaway git repo with a stub `pnpm` on PATH.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SELECTOR = join(REPO_ROOT, "scripts", "hooks", "changed-root-tests.sh");

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Drop hook-context git variables and any inherited selector base.
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "CHANGED_ROOT_TESTS_BASE",
  ])
    delete env[k];
  return { ...env, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8", env: childEnv() },
  ).trim();
}

function commitFile(repo: string, path: string, message: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), `// ${message}\n`);
  git(repo, "add", path);
  git(repo, "commit", "-q", "-m", message);
}

function select(repo: string, args: string[], extra: Record<string, string> = {}) {
  try {
    const out = execFileSync("/bin/sh", ["scripts/hooks/changed-root-tests.sh", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: childEnv(extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: out, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? -1, stdout: `${e.stdout ?? ""}`, stderr: `${e.stderr ?? ""}` };
  }
}

describe("#7558 changed-root-tests selector", () => {
  let dir: string;
  let repo: string;
  let bin: string;
  let calls: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "changed-root-7558-"));
    repo = join(dir, "repo");
    bin = join(dir, "bin");
    calls = join(dir, "pnpm-calls");
    mkdirSync(join(repo, "scripts", "hooks"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit "\${PNPM_RC:-0}"\n`);
    chmodSync(join(bin, "pnpm"), 0o755);

    git(repo, "init", "-q", "-b", "main");
    copyFileSync(SELECTOR, join(repo, "scripts", "hooks", "changed-root-tests.sh"));
    git(repo, "add", "scripts");
    commitFile(repo, "tests/old.test.ts", "main");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    // A merge group of two PRs: neither is on main yet.
    git(repo, "checkout", "-q", "-b", "queue");
    commitFile(repo, "tests/issue-1.test.ts", "first PR in the group");
    commitFile(repo, "tests/issue-2.test.ts", "second PR in the group");
    commitFile(repo, "tests/linear-x.test.ts", "excluded family");
    commitFile(repo, "tests/ir/nested.test.ts", "not a root file");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("selects everything between main and HEAD, including PRs queued ahead", () => {
    const r = select(repo, ["--list"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["tests/issue-1.test.ts", "tests/issue-2.test.ts"]);
  });

  it("a first-parent base would miss the earlier PR (why the default is the merge-base)", () => {
    const r = select(repo, ["--list"], { CHANGED_ROOT_TESTS_BASE: "HEAD~3" });
    expect(r.stdout.trim().split("\n")).toEqual(["tests/issue-2.test.ts"]);
  });

  it("fails closed when the main ref cannot be resolved", () => {
    const r = select(repo, ["--list"], { CHANGED_ROOT_TESTS_BASE: "refs/remotes/nowhere/main" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot resolve a merge base");
  });

  it("runs each selected file alone and fails on the first red one", () => {
    writeFileSync(calls, "");
    const path = `${bin}:${process.env.PATH}`;
    expect(select(repo, [], { PATH: path }).status).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      expect.stringMatching(/^exec vitest run tests\/issue-1\.test\.ts /),
      expect.stringMatching(/^exec vitest run tests\/issue-2\.test\.ts /),
    ]);
    writeFileSync(calls, "");
    const red = select(repo, [], { PATH: path, PNPM_RC: "1" });
    expect(red.status).toBe(1);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("selects a renamed file under its new path and keeps a name with spaces whole", () => {
    git(repo, "checkout", "-q", "-b", "rename", "main");
    try {
      git(repo, "mv", "tests/old.test.ts", "tests/renamed.test.ts");
      git(repo, "commit", "-q", "-m", "rename");
      commitFile(repo, "tests/with space.test.ts", "a name with a space");
      expect(select(repo, ["--list"]).stdout.trim().split("\n")).toEqual([
        "tests/renamed.test.ts",
        "tests/with space.test.ts",
      ]);
      writeFileSync(calls, "");
      expect(select(repo, [], { PATH: `${bin}:${process.env.PATH}` }).status).toBe(0);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        expect.stringMatching(/^exec vitest run tests\/renamed\.test\.ts /),
        expect.stringMatching(/^exec vitest run tests\/with space\.test\.ts /),
      ]);
    } finally {
      git(repo, "checkout", "-q", "queue");
    }
  });

  it("--run-list runs exactly the given selection without recomputing it", () => {
    const list = join(dir, "selection.txt");
    writeFileSync(list, "tests/issue-2.test.ts\n");
    writeFileSync(calls, "");
    // An unresolvable base proves no selection is recomputed.
    const r = select(repo, ["--run-list", list], {
      PATH: `${bin}:${process.env.PATH}`,
      CHANGED_ROOT_TESTS_BASE: "refs/remotes/nowhere/main",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      expect.stringMatching(/^exec vitest run tests\/issue-2\.test\.ts /),
    ]);
    expect(select(repo, ["--run-list", join(dir, "missing.txt")]).status).toBe(1);
  });

  it("prints nothing and exits 0 when no root test changed", () => {
    const r = select(repo, ["--list"], { CHANGED_ROOT_TESTS_BASE: "HEAD" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
