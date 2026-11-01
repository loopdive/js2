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
import { assembleHarnessBody, moduleInit } from "./helpers/harness-module-init.js";
import { lane, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

/** Compile `body` behind assert.js + sta.js, run `<module-init>`, and report whether the IR claimed it. */
async function runHarness(target: Target, body: string): Promise<boolean> {
  const result = await compile(assembleHarnessBody(body), {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as () => void)();
  return moduleInit(result)?.irBodyEmitted === true;
}

const CLAIMED: Record<string, string> = {
  trueArgument: "var x = true;\nassert.sameValue(x, true);",
  falseArgument: "var x = false;\nassert.sameValue(x, false);",
  flagWritten: "var executed = false;\nexecuted = true;\nassert.sameValue(executed, true);",
  comparisonInitializer: "var x = 1 < 2;\nassert.sameValue(x, true);",
  readInFunction: "var x = false;\nfunction k() { assert.sameValue(x, false); }\nk();",
  // The main twin of the shapes S5 reaches (#7037 round 3).
  comparisonOfVar: "var a = 3;\nvar b = a > 2;\nassert.sameValue(b, true);",
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
});
