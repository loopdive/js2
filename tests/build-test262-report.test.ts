import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #106 — the landing-page pass-rate must default to the ~43k
 * ECMAScript current-standard tests (scope: standard + annex_b)
 * and exclude the ~5k TC39 proposal tests. Proposals are opt-in
 * via a slider on the landing page.
 *
 * These tests exercise `scripts/build-test262-report.mjs` directly
 * with a synthetic JSONL so we don't depend on the live baseline.
 */
describe("build-test262-report.mjs — #106 standard vs proposal split", () => {
  let tmpDir: string;
  let report: ReturnType<typeof JSON.parse>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "build-test262-report-"));
    const jsonl = join(tmpDir, "results.jsonl");
    const out = join(tmpDir, "report.json");

    // Two standard passes, one standard fail; one annex_b pass; one proposal pass, one proposal fail.
    const records = [
      { file: "test/language/x.js", status: "pass", scope: "standard", scope_official: true, strict: "both" },
      { file: "test/language/y.js", status: "pass", scope: "standard", scope_official: true, strict: "both" },
      { file: "test/language/z.js", status: "fail", scope: "standard", scope_official: true, strict: "both" },
      { file: "test/annexB/a.js", status: "pass", scope: "annex_b", scope_official: true, strict: "both" },
      { file: "test/staging/p1.js", status: "pass", scope: "proposal", scope_official: false, strict: "both" },
      { file: "test/staging/p2.js", status: "fail", scope: "proposal", scope_official: false, strict: "both" },
    ];
    writeFileSync(jsonl, records.map((r) => JSON.stringify({ category: r.file.split("/")[1] ?? "", ...r })).join("\n"));

    execSync(`node scripts/build-test262-report.mjs --input ${jsonl} --output ${out}`, {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    report = JSON.parse(readFileSync(out, "utf-8"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("headline `summary` reflects current-standard + annex_b (excludes proposals)", () => {
    // 3 standard + 1 annex_b = 4 official tests, of which 3 pass.
    expect(report.summary.total).toBe(4);
    expect(report.summary.pass).toBe(3);
    expect(report.summary.fail).toBe(1);
  });

  it("`full_summary` includes proposals", () => {
    // All 6 records: 4 pass, 2 fail.
    expect(report.full_summary.total).toBe(6);
    expect(report.full_summary.pass).toBe(4);
    expect(report.full_summary.fail).toBe(2);
  });

  it("`summary.by_category` exposes per-scope counts for the slider", () => {
    const buckets = report.summary.by_category;
    expect(buckets).toBeTruthy();
    expect(buckets.standard.total).toBe(3);
    expect(buckets.standard.pass).toBe(2);
    expect(buckets.annex_b.total).toBe(1);
    expect(buckets.proposal.total).toBe(2);
    expect(buckets.proposal.pass).toBe(1);
    expect(buckets.official.total).toBe(4); // standard + annex_b
    expect(buckets.full.total).toBe(6); // including proposals
  });

  it("each bucket carries a human-readable label", () => {
    const buckets = report.summary.by_category;
    expect(typeof buckets.standard.label).toBe("string");
    expect(typeof buckets.proposal.label).toBe("string");
    expect(typeof buckets.official.label).toBe("string");
  });

  it("`scope_summaries` retains the per-scope breakdown for back-compat", () => {
    expect(report.scope_summaries.standard.total).toBe(3);
    expect(report.scope_summaries.annex_b.total).toBe(1);
    expect(report.scope_summaries.proposal.total).toBe(2);
  });

  it("default pass rate (standard) differs from proposal-inclusive pass rate", () => {
    const std = (report.summary.pass / report.summary.total) * 100;
    const full = (report.full_summary.pass / report.full_summary.total) * 100;
    expect(Math.round(std * 10) / 10).toBe(75.0); // 3/4
    expect(Math.round(full * 10) / 10).toBe(Math.round((4 / 6) * 1000) / 10);
    // Including proposals lowers the headline rate.
    expect(full).toBeLessThan(std);
  });
});

/**
 * Fallback-free pass metric: a pass counts as `ir_only_pass` only when its
 * compile recorded an IR route census with zero legacy bodies; rows without a
 * census are neither counted nor measured, and every fallback code is ranked
 * by the number of tests that still take a legacy body for it.
 */
describe("build-test262-report.mjs — fallback-free (IR-only) passes", () => {
  let tmpDir: string;
  let report: ReturnType<typeof JSON.parse>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "build-test262-report-ir-"));
    const jsonl = join(tmpDir, "results.jsonl");
    const out = join(tmpDir, "report.json");
    const base = { scope: "standard", scope_official: true, strict: "both", category: "language" };
    const records = [
      { file: "test/language/a.js", status: "pass", ir_units: 3, ir_legacy_units: 0, ...base },
      {
        file: "test/language/b.js",
        status: "pass",
        ir_units: 3,
        ir_legacy_units: 2,
        ir_fallback_codes: [{ code: "unsupported:select:eval", count: 2 }],
        ...base,
      },
      {
        file: "test/language/c.js",
        status: "fail",
        ir_units: 1,
        ir_legacy_units: 1,
        ir_fallback_codes: [{ code: "unsupported:select:eval", count: 1 }],
        ...base,
      },
      { file: "test/language/d.js", status: "pass", ...base }, // no census (older row)
    ];
    writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join("\n"));
    execSync(`node scripts/build-test262-report.mjs --input ${jsonl} --output ${out} --target standalone`, {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    report = JSON.parse(readFileSync(out, "utf-8"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("counts fallback-free passes separately, over the full denominator", () => {
    expect(report.summary.pass).toBe(3);
    expect(report.summary.ir_only_pass).toBe(1);
    expect(report.summary.ir_measured).toBe(3);
    expect(report.summary.ir_only_pass_pct).toBe(25);
  });

  it("ranks fallback codes by the tests that still take a legacy body", () => {
    expect(report.ir_fallback_codes).toEqual([
      { code: "unsupported:select:eval", tests: 2, units: 3, passing_tests: 1 },
    ]);
  });
});
