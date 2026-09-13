// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The #3518 compiler-boundary gate redirects its JSON verdict into an artifact.
 * When it failed, the job log carried nothing but `exit code 1`, so an
 * `auto-park-bot:merge-group-failure` citing this step named a failing step and
 * no reason — indistinguishable from the main-side drift parks a shepherd is
 * allowed to unhold. The reason now travels on stderr; these workflow-contract
 * assertions keep that channel open and the artifact contract intact (#6418).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const workflow = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const stepStart = workflow.indexOf("      - name: Compiler inventory and activated boundaries (#3518)");
const uploadStart = workflow.indexOf("      - name: Preserve compiler boundary evidence (#3518)", stepStart);
const stepEnd = workflow.indexOf("\n      - name: ", uploadStart + 1);
const step = workflow.slice(stepStart, uploadStart);
const upload = workflow.slice(uploadStart, stepEnd);

describe("boundary-inventory verdict reaches the job log (#6418)", () => {
  it("still writes the report the artifact upload preserves", () => {
    expect(stepStart).toBeGreaterThanOrEqual(0);
    expect(uploadStart).toBeGreaterThan(stepStart);
    expect(step).toContain("scripts/check-compiler-boundaries.mjs");
    expect(step).toContain("--mode inventory --base HEAD^1 > compiler-boundaries-report.json");
    expect(upload).toContain("path: compiler-boundaries-report.json");
    expect(upload).toContain("if-no-files-found: error");
  });

  it("never discards or merges stderr into the redirected stdout", () => {
    // `2>/dev/null` would drop the reason; `2>&1 >file` would send it into the
    // artifact instead of the log — both reinstate the invisible park.
    expect(step).not.toContain("2>/dev/null");
    expect(step).not.toContain("2>&1");
    expect(step).not.toContain("2>");
  });

  it("annotates the failure so the park comment points somewhere readable", () => {
    expect(step).toContain("::error::compiler-boundaries gate failed");
    expect(step).toContain("compiler-boundaries-${{ github.run_id }}-${{ github.run_attempt }}");
  });

  it("keeps the checker's stdout a pure JSON report", () => {
    const checker = readFileSync(resolve(ROOT, "scripts/check-compiler-boundaries.mjs"), "utf8");
    const cli = checker.slice(checker.indexOf("function printVerdict"));
    expect(cli).toContain("process.stderr.write");
    // The human-readable verdict must not be console.log'd: stdout is parsed as
    // JSON by the artifact consumer and by issue-3518's tests.
    expect(cli.slice(0, cli.indexOf("if (process.argv[1]"))).not.toContain("console.log");
  });
});
