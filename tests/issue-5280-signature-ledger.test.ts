/**
 * #5280 — the cross-PR bucket-signature ledger must make the "same signature
 * on another PR" hint load-bearing WITHOUT weakening the gate for a genuine
 * single-PR regression.
 *
 * The two properties that matter are opposites, so both are pinned here:
 *   • a signature seen ONCE stays `first-occurrence` (no downgrade), and
 *   • a signature seen on a second PR whose test262-relevant diff is disjoint
 *     becomes `cross-pr-flake-candidate` and names the prior occurrence.
 * The 2026-09-02 incident (#5479/#5480/#5486, signature 96690aa5e0efb4ff) is
 * reproduced literally as the regression witness.
 */
import { describe, expect, it } from "vitest";
import { buildRecord, classify, pathsDisjoint, renderBanner } from "../scripts/test262-signature-ledger.mjs";

const SIG = "96690aa5e0efb4ff";
const ROW = "test/language/statements/class/subclass/class-definition-null-proto-super.js fail";

function rec(pr: string, runId: string, changedPaths: string[], signature = SIG) {
  return buildRecord({
    signature,
    files: [ROW],
    event: "merge_group",
    runId,
    prNumber: pr,
    headSha: `sha-${pr}`,
    changedPaths,
    recordedAt: "2026-09-02T12:15:00.000Z",
  });
}

describe("#5280 cross-PR bucket-signature ledger", () => {
  it("leaves a first occurrence alone — a signature seen once is still real", () => {
    const result = classify(rec("5479", "33626922676", ["src/builtins/typed-array.ts"]), []);
    expect(result.verdict).toBe("first-occurrence");
    expect(result.matched).toBeNull();
    expect(renderBanner(rec("5479", "33626922676", ["src/x.ts"]), result)).toContain("still real");
  });

  it("downgrades to a flake candidate when a second PR with a disjoint diff hits the same signature", () => {
    // #5479 changed the builtins/prototype graph; #5480 changed module-init
    // prelift. Disjoint src files, identical one-row cluster.
    const prior = rec("5479", "33626922676", ["src/builtins/typed-array.ts"]);
    const current = rec("5480", "33642323854", ["src/ir/module-init-prelift.ts"]);
    const result = classify(current, [prior]);
    expect(result.verdict).toBe("cross-pr-flake-candidate");
    expect(result.matched?.pr).toBe("5479");
    expect(result.matched?.run_id).toBe("33626922676");
    const banner = renderBanner(current, result);
    expect(banner).toContain("CROSS-PR FLAKE CANDIDATE");
    expect(banner).toContain("33626922676");
    expect(banner).toContain(SIG);
  });

  it("does NOT downgrade when the two diffs share a test262-relevant path", () => {
    const prior = rec("5479", "33626922676", ["src/codegen/index.ts", "src/builtins/typed-array.ts"]);
    const current = rec("5486", "33683869984", ["src/codegen/index.ts"]);
    const result = classify(current, [prior]);
    expect(result.verdict).toBe("overlapping-diff");
    expect(renderBanner(current, result)).toContain("OVERLAPPING DIFF");
  });

  it("does NOT downgrade on a re-run of the same PR", () => {
    const prior = rec("5480", "33642323854", ["src/ir/module-init-prelift.ts"]);
    const current = rec("5480", "33650000000", ["src/ir/module-init-prelift.ts"]);
    expect(classify(current, [prior]).verdict).toBe("repeat-same-pr");
  });

  it("ignores a record from this same run — a run cannot corroborate itself", () => {
    const current = rec("5486", "33683869984", ["src/a.ts"]);
    expect(classify(current, [rec("5486", "33683869984", ["src/a.ts"])]).verdict).toBe("first-occurrence");
  });

  it("ignores a prior with a different signature", () => {
    const prior = rec("5479", "33626922676", ["src/b.ts"], "0000ffff0000ffff");
    expect(classify(rec("5486", "33683869984", ["src/a.ts"]), [prior]).verdict).toBe("first-occurrence");
  });

  it("refuses to call an unknown diff disjoint — an empty path set is missing evidence, not independence", () => {
    expect(pathsDisjoint([], ["src/a.ts"])).toBe(false);
    expect(pathsDisjoint(["src/a.ts"], [])).toBe(false);
    expect(pathsDisjoint(["src/a.ts"], ["src/b.ts"])).toBe(true);
    expect(pathsDisjoint(["src/a.ts"], ["src/a.ts"])).toBe(false);
    // A prior whose diff could not be computed must not manufacture a downgrade.
    const prior = rec("5479", "33626922676", []);
    expect(classify(rec("5486", "33683869984", ["src/a.ts"]), [prior]).verdict).toBe("overlapping-diff");
  });
});
