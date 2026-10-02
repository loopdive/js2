// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6784 — the `lint` gate must be able to fail.
 *
 * Biome 1.9 charges EVERY diagnostic (warnings included) against
 * `--max-diagnostics` (default 20), even ones `--diagnostic-level=error`
 * hides, and derives its exit code only from the diagnostics it actually
 * emitted. With thousands of `noExplicitAny` warnings in the tree, the 20
 * slots were always spent on warnings, no error was ever emitted, and
 * `pnpm run lint` exited 0 with 11 real errors on main.
 *
 * This test runs the REAL `lint` script string from package.json (and the
 * lint-staged biome command) against a throwaway directory laid out like the
 * repo (`src/ tests/ scripts/` + a copy of the repo's biome.json) whose one
 * source file carries more `any` warnings than the old cap, followed by one
 * error. A gate that can fail has to be shown failing once.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  "lint-staged": Record<string, string | string[]>;
};
const LINT_SCRIPT = pkg.scripts.lint!;
const LINT_STAGED_BIOME = ([] as string[])
  .concat(pkg["lint-staged"]["*.{ts,js,mjs}"]!)
  .find((cmd) => cmd.startsWith("biome lint"))!;
// The `lint` script as it stood before #6784 — the control that proves the
// fixture really exercises the diagnostic-cap hole.
const PRE_6784_LINT = "biome lint src tests scripts --diagnostic-level=error";

// 40 warnings (> Biome's default cap of 20), THEN the error, in one file so
// the order Biome visits diagnostics in is deterministic.
const WARNINGS = Array.from({ length: 40 }, (_, i) => `export const w${i}: any = ${i};`).join("\n");
const ERROR = "export function stop(): void {\n  debugger;\n}\n";

let dir: string;
const env = { ...process.env, PATH: `${join(REPO, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` };

function run(command: string): number {
  try {
    execFileSync("sh", ["-c", command], { cwd: dir, env, stdio: "pipe" });
    return 0;
  } catch (e) {
    const status = (e as { status?: number | null }).status;
    if (typeof status !== "number") throw e;
    return status;
  }
}

function writeFixture(withError: boolean): void {
  writeFileSync(join(dir, "src", "gate-fixture.ts"), `${WARNINGS}\n${withError ? ERROR : ""}`);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "js2-lint-gate-"));
  copyFileSync(join(REPO, "biome.json"), join(dir, "biome.json"));
  for (const sub of ["src", "tests", "scripts"]) mkdirSync(join(dir, sub));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("#6784 — lint gate can fail", () => {
  it("the lint script lifts Biome's diagnostic cap", () => {
    expect(LINT_SCRIPT).toContain("--max-diagnostics=none");
    expect(LINT_STAGED_BIOME).toContain("--max-diagnostics=none");
  });

  it("`pnpm run lint` exits 1 when an error sits behind more than 20 warnings", () => {
    writeFixture(true);
    expect(run(LINT_SCRIPT)).toBe(1);
  });

  it("the lint-staged biome command exits 1 on the same file", () => {
    writeFixture(true);
    expect(run(`${LINT_STAGED_BIOME} src/gate-fixture.ts`)).toBe(1);
  });

  it("control: warnings alone do not fail the gate", () => {
    writeFixture(false);
    expect(run(LINT_SCRIPT)).toBe(0);
  });

  it("control: the pre-#6784 script passed this same error (the hole the fixture reproduces)", () => {
    // If a Biome upgrade stops charging hidden warnings against the cap, this
    // control flips to 1; the fix above stays correct and this case can go.
    writeFixture(true);
    expect(run(PRE_6784_LINT)).toBe(0);
  });
});
