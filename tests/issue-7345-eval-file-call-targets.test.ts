// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7345 — in a file that contains `eval`, a top-level function stays a direct-call
// target unless evaluated code may rebind it (the runtime-eval plan's
// `reassignedFunctionDeclarations`). A function that reaches a binding eval may
// replace is refused at select, never claimed and then withdrawn at preparation.
// Standalone only: the JS environment keeps its earlier answer.
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

// The refusal rows assert the selector's detail, which it records only under this diagnostic.
const previous = vi.hoisted(() => {
  const value = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  return value;
});
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
  else process.env.JS2WASM_IR_SHAPE_DIAG = previous;
});

async function build(source: string, lane: "standalone" | "gc"): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7345.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    experimentalIR: true,
    ...(lane === "standalone" ? { target: "standalone" } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

function outcome(result: CompileResult, unit: string) {
  return (result.irOutcomes ?? []).find((row) => row.displayName === unit);
}

/** `fmt` calls `isNeg`, as assert.js's `formatIdentityFreeValue` calls `isNegativeZero`. */
const HELPERS = `function isNeg(v) { return v === 0 && 1 / v < 0; }
function fmt(v) { if (isNeg(v)) { return "-0"; } return "n"; }
var r = fmt(1);
`;

/** Evaluated code may rebind `isNeg`: its caller keeps the refusal (acceptance criterion 3). */
const MAY_REBIND: Record<string, string> = {
  "a literal eval source that names the function": `${HELPERS}eval("isNeg = function () { return true; };");`,
  "an eval source no scan can read": `${HELPERS}var src = "var z = 2;"; eval(src);`,
  "a direct assignment to the function's name": `${HELPERS}isNeg = function () { return true; }; eval("var y = 1;");`,
};

describe("#7345 — function call targets in a file that contains eval", () => {
  it("claims the helpers when the eval source cannot rebind them", async () => {
    const ir = await build(`${HELPERS}eval("var y = 1;");`, "standalone");
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    for (const unit of ["isNeg", "fmt", "<module-init>"]) {
      expect(outcome(ir, unit)?.irBodyEmitted, unit).toBe(true);
    }
  });

  for (const [name, source] of Object.entries(MAY_REBIND)) {
    it(`refuses the caller at select: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const row = outcome(ir, "fmt");
      expect(row).toMatchObject({ stage: "select", irBodyEmitted: false });
      expect(row?.detail).toContain("fn-runtime-eval-boundary");
    });
  }

  it("keeps the JS environment's earlier answer", async () => {
    const gc = await build(`${HELPERS}eval("var y = 1;");`, "gc");
    expect(outcome(gc, "fmt")).toMatchObject({ irBodyEmitted: false, code: "external-call" });
  });
});
