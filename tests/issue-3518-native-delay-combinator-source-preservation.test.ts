// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executeArm, validateArm } from "./helpers/native-delay-combinator-source-receipts.mjs";

const root = resolve(import.meta.dirname, "..");

describe("public-source execution preservation, not full-family physical acceptance", () => {
  it("executes eleven grounded artifacts / nineteen executions, with an explicit optional historical pair", async () => {
    const baseline = process.env.JS2WASM_DELAY_COMBINATOR_BASELINE_ROOT;
    mkdirSync(join(root, ".tmp"), { recursive: true });
    const directory = mkdtempSync(join(root, ".tmp", "delay-combinator-preservation-"));
    const after = await executeArm(root, "candidate", directory);
    let before;
    if (baseline !== undefined) {
      assert.notEqual(realpathSync(baseline), realpathSync(root), "historical root cannot be candidate");
      // Serial, never concurrent. The child independently pins baseline source
      // to 1cb0f5c7 (the complete prerequisite before this extraction).
      before = await executeArm(baseline, "baseline", directory);
    }
    validateArm(after, root);
    if (before) {
      validateArm(before, baseline);
      expect(after.fixtures).toEqual(before.fixtures);
      // Complete bytes, WAT, result/resource order, outcomes and actual values;
      // every execution also pins the exact bytes passed to instantiate.
      expect(after.rows).toEqual(before.rows);
    }
    writeFileSync(
      join(directory, "verdict.json"),
      JSON.stringify(
        {
          currentRootOracles: true,
          historicalPair: before ? "passed" : "NOT_RUN",
          artifacts: 11,
          executionsPerRoot: 19,
          familyScenarios: 8,
          physicalAcceptanceCertified: false,
          retirementCertified: false,
        },
        null,
        2,
      ),
    );
    console.log(
      `preservation-only: 11 artifacts / 19 executions; pair ${before ? "passed" : "NOT RUN (set JS2WASM_DELAY_COMBINATOR_BASELINE_ROOT explicitly)"}; evidence ${directory}; physical acceptance NOT CERTIFIED`,
    );
  }, 0);
});
