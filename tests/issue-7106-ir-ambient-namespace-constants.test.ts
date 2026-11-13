// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 module-init lever A — `Number.<CONST>` / `Math.<CONST>` on the
// unshadowed ambient namespace folds, in the IR, to the SAME constant legacy's
// dot read emits (`builtinNamespaceConstantValue`, one table). The 80-file
// census on the integrated stack put `expr-ident-not-in-scope «Number»` first
// among the `<module-init>` blockers (37 of 71). A shadowed name never folds.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

type Lane = "standalone" | "default";

function node(source: string): number {
  return new Function(`${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

async function compileOn(source: string, lane: Lane): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    ...(lane === "standalone" ? { target: "standalone" } : {}),
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    experimentalIR: true,
    emitWat: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function run(result: CompileResult, lane: Lane): Promise<number> {
  const imports = (lane === "standalone" ? {} : result.importObject) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.irBodyEmitted).map((o) => o.displayName);
}

const PROGRAM = `
function big(x) { return x > Number.MAX_VALUE / 2; }
function inf(x) { return x === Number.POSITIVE_INFINITY || x === Number.NEGATIVE_INFINITY; }
function nan() { return Number.NaN; }
function area(r) { return Math.PI * r * r; }
function safe(x) { return x <= Number.MAX_SAFE_INTEGER && x >= Number.MIN_SAFE_INTEGER; }
export function run() {
  var n = 0;
  if (big(Number.MAX_VALUE)) n += 1;
  if (!big(1)) n += 2;
  if (inf(1 / 0) && inf(-1 / 0) && !inf(5)) n += 4;
  if (nan() !== nan()) n += 8;
  if (area(2) === Math.PI * 4) n += 16;
  if (safe(9007199254740991) && !safe(9007199254740992)) n += 32;
  if (Number.EPSILON === Math.pow(2, -52) && Number.MIN_VALUE === 5e-324) n += 64;
  if (Math.LN2 > 0.69 && Math.LN2 < 0.7 && Math.SQRT2 > 1.41 && Math.SQRT1_2 < 0.71) n += 128;
  return n;
}`;

const SHADOWED = `
var Number = { MAX_VALUE: 7, NaN: 8 };
function viaModuleShadow() { return Number.MAX_VALUE + Number.NaN; }
export function run() { return viaModuleShadow() === 15 ? 1 : 0; }`;

// Prototype keys are not constants: `builtinNamespaceConstantValue` reads the
// tables with `Object.hasOwn`. Legacy's reflective read used `in`, so
// `Math["constructor"]` emitted `f64.const` of a stringified function (NaN at
// runtime, so the identity test answered 0); node answers 1. A dot read of the
// same name takes the method path, unchanged.
const PROTOTYPE_KEYS = `
export function run() {
  var mathCtor = Math["constructor"];
  return mathCtor === Object ? 1 : 0;
}`;

describe("#7106 — ambient Number/Math constants fold in the IR", () => {
  for (const lane of ["standalone", "default"] as const) {
    it(`folds to legacy's constants and answers like node (${lane})`, async () => {
      const expected = node(PROGRAM);
      expect(expected).toBe(255);
      const result = await compileOn(PROGRAM, lane);
      expect(irBodies(result)).toEqual(expect.arrayContaining(["big", "inf", "nan", "area", "safe"]));
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(await run(result, lane)).toBe(expected);
    });
  }

  for (const lane of ["standalone", "default"] as const) {
    it(`legacy's reflective read does not fold a prototype key (${lane})`, async () => {
      const result = await compileOn(PROTOTYPE_KEYS, lane);
      expect(irBodies(result)).toEqual([]);
      expect(await run(result, lane)).toBe(node(PROTOTYPE_KEYS));
    });
  }

  it("never folds through a module-level shadow", async () => {
    // The IR declines the function (a member read on a module binding is not
    // its slice); it must not have folded the read. Legacy's own dot read DOES
    // fold it (wrong: node answers 15) — a pre-existing legacy defect, filed
    // separately, so legacy's answer is not asserted here.
    const result = await compileOn(SHADOWED, "standalone");
    expect(irBodies(result)).not.toContain("viaModuleShadow");
    expect(node(SHADOWED)).toBe(1);
  });
});
