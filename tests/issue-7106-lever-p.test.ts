// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #7106 lever P: `String.prototype.<m>.call(r, …)` on the ambient `String`,
// with `r` a proven string, number or boolean, is `String(r).<m>(…)` and is
// claimed by the IR through the string-method surface. A receiver that may be
// nullish, an object or a wrapper, and `.apply`, stay on the legacy boundary.
// Each row's expected value is the JS engine's answer, recorded with the row.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

type CompileTarget = undefined | "standalone";

type Row = readonly [expression: string, expected: string | number];

/** Each claimed row: the borrow, compared in Wasm against the engine's answer. */
const CLAIMED: Record<string, Row> = {
  trimBoolean: ["String.prototype.trim.call(true)", "true"],
  trimFalse: ["String.prototype.trim.call(false)", "false"],
  trimNegativeZero: ["String.prototype.trim.call(-0)", "0"],
  trimLargeNumber: ["String.prototype.trim.call(1e21)", "1e+21"],
  trimFraction: ["String.prototype.trim.call(123.1234567)", "123.1234567"],
  trimNaN: ["String.prototype.trim.call(NaN)", "NaN"],
  trimString: ['String.prototype.trim.call("  ab\\n ")', "ab"],
  charAtNumber: ["String.prototype.charAt.call(12345, 2)", "3"],
  indexOfBoolean: ['String.prototype.indexOf.call(true, "u")', 2],
  sliceNumber: ["String.prototype.slice.call(1e21, 0, 2)", "1e"],
};

const REFUSED: Record<string, Row> = {
  nullReceiver: [
    "(function () { try { String.prototype.trim.call(null); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } })()",
    1,
  ],
  wrapperReceiver: ['String.prototype.trim.call(new String(" s "))', "s"],
  applyBorrow: ['String.prototype.trim.apply("  a ")', "a"],
};

function source(cases: Record<string, Row>): string {
  return Object.entries(cases)
    .map(
      ([name, [expr, expected]]) =>
        `export function ${name}(): number { return ${expr} === ${JSON.stringify(expected)} ? 1 : 0; }`,
    )
    .join("\n");
}

async function instantiate(result: CompileResult): Promise<Record<string, () => unknown>> {
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return instance.exports as Record<string, () => unknown>;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((entry) => entry.displayName === name);
}

async function compileTarget(text: string, target: CompileTarget): Promise<CompileResult> {
  const result = await compile(text, {
    fileName: "issue-7106-lever-p.ts",
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

describe("#7106 lever P — String.prototype borrow over a primitive receiver", () => {
  it.each<CompileTarget>([undefined, "standalone"])("claims the borrow and answers as JS (%s)", async (target) => {
    const result = await compileTarget(source(CLAIMED), target);
    const exports = await instantiate(result);
    for (const name of Object.keys(CLAIMED)) {
      expect(outcome(result, name), name).toMatchObject({ irBodyEmitted: true });
      expect(exports[name]!(), name).toBe(1);
    }
  });

  it.each<CompileTarget>([undefined, "standalone"])("keeps other receivers and .apply legacy (%s)", async (target) => {
    const result = await compileTarget(source(REFUSED), target);
    const exports = await instantiate(result);
    for (const name of Object.keys(REFUSED)) {
      expect(outcome(result, name)?.irBodyEmitted, name).not.toBe(true);
      expect(exports[name]!(), name).toBe(1);
    }
  });
});
