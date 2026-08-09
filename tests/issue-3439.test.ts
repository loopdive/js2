import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #3439 — restore the strict standalone root-cause gate
 * (`--max-unclassified-root-causes 0`, reverting #3378's temporary 300 relaxation).
 *
 * Verify-first finding (2026-07-24): the #3369-era 186 unclassified failures
 * (signature `wasm exception during module init`) no longer appear on current
 * main (0 records), and the existing `STANDALONE_ROOT_CAUSE_BUCKETS` classify
 * every current standalone failure (0 unclassified on the merge_group runs for
 * pr-3530 / pr-3531, 2026-07-23). So the fix is the gate flip alone — a new
 * bucket would be dead code (criterion #3 forbids catch-alls for absent signals).
 *
 * The load-bearing invariant this locks: with `--max-unclassified-root-causes 0`
 * the report builder ACTUALLY ENFORCES the gate — it exits non-zero when any
 * standalone failure is unclassified, and exits zero when all are classified.
 * A future weakening of that enforcement would silently turn the merge_group
 * triage gate back into a no-op (the real risk behind the 300→0 flip).
 */
describe("#3439 — standalone unclassified-root-cause gate enforcement", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-3439-"));
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(records: object[], threshold?: number): { code: number; stderr: string; outPath: string } {
    const jsonl = join(tmpDir, `in-${Math.random().toString(36).slice(2)}.jsonl`);
    const out = join(tmpDir, `out-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join("\n"));
    const thresholdArg = threshold === undefined ? "" : ` --max-unclassified-root-causes ${threshold}`;
    try {
      execSync(
        `node scripts/build-test262-report.mjs --input ${jsonl} --output ${out} --target standalone --include-proposals${thresholdArg}`,
        { cwd: process.cwd(), stdio: "pipe" },
      );
      return { code: 0, stderr: "", outPath: out };
    } catch (e: unknown) {
      const err = e as { status?: number; stderr?: Buffer };
      return { code: err.status ?? 1, stderr: err.stderr?.toString() ?? "", outPath: out };
    }
  }

  // A standalone `fail` whose signature matches no bucket → unclassified.
  const unclassified = {
    file: "test/zzz-novel-unbucketed/aaa.js",
    category: "zzz-novel-unbucketed",
    status: "fail",
    error_category: "other",
    error: "zzz totally novel qqq signature with no bucket match",
  };
  // A standalone `fail` whose error_category text (`assertion_fail`) is caught by
  // the `misc-spec-tail` residual bucket → classified.
  const classified = {
    file: "test/language/expressions/addition/basic.js",
    category: "language",
    status: "fail",
    error_category: "assertion_fail",
    error: "assertion_fail: expected 3 got 4",
  };
  const passRow = { file: "test/built-ins/Array/prototype/map/basic.js", category: "built-ins", status: "pass" };

  it("gate ARMED at 0: an unclassified standalone failure fails the build (non-zero exit)", () => {
    const r = run([unclassified, passRow], 0);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/unclassified failures; threshold is 0/);
  });

  it("gate at 0 PASSES when every standalone failure is classified", () => {
    const r = run([classified, passRow], 0);
    expect(r.code).toBe(0);
    const report = JSON.parse(readFileSync(r.outPath, "utf-8"));
    expect(report.root_cause_map.unclassified.count).toBe(0);
    expect(report.root_cause_map.unclassified_threshold).toBe(0);
  });

  it("without the flag, an unclassified failure does NOT fail the build (gate is opt-in)", () => {
    const r = run([unclassified, passRow]); // no --max-unclassified-root-causes
    expect(r.code).toBe(0);
    const report = JSON.parse(readFileSync(r.outPath, "utf-8"));
    // still recorded as unclassified in the map, just not enforced
    expect(report.root_cause_map.unclassified.count).toBe(1);
    expect(report.root_cause_map.unclassified_threshold).toBe(null);
  });

  it("the relaxed 300 threshold masks a single unclassified (documents why the flip matters)", () => {
    const r = run([unclassified, passRow], 300);
    expect(r.code).toBe(0); // 1 <= 300, so #3378's relaxation let it through
  });
});
