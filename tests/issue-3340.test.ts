// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3340 — the root issue-tests gate must keep INVERTED expected-failure
 * sentinels out of the baseline. An `it.fails` test whose body unexpectedly
 * PASSES (vitest: status "failed" + "Expect test to fail") is a stale sentinel
 * demanding obsolete bad behavior; left in the `failing` set it is silently
 * absorbed into `knownFailures`, so main stays green while a real improvement is
 * masked. `scripts/issue-tests-gate.mjs` now splits these into a distinct
 * `unexpectedPasses` set that (a) is NEVER seeded into the baseline and (b) hard-
 * fails the run so the test must be promoted.
 *
 * This exercises the gate CLI directly via its merge-mode env contract
 * (MERGE_PARTIALS_DIR): a partial carrying an `unexpectedPasses` id must fail
 * with UNEXPECTED PASS, while an ordinary baselined failure still passes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE = resolve(import.meta.dirname, "..", "scripts", "issue-tests-gate.mjs");
const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "issue-3340-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function runGate(partial: Record<string, string[]>, baseline: { knownFailures: string[] }) {
  const mergeDir = mkTmp();
  writeFileSync(join(mergeDir, "partial-1.json"), JSON.stringify(partial));
  const baselinePath = join(mkTmp(), "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(baseline));
  return spawnSync(process.execPath, [GATE], {
    encoding: "utf8",
    env: { ...process.env, MERGE_PARTIALS_DIR: mergeDir, ISSUE_TESTS_BASELINE: baselinePath },
  });
}

describe("#3340 — inverted-sentinel (unexpected-pass) gate", () => {
  it("hard-fails on an unexpected-pass id and never seeds it into the baseline", () => {
    const r = runGate(
      { failing: [], passing: [], unexpectedPasses: ["tests/foo.test.ts :: foo does the thing"] },
      { knownFailures: [] },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/UNEXPECTED PASS/);
    expect(`${r.stdout}${r.stderr}`).toContain("tests/foo.test.ts :: foo does the thing");
  });

  it("does NOT trip on an ordinary baselined failure (control — real known failure still accepted)", () => {
    const id = "tests/bar.test.ts :: bar known-broken";
    const r = runGate({ failing: [id], passing: [], unexpectedPasses: [] }, { knownFailures: [id] });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/UNEXPECTED PASS/);
  });

  it("still flags a genuine NEW regression (control — gate not weakened)", () => {
    const r = runGate(
      { failing: ["tests/baz.test.ts :: baz newly broke"], passing: [], unexpectedPasses: [] },
      { knownFailures: [] },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/REGRESSION/);
  });
});
