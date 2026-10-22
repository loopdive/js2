// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 module-init lever B — `Number(v)` under the source-bound conversion
// plan lowers through the IR's `js.number.from-value` intrinsic, whose
// host-free provider `__ir_number_from_value` is legacy's own `Number(v)`
// emission over a detached template (full ToNumeric: ToPrimitive, Symbol
// TypeError, StringToNumber). The 80-file census put `Number(…)` in 37 of the
// 71 `<module-init>` blockers. The plan keeps holding beside `Number.<CONST>`
// reads and `new Number(…)`; a rebound `Number` never takes the intrinsic.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

function node(source: string): number {
  return new Function(`${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

async function compileStandalone(source: string): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    experimentalIR: true,
    emitWat: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

async function run(result: CompileResult): Promise<number> {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.irBodyEmitted).map((o) => o.displayName);
}

const DYNAMIC = `
function conv(x) { return Number(x); }
export function run() {
  var n = 0;
  if (conv({ valueOf: function () { return 7; } }) === 7) n += 1;
  if (conv([5]) === 5) n += 2;
  if (conv("0x10") === 16) n += 4;
  if (conv(null) === 0) n += 8;
  if (conv(undefined) !== conv(undefined)) n += 16;
  if (conv(true) === 1) n += 32;
  if (conv("abc") !== conv("abc")) n += 64;
  if (conv(new Number(9)) === 9) n += 128;
  if (conv({ toString: function () { return "12"; } }) === 12) n += 256;
  var threw = 0; try { conv(Symbol()); } catch (e) { threw = e instanceof TypeError ? 1 : 2; }
  if (threw === 1) n += 512;
  if (conv([]) === 0 && conv([1, 2]) !== conv([1, 2])) n += 1024;
  return n;
}`;

// Every conversion sits in <module-init> beside Number.<CONST> reads, as the
// census tests do; `run` only reads the results. (Module goal: `const` — a
// script-goal `var` is the #7114 slice's business, not this one's.)
const MODULE_INIT = `
const a = Number("0x10") + Number(" 42 ") + Number("") + Number(true) + Number(false) + Number(null);
const b = Number();
const c = Number(Number.MAX_VALUE) === Number.MAX_VALUE && Number(Number.NaN) !== Number(Number.NaN);
const d = Number(-0) === 0 && 1 / Number(-0) === Number.NEGATIVE_INFINITY;
export function run() { var n = 0; if (a === 59) n += 1; if (b === 0) n += 2; if (c) n += 4; if (d) n += 8; return n; }`;

const REBOUND = `
var Number = function (x) { return 7; };
function viaShadow(x) { return Number(x); }
export function run() { return viaShadow("1") === 7 ? 1 : 0; }`;

describe("#7106 — Number(v) lowers through the host-free js.number.from-value provider", () => {
  it("a dynamic operand takes the full ToNumeric protocol and answers like node", async () => {
    const expected = node(DYNAMIC);
    expect(expected).toBe(2047);
    const result = await compileStandalone(DYNAMIC);
    expect(irBodies(result)).toContain("conv");
    expect(result.wat ?? "").toContain("__ir_number_from_value");
    expect(await run(result)).toBe(expected);
  });

  it("<module-init> conversions beside Number.<CONST> reads ship an IR body", async () => {
    const expected = node(MODULE_INIT);
    expect(expected).toBe(15);
    const result = await compileStandalone(MODULE_INIT);
    expect(irBodies(result)).toContain("<module-init>");
    expect(await run(result)).toBe(expected);
  });

  it("a rebound Number never takes the intrinsic", async () => {
    // The plan is invalidated, so nothing claims the call. (Legacy's own
    // by-name `Number(x)` arm still converts here — node answers 7 — a
    // pre-existing legacy defect recorded in the issue, not asserted.)
    const result = await compileStandalone(REBOUND);
    expect(result.wat ?? "").not.toContain("__ir_number_from_value");
    expect(irBodies(result)).not.toContain("viaShadow");
    expect(node(REBOUND)).toBe(1);
  });
});
