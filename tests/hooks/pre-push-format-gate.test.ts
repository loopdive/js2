// #6799 — the pre-push prettier gate checks the CHANGED files only, with no
// watchdog. It used to run the whole-tree `format:check` under a 90 s watchdog
// that printed "TIMED OUT — skipping" (82 s idle, 108 s under one concurrent
// job), so it skipped itself exactly when the box was busy.
//
// These tests drive the sourced POSIX-sh helper (scripts/hooks/format-gate.sh)
// against a throwaway git repo, with a stub `pnpm` on PATH that records how it
// was called — the same code `.husky/pre-push` sources, mirroring
// tests/hooks/pre-push-labs-remote.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "hooks", "format-gate.sh");
const HOOK = join(REPO_ROOT, ".husky", "pre-push");

// A clean env for the child: no inherited GIT_DIR & co. (a hook context would
// otherwise point every `git` at the outer repository).
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX"]) delete env[k];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8", env: childEnv() },
  ).trim();
}

function write(root: string, path: string, text = "export const x = 1;\n"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// Source the helper and run `script` in `cwd`; returns status + combined output.
function runSh(cwd: string, script: string, extra: Record<string, string> = {}): { status: number; output: string } {
  try {
    const out = execFileSync("/bin/sh", ["-c", `. "$0"; ${script}`, LIB], {
      cwd,
      encoding: "utf8",
      env: childEnv(extra),
    });
    return { status: 0, output: out };
  } catch (e: any) {
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("#6799 pre-push format gate — changed files, no watchdog", () => {
  let dir: string;
  let repo: string;
  let bin: string;
  let callLog: string;
  let base: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fmt-gate-6799-"));
    repo = join(dir, "repo");
    bin = join(dir, "bin");
    callLog = join(dir, "pnpm-calls");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });

    // Stub pnpm: append its argv (one call per line) and exit with $PNPM_RC.
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> "${callLog}"\nexit "\${PNPM_RC:-0}"\n`);
    chmodSync(join(bin, "pnpm"), 0o755);

    git(repo, "init", "-q", "-b", "main");
    for (const f of ["src/a.ts", "src/gone.ts", "tests/b.ts", "scripts/c.ts", "scripts/d.mjs", "docs/x.md", "lib/y.ts"])
      write(repo, f);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    base = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", base);

    // The branch under test: covered edits, a new nested .d.ts, a deletion,
    // and changes outside the format:check globs.
    write(repo, "src/a.ts", "export const x = 2;\n");
    write(repo, "src/sub/deep.d.ts", "export declare const y: number;\n");
    write(repo, "scripts/new.ts");
    write(repo, "scripts/d.mjs", "export const z = 3;\n");
    write(repo, "docs/x.md", "# changed\n");
    write(repo, "lib/y.ts", "export const w = 4;\n");
    git(repo, "rm", "-q", "src/gone.ts");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "branch work");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const calls = (): string[] => (existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : []);
  const resetCalls = () => rmSync(callLog, { force: true });

  it("format_gate_base resolves the merge-base with origin/main", () => {
    expect(runSh(repo, "format_gate_base").output.trim()).toBe(base);
  });

  it("format_changed_files lists only covered, still-present *.ts files", () => {
    const files = runSh(repo, `format_changed_files "${base}"`).output.trim().split("\n");
    expect(files).toEqual(["scripts/new.ts", "src/a.ts", "src/sub/deep.d.ts"]);
  });

  it("run_format_gate hands exactly those files to prettier --check and passes on 0", () => {
    resetCalls();
    const r = runSh(repo, "run_format_gate", { PATH: `${bin}:${process.env.PATH}`, PNPM_RC: "0" });
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/prettier --check on 3 changed file\(s\)/);
    expect(calls()).toEqual(["exec prettier --check scripts/new.ts src/a.ts src/sub/deep.d.ts"]);
  });

  it("a prettier failure blocks — there is no timeout code to skip on", () => {
    resetCalls();
    const r = runSh(repo, "run_format_gate", { PATH: `${bin}:${process.env.PATH}`, PNPM_RC: "1" });
    expect(r.status).not.toBe(0);
    expect(calls()).toHaveLength(1);
  });

  it("prefers upstream/main over origin/main (a fork's origin may have diverged)", () => {
    // upstream/main = the branch tip itself ⇒ merge-base is HEAD ⇒ nothing changed.
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/upstream/main", head);
    try {
      expect(runSh(repo, "format_gate_base").output.trim()).toBe(head);
      resetCalls();
      const r = runSh(repo, "run_format_gate", { PATH: `${bin}:${process.env.PATH}` });
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/nothing to format-check/);
      expect(calls()).toEqual([]);
    } finally {
      git(repo, "update-ref", "-d", "refs/remotes/upstream/main");
    }
  });

  it("with no main ref at all it checks the WHOLE tree, unbounded — never skips", () => {
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    try {
      expect(runSh(repo, "format_gate_base").output.trim()).toBe("");
      resetCalls();
      const r = runSh(repo, "run_format_gate", { PATH: `${bin}:${process.env.PATH}`, PNPM_RC: "0" });
      expect(r.status).toBe(0);
      expect(calls()).toEqual(["run format:check"]);
    } finally {
      git(repo, "update-ref", "refs/remotes/origin/main", base);
    }
  });
});

describe("#6799 .husky/pre-push wiring", () => {
  const hook = readFileSync(HOOK, "utf8");

  it("uses the changed-files gate and has no watchdog/skip path", () => {
    expect(hook).toContain("run_format_gate");
    expect(hook).not.toContain("run_format_watchdog");
    // The history comment may name the old message; no code path may print it.
    expect(hook).not.toMatch(/echo[^\n]*TIMED OUT/);
    expect(hook).not.toMatch(/-eq 124/);
  });

  it("never commits and never advises bypassing hooks", () => {
    expect(hook).not.toMatch(/git commit/);
    expect(hook).not.toMatch(/no-verify/);
    expect(hook).not.toMatch(/refresh:benchmarks/);
  });

  it("the v* benchmark refresh moved to scripts/release.mjs, with hooks intact", () => {
    const release = readFileSync(join(REPO_ROOT, "scripts", "release.mjs"), "utf8");
    expect(release).toContain('["run", "refresh:benchmarks"]');
    expect(release).toContain("--skip-benchmarks");
    expect(release).not.toMatch(/no-verify/);
  });
});
