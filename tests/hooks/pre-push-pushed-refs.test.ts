// #7558 — section (6) of .husky/pre-push judges the refs being PUSHED (the
// stdin ref list), not whatever happens to be checked out: deletes and tags
// skip it, a pushed branch that is not HEAD or a dirty tree is refused, a
// missing main ref fails closed, and the changed root tests run under a bound.
//
// Runs the real hook in a throwaway repo. A stub `pnpm` on PATH answers every
// earlier gate with success and records its calls; the repo has no
// package.json, so the package-script-guarded sections stay quiet.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const NULL_OID = "0000000000000000000000000000000000000000";

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) delete env[k];
  return { ...env, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8", env: childEnv() },
  ).trim();
}

describe("#7558 pre-push section (6) reads the pushed refs", () => {
  let dir: string;
  let repo: string;
  let calls: string;
  let path: string;
  let head: string;
  let other: string;

  const push = (refs: string[]) => {
    try {
      const out = execFileSync("/bin/sh", [".husky/pre-push", "origin", "https://github.com/loopdive/js2"], {
        cwd: repo,
        input: refs.join("\n") + "\n",
        encoding: "utf8",
        env: childEnv({ PATH: path }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, output: out };
    } catch (e: any) {
      return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const ranRootTests = () => readFileSync(calls, "utf8").includes("run -s test:changed-root");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pre-push-7558-"));
    repo = join(dir, "repo");
    const bin = join(dir, "bin");
    calls = join(dir, "pnpm-calls");
    mkdirSync(join(repo, ".husky"), { recursive: true });
    mkdirSync(join(repo, "scripts", "hooks"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 0\n`);
    chmodSync(join(bin, "pnpm"), 0o755);
    path = `${bin}:${process.env.PATH}`;

    git(repo, "init", "-q", "-b", "main");
    copyFileSync(join(REPO_ROOT, ".husky", "pre-push"), join(repo, ".husky", "pre-push"));
    for (const f of ["push-remote-classify.sh", "format-gate.sh"])
      copyFileSync(join(REPO_ROOT, "scripts", "hooks", f), join(repo, "scripts", "hooks", f));
    writeFileSync(join(repo, "README.md"), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "main");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "checkout", "-q", "-b", "other");
    writeFileSync(join(repo, "README.md"), "other\n");
    git(repo, "commit", "-q", "-am", "other");
    other = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "work", "main");
    writeFileSync(join(repo, "work.txt"), "w\n");
    git(repo, "add", "work.txt");
    git(repo, "commit", "-q", "-m", "work");
    head = git(repo, "rev-parse", "HEAD");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the bounded changed-root tests for a push of HEAD", () => {
    writeFileSync(calls, "");
    const r = push([`refs/heads/work ${head} refs/heads/work ${NULL_OID}`]);
    expect(r.output).toContain("Pre-push: changed root test files OK.");
    expect(r.status).toBe(0);
    expect(ranRootTests()).toBe(true);
  });

  // `git push origin HEAD:x` passes the local ref as `HEAD`, `<sha>:refs/heads/x`
  // as the raw sha: classification must read the REMOTE ref.
  for (const [form, line] of [
    ["HEAD:<branch>", () => `HEAD ${head} refs/heads/pr-x ${NULL_OID}`],
    ["<sha>:refs/heads/<branch>", () => `${head} ${head} refs/heads/pr-y ${other}`],
  ] as const)
    it(`runs the checks for the ${form} push form`, () => {
      writeFileSync(calls, "");
      const r = push([line()]);
      expect(r.output).toContain("Pre-push: changed root test files OK.");
      expect(r.status).toBe(0);
      expect(ranRootTests()).toBe(true);
    });

  it("refuses HEAD:<branch> when the pushed commit is not HEAD", () => {
    const r = push([`HEAD ${other} refs/heads/pr-z ${NULL_OID}`]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("not the checked-out HEAD");
  });

  it("skips section (6) on a branch delete or a tag push", () => {
    writeFileSync(calls, "");
    const r = push([
      `(delete) ${NULL_OID} refs/heads/gone ${head}`,
      `refs/tags/v1 ${head} refs/tags/v1 ${NULL_OID}`,
      `HEAD ${head} refs/tags/v2 ${NULL_OID}`,
    ]);
    expect(r.status).toBe(0);
    expect(r.output).toContain("no branch update in this push");
    expect(ranRootTests()).toBe(false);
  });

  it("refuses a pushed branch that is not the checked-out HEAD", () => {
    writeFileSync(calls, "");
    const r = push([`refs/heads/other ${other} refs/heads/other ${NULL_OID}`]);
    expect(r.status).toBe(1);
    expect(r.output).toContain("not the checked-out HEAD");
    expect(ranRootTests()).toBe(false);
  });

  it("refuses a dirty tracked tree", () => {
    writeFileSync(join(repo, "work.txt"), "dirty\n");
    try {
      const r = push([`refs/heads/work ${head} refs/heads/work ${NULL_OID}`]);
      expect(r.status).toBe(1);
      expect(r.output).toContain("uncommitted changes");
    } finally {
      git(repo, "checkout", "--", "work.txt");
    }
  });

  it("fails closed when no main ref resolves for the issue-id gates", () => {
    mkdirSync(join(repo, "plan", "issues"), { recursive: true });
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    try {
      const r = push([`refs/heads/work ${head} refs/heads/work ${NULL_OID}`]);
      expect(r.status).toBe(1);
      expect(r.output).toContain("neither upstream/main nor origin/main resolves");
    } finally {
      git(repo, "update-ref", "refs/remotes/origin/main", "main");
      rmSync(join(repo, "plan"), { recursive: true, force: true });
    }
  });
});
