// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6797 — tests for the flat-directory budget (`scripts/check-flat-dir-budget.mjs`).
 * Only top-level `.ts` files count; sub-directories and `.d.ts` are free.
 * Growth fails, a decrease passes, `--update-on-decrease` lowers the budget.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-flat-dir-budget.mjs");

const root = mkdtempSync(join(tmpdir(), "flat-dir-budget-"));
const codegen = join(root, "src", "codegen");
const baseline = join(root, "budget.json");

function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--root", root, "--baseline", baseline, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
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
    expect(res.stderr).toContain("src/codegen/*.ts: 2 → 3 (+1)");
    expect(budget()).toEqual({ "src/codegen": 2 });
  });

  it("passes on a decrease and banks it with --update-on-decrease", () => {
    rmSync(join(codegen, "new-flat.ts"));
    rmSync(join(codegen, "b.ts"));
    const plain = run();
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("[improved — --update-on-decrease banks it]");
    expect(budget()).toEqual({ "src/codegen": 2 });

    expect(run("--update-on-decrease").status).toBe(0);
    expect(budget()).toEqual({ "src/codegen": 1 });
  });
});
