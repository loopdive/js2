import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #3738 — check-baseline-trap-growth.ts's CLI never passed
// missingBaselineRowsAreUnknown to evaluateTrapCategoryGrowth, so a
// candidate-only row (present in the "after" snapshot, absent from "before")
// read as fabricated trap growth even though the baseline never testified
// either way. Discovered landing #3735/#3736's declaration: the named test
// genuinely has no row in the baseline JSONL, so the reclassification claim
// couldn't be verified — but it shouldn't need to be, since an absent row is
// not evidence of growth at all.

const CLI = join(import.meta.dirname ?? ".", "..", "scripts", "check-baseline-trap-growth.ts");

function jsonl(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

describe("#3738 — trap-growth gate ignores candidate-only rows (no baseline evidence)", () => {
  it("does not fail when a newly-trapping file has NO row at all in the baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "trap-growth-3738-"));
    try {
      const baselinePath = join(dir, "before.jsonl");
      const candidatePath = join(dir, "after.jsonl");
      writeFileSync(baselinePath, jsonl([{ file: "test/ok.js", status: "pass", wasm_sha: "aaa" }]));
      writeFileSync(
        candidatePath,
        jsonl([
          { file: "test/ok.js", status: "pass", wasm_sha: "aaa" },
          {
            file: "test/built-ins/TypedArray/prototype/set/array-arg-offset-tointeger.js",
            status: "fail",
            error_category: "oob",
            wasm_sha: "zzz",
          },
        ]),
      );
      // Must not throw — the candidate-only trapping row has no baseline
      // counterpart, so it's an unknown observation, not growth.
      expect(() =>
        execFileSync("npx", ["tsx", CLI, "--baseline", baselinePath, "--candidate", candidatePath], {
          encoding: "utf-8",
          stdio: "pipe",
        }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still fails when a file WITH a baseline row genuinely newly traps", () => {
    const dir = mkdtempSync(join(tmpdir(), "trap-growth-3738-regress-"));
    try {
      const baselinePath = join(dir, "before.jsonl");
      const candidatePath = join(dir, "after.jsonl");
      writeFileSync(baselinePath, jsonl([{ file: "test/regressed.js", status: "pass", wasm_sha: "aaa" }]));
      writeFileSync(
        candidatePath,
        jsonl([{ file: "test/regressed.js", status: "fail", error_category: "oob", wasm_sha: "zzz" }]),
      );
      expect(() =>
        execFileSync("npx", ["tsx", CLI, "--baseline", baselinePath, "--candidate", candidatePath], {
          encoding: "utf-8",
          stdio: "pipe",
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
