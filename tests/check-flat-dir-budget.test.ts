// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6797 — tests for the flat-directory budget (`scripts/check-flat-dir-budget.mjs`).
 * Only top-level `.ts` files count; sub-directories and `.d.ts` are free.
 * Outside a repository the committed budget is the reference: growth fails, a
 * decrease passes, `--update-on-decrease` lowers the budget. Inside one the
 * gate is change-scoped: an added top-level file fails until the change-set
 * lists it under `flat-dir-budget-allow:` in an issue file it touches.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-flat-dir-budget.mjs");
/** The parent environment without GIT_* (see `git` below for why). */
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

const root = mkdtempSync(join(tmpdir(), "flat-dir-budget-"));
const codegen = join(root, "src", "codegen");
const baseline = join(root, "budget.json");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runIn(rootDir: string, budgetPath: string, env: Record<string, string>, args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--root", rootDir, "--baseline", budgetPath, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { ...CLEAN_ENV, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const run = (...args: string[]): RunResult => runIn(root, baseline, {}, args);

/**
 * git in a throwaway repository under the OS tmp dir, with every GIT_*
 * variable dropped. A git hook (pre-commit runs this file) exports GIT_DIR;
 * inherited, `git init` re-initialises the REAL repository as bare.
 */
function git(cwd: string, ...args: string[]): string {
  if (!cwd.startsWith(tmpdir())) throw new Error(`refusing to run git outside the tmp dir: ${cwd}`);
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf-8", env: CLEAN_ENV, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

const budget = (): Record<string, number> => JSON.parse(readFileSync(baseline, "utf-8")) as Record<string, number>;

describe("#6797 — flat-dir budget", () => {
  beforeAll(() => {
    mkdirSync(join(codegen, "expressions"), { recursive: true });
    for (const f of ["a.ts", "b.ts", "types.d.ts", "expressions/c.ts"]) writeFileSync(join(codegen, f), "export {};\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("seeds the budget from top-level .ts files only", () => {
    expect(run("--update").status).toBe(0);
    expect(budget()).toEqual({ "src/codegen": 2 });
  });

  it("allows new files in a sub-directory", () => {
    writeFileSync(join(codegen, "expressions", "d.ts"), "export {};\n");
    expect(run().status).toBe(0);
  });

  it("FAILS when a top-level file is added", () => {
    writeFileSync(join(codegen, "new-flat.ts"), "export {};\n");
    const res = run();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("src/codegen/*.ts: 2 → 3 (+1; committed budget, no-git)");
    expect(budget()).toEqual({ "src/codegen": 2 });
  });

  it("passes on a decrease and banks it with --update-on-decrease", () => {
    rmSync(join(codegen, "new-flat.ts"));
    rmSync(join(codegen, "b.ts"));
    expect(run().status).toBe(0);
    expect(budget()).toEqual({ "src/codegen": 2 }); // a plain gate run never writes

    const bank = run("--update-on-decrease");
    expect(bank.status).toBe(0);
    expect(bank.stdout).toContain("banked src/codegen/*.ts 2 → 1");
    expect(budget()).toEqual({ "src/codegen": 1 });
  });

  it("in a repository, fails an added top-level file until flat-dir-budget-allow lists it", () => {
    const repo = mkdtempSync(join(tmpdir(), "flat-dir-repo-"));
    try {
      const write = (rel: string, body: string): void => {
        mkdirSync(dirname(join(repo, rel)), { recursive: true });
        writeFileSync(join(repo, rel), body);
      };
      write("src/codegen/a.ts", "export {};\n");
      write("budget.json", '{\n  "src/codegen": 1\n}\n');
      git(repo, "init", "-q");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      const env = { LOC_GATE_BASE: git(repo, "rev-parse", "HEAD") };
      const gate = (): RunResult => runIn(repo, join(repo, "budget.json"), env, []);

      write("src/codegen/new-flat.ts", "export {};\n");
      const bare = gate();
      expect(bare.status).toBe(1);
      expect(bare.stderr).toContain("src/codegen/*.ts: 1 → 2 (+1, 0 granted; base: env:LOC_GATE_BASE)");
      expect(bare.stderr).toContain("not granted: src/codegen/new-flat.ts");

      write(
        "plan/issues/9999-grow.md",
        "---\nid: 9999\nflat-dir-budget-allow:\n  - src/codegen/new-flat.ts # 2026-10-02 (#9999): test grant\n---\n\n# x\n",
      );
      const allowed = gate();
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toContain("granted src/codegen/new-flat.ts by plan/issues/9999-grow.md");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
