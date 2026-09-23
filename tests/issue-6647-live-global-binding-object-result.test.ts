// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDogfoodScript } from "./dogfood/run-dogfood-script.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#6647 — a live-global-bound function declaration must not answer `null` for an object result", () => {
  // Measured on the branch base `ce58705b68` (file-copy revert of
  // `src/codegen/closures/method-trampolines.ts`, `.tmp/s69/witness-base.log`):
  //
  //   objectLiteral 0 · objectProperty -1 · arrayLiteral 0 · builtObject 0 ·
  //   calledFromNested 0        — and all four controls already 1.
  //
  // So this file FAILS on the base for exactly the five defect probes and the
  // controls cannot carry it green.
  it(
    "answers the object through the dynamic dispatcher when `eval` arms the live global binding",
    { timeout: 1_800_000 },
    async () => {
      const report = JSON.parse(await runDogfoodScript(join(HERE, "dogfood", "temporal-6647-harness.mjs"), ["--json"]));
      expect(report.provider.binaryBytes).toBeGreaterThan(1_000_000);
      const value = (label: string): unknown => {
        const probe = report.probes[label];
        return probe.status === "ok" ? probe.value : `${probe.status}: ${probe.error}`;
      };
      expect({
        objectLiteral: value("objectLiteral"),
        objectProperty: value("objectProperty"),
        arrayLiteral: value("arrayLiteral"),
        builtObject: value("builtObject"),
        calledFromNested: value("calledFromNested"),
        ctrlNoEval: value("ctrlNoEval"),
        ctrlApply: value("ctrlApply"),
        ctrlStringResult: value("ctrlStringResult"),
        ctrlTemporal: value("ctrlTemporal"),
      }).toEqual({
        objectLiteral: 1,
        objectProperty: 7,
        arrayLiteral: 1,
        builtObject: 1,
        calledFromNested: 1,
        ctrlNoEval: 1,
        ctrlApply: 1,
        ctrlStringResult: 1,
        ctrlTemporal: 1,
      });
    },
  );
});
