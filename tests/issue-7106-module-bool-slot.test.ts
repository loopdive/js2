// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a script `var` that holds a boolean lives in an `i32` module slot,
// the resolver's boolean value kind. A read carries the boolean brand, so a
// consumer that needs the carrier (`assert.sameValue(x, true)`) boxes it as a
// boolean. It used to read back as a bare `i32`: the unit was claimed and then
// withdrawn ("function member operand has no canonical carrier").

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { assembleHarnessBody, runHarnessOn as runHarness } from "./helpers/harness-module-init.js";
import { lane, TARGETS } from "./helpers/ambient-intrinsic-probe.js";

const CLAIMED: Record<string, string> = {
  trueArgument: "var x = true;\nassert.sameValue(x, true);",
  falseArgument: "var x = false;\nassert.sameValue(x, false);",
  flagWritten: "var executed = false;\nexecuted = true;\nassert.sameValue(executed, true);",
  comparisonInitializer: "var x = 1 < 2;\nassert.sameValue(x, true);",
  readInFunction: "var x = false;\nfunction k() { assert.sameValue(x, false); }\nk();",
  // The main twin of the shapes S5 reaches (#7037 round 3).
  comparisonOfVar: "var a = 3;\nvar b = a > 2;\nassert.sameValue(b, true);",
  // The selector names the slot `boolean`, as the brand does.
  objectIs: "var x = true;\nassert.sameValue(Object.is(x, true), true);",
};

// ToNumber of a boolean is its 0 or 1, so a numeric consumer converts the
// branded read as it converted main's bare `i32`, and keeps main's claim.
const NUMERIC_CONSUMERS: Record<string, string> = {
  numberResult: "let flag = true;\nexport function t(): number { return flag; }",
  compoundField:
    "let flag = true;\nclass C { n = 1; bump(): number { this.n += flag as unknown as number; return this.n; } }\n" +
    "export function t(): number { return new C().bump(); }",
};

// Not a module binding on this branch; it must still never withdraw a claim.
const S5_BOOLEAN_LEAF = "var { x } = { x: true };\nassert.sameValue(x, true);";

describe("#7106 boolean module slot", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      for (const [name, body] of Object.entries(CLAIMED)) {
        it(`claims and runs: ${name}`, async () => {
          expect(await runHarness(target, body)).toBe(true);
        });
      }
      it("withdraws no claim: the S5 boolean leaf", async () => {
        await runHarness(target, S5_BOOLEAN_LEAF);
      });
    });
  }
  for (const [name, source] of Object.entries(NUMERIC_CONSUMERS)) {
    it(`a numeric consumer converts the read on standalone: ${name}`, async () => {
      const result = await compile(source, {
        fileName: "t.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.irOutcomes?.find((outcome) => outcome.displayName === "t")?.irBodyEmitted).toBe(true);
    });
  }
});

describe("#7106 Boolean module-slot receiving boundaries", () => {
  for (const target of TARGETS) {
    describe(lane(target), () => {
      // A plain write stores the value itself; only ToNumber consumers convert it.
      it("keeps a boolean written to a number field", async () => {
        // Main withdraws `k` after its claim ("assignment to .n (f64) got
        // i32"), so this pins the answer and that `k` is not emitted by the IR.
        const body = "function k(b: boolean): any { var o = { n: 1 }; o.n = b as any; return o.n; }\n";
        const result = await compile(assembleHarnessBody(`${body}assert.sameValue(k(true), true);`), {
          fileName: "test.ts",
          allowJs: true,
          skipSemanticDiagnostics: true,
          trackIrOutcomes: true,
          deferTopLevelInit: true,
          ...(target ? { target } : {}),
        });
        expect(result.irOutcomes?.find((unit) => unit.displayName === "k")?.irBodyEmitted).toBe(false);
        const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
        const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
        (instance.exports.__module_init as () => void)();
      });

      it("converts a boolean compound operand on both lanes", async () => {
        await runHarness(
          target,
          "var flag = true;\nfunction k() { var o = { n: 1 }; o.n += flag; return o.n; }\nassert.sameValue(k(), 2);",
          "test.js",
          ["k"],
        );
      });

      it("preserves Boolean template spelling", async () => {
        await runHarness(target, 'var flag = true; assert.sameValue(`${flag}`, "true");');
      });

      it("preserves Boolean Number conversion", async () => {
        await runHarness(target, "var flag = true; assert.sameValue(Number(flag), 1); assert.sameValue(flag + 2, 3);");
      });

      it("keeps native i32 values distinct from Boolean slots", async () => {
        await runHarness(
          target,
          'type i32 = number; var word: i32 = 1; assert.sameValue(typeof word, "number"); assert.sameValue(word, 1);',
          "test.ts",
        );
      });

      it("matches the existing declared numeric-return ABI without withdrawing IR", async () => {
        // Intentionally invalid TS, compiled with the unchanged diagnostic-skip
        // option: this checks the existing ABI conversion, not TS conformance.
        await runHarness(
          target,
          "var flag = true; function bad(): number { return flag; } assert.sameValue(bad(), 1);",
          "test.ts",
          ["bad"],
        );
      });
    });
  }
});
