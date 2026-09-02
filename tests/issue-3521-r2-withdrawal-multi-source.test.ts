// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3521 R2-T1 (b) — the multi-source overlay driver's own withdrawal reason.
//
// Its own file, not part of `tests/issue-3521-r2-withdrawal-shapes.test.ts`,
// purely for memory: `compileFiles` builds a whole-program `ts.Program`, which
// costs ~90 MB more heap than any single-source case (measured 2026-09-02:
// 470 MB → 558 MB), and a vitest fork has 512 MB (`vitest.config.ts:5`).
//
// The pin is that the reason is a property of the DRIVER, not of any predicate:
// the R2 owner selector never runs on this lane, so every compile-twice row it
// produces carries `not-attempted:multi-source-driver` — across BOTH sources of
// the graph, because unit ids are source-qualified and one ctx map spans them.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compileFiles } from "../src/index.js";
import { r2WithdrawalOf } from "../src/ir/r2-withdrawal.js";

// Register the low-level codegen delegates used by the compile path below.
import "../src/codegen/expressions.js";

describe("#3521 R2 withdrawal telemetry — the multi-source driver", () => {
  it("not-attempted:multi-source-driver on every compile-twice row of a two-file host graph", async () => {
    const entry = fileURLToPath(new URL("./fixtures/issue-3521-r2-multi-entry.ts", import.meta.url));
    const result = await compileFiles(entry, { trackIrOutcomes: true });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const compileTwice = (result.irOutcomes ?? []).filter(
      (row) => row.unitKind === "function" && row.directBodyEmissions === 1 && row.irBodyEmissions === 1,
    );
    expect(compileTwice.length).toBeGreaterThan(0);
    for (const row of compileTwice) {
      expect(r2WithdrawalOf(row), `row ${row.displayName}`).toEqual({
        stage: "not-attempted",
        reason: "multi-source-driver",
      });
    }
    // Both sources' rows carry it — unit ids are source-qualified, so one ctx
    // map spans the whole graph.
    expect(compileTwice.map((row) => row.displayName).sort()).toEqual(["entryAdd", "helper"]);
  });
});
