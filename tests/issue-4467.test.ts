// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4467 — NUMERIC template-literal substitutions in the IR front-end.
//
// Before: the selector's `ts.isTemplateExpression` arm admitted only
// checker-`string` substitutions, so `` `a${n}b` `` rejected at
// `template-substitution-unsupported` and demoted the whole enclosing function
// to legacy — in EVERY lane (measured 2026-08-15 on 9e17d34f).
//
// After: `string` OR `number` claims, and a numeric substitution lowers
// through `IR_NUMBER_TO_STRING_FN`, whose provider is per-lane
// (src/ir/number-to-string-provider.ts): the `env.number_toString` import in
// host mode, the #3912 native formatter behind a `(f64) -> (ref $AnyString)`
// carrier thunk in the native lanes.
//
// READING THE RESULT BACK: the native lanes carry a string as an opaque
// `$AnyString` struct, which JS cannot stringify at the export boundary. That
// is an export-ABI question, not a template-lowering one, so every runtime
// assertion here reconstructs the string through `.length` / `.charCodeAt`
// INSIDE wasm. Returning the string directly would fail on native lanes for
// reasons that have nothing to do with this change.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type LaneOptions = Record<string, unknown>;

/** The three lanes this change has to satisfy — two string carriers, two number formatters. */
const LANES: ReadonlyArray<readonly [string, LaneOptions]> = [
  ["host", {}],
  ["nativeStrings", { nativeStrings: true }],
  ["standalone", { target: "standalone" }],
];

async function compileLane(src: string, lane: LaneOptions, experimentalIR: boolean): Promise<CompileResult> {
  return await compile(src, {
    fileName: "t.ts",
    experimentalIR,
    trackIrOutcomes: true,
    ...lane,
  } as Parameters<typeof compile>[1]);
}

type IrOutcomeLike = { displayName?: unknown; kind?: unknown; code?: unknown };

function outcomeOf(result: CompileResult, name: string): IrOutcomeLike | undefined {
  return (result.irOutcomes as readonly IrOutcomeLike[] | undefined)?.find((o) => o.displayName === name);
}

async function instantiate(result: CompileResult): Promise<Record<string, (...args: number[]) => number>> {
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, (...args: number[]) => number>;
}

/** Rebuild the wasm-side string one code unit at a time — see the file header. */
function readString(
  exports: Record<string, (...args: number[]) => number>,
  lenFn: string,
  codeFn: string,
  args: readonly number[],
): string {
  const length = exports[lenFn]!(...args);
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(exports[codeFn]!(...args, i));
  return out;
}

// One substitution, so the special-value pins read exactly `String(n)`.
const FMT_SRC = `
function fmt(n: number): string { return \`v=\${n}!\`; }
export function flen(n: number): number { return fmt(n).length; }
export function fcode(n: number, i: number): number { return fmt(n).charCodeAt(i); }
`;

// §7.1.17 Number::toString edge cases. Expectations come from node's own
// template evaluation (`\`v=\${v}!\``), not from a hand-written table, so the
// pin cannot drift away from the spec the host implements.
const SPECIAL_VALUES: readonly number[] = [
  0,
  -0, // §6.1.6.1.13 step 2: -0 stringifies as "0", NOT "-0"
  1,
  -1,
  42,
  3.5,
  -3.5,
  0.1, // shortest-roundtrip, not the full binary expansion
  1e21, // the fixed → exponential threshold
  1e-7, // the small-magnitude exponential threshold
  123456789012345680, // integer beyond 2^53 exactness
  2 ** 31, // past i32 range — must not wrap
  NaN,
  Infinity,
  -Infinity,
];

describe("#4467 IR numeric template-literal substitutions", () => {
  describe.each(LANES)("lane %s", (laneName, laneOptions) => {
    it("AC#1: a numeric substitution is IR-claimed (was template-substitution-unsupported)", async () => {
      const result = await compileLane(FMT_SRC, laneOptions, true);
      expect(result.success).toBe(true);
      const outcome = outcomeOf(result, "fmt");
      expect(outcome, `no IR outcome for fmt in lane ${laneName}`).toBeDefined();
      expect(outcome!.kind).toBe("emitted");
    });

    it("AC#3: §7.1.17 special values match node exactly", async () => {
      const exports = await instantiate(await compileLane(FMT_SRC, laneOptions, true));
      for (const value of SPECIAL_VALUES) {
        expect(readString(exports, "flen", "fcode", [value]), `value ${String(value)}`).toBe(`v=${value}!`);
      }
    });

    it("AC#5: IR and legacy agree on every covered value (dual run)", async () => {
      const ir = await instantiate(await compileLane(FMT_SRC, laneOptions, true));
      const legacy = await instantiate(await compileLane(FMT_SRC, laneOptions, false));
      for (const value of SPECIAL_VALUES) {
        expect(readString(ir, "flen", "fcode", [value]), `value ${String(value)}`).toBe(
          readString(legacy, "flen", "fcode", [value]),
        );
      }
    });

    it("AC#2: mixed string+number, multi-substitution, expression and i32-carried operands all claim and run", async () => {
      // `s.length` is the i32-carried numeric operand: it reaches the concat
      // chain through the same seam without a `number`-annotated binding.
      const src = `
function mixed(s: string, a: number, b: number): string { return \`[\${s}] \${a}+\${b}=\${a + b} (\${s.length})\`; }
export function mlen(a: number, b: number): number { return mixed("ab", a, b).length; }
export function mcode(a: number, b: number, i: number): number { return mixed("ab", a, b).charCodeAt(i); }
`;
      const result = await compileLane(src, laneOptions, true);
      expect(result.success).toBe(true);
      expect(outcomeOf(result, "mixed")?.kind).toBe("emitted");
      const exports = await instantiate(result);
      for (const [a, b] of [
        [1, 2],
        [-3, 0.5],
        [1e21, NaN],
      ]) {
        expect(readString(exports, "mlen", "mcode", [a!, b!])).toBe(`[ab] ${a}+${b}=${a! + b!} (2)`);
      }
    });

    it("AC#4: a BOOLEAN substitution claims since #4503 (this issue's residual, now retired)", async () => {
      // #4467 deliberately rejected this: a boolean shares IR's `i32` carrier
      // with a native-annotated number, so admitting it would have made
      // `${true}` and `${1}` indistinguishable to the lowerer — WRONG OUTPUT,
      // not a demote. #4503 added the IR boolean BRAND on that carrier, so the
      // lowerer can now tell them apart and the residual is retired. The
      // numeric arm this issue owns is unchanged: `${1}` still prints "1".
      const src = `
function b(v: boolean): string { return \`v=\${v}!\`; }
export function blen(v: number): number { return b(v > 0).length; }
`;
      const result = await compileLane(src, laneOptions, true);
      expect(result.success).toBe(true);
      expect(outcomeOf(result, "b")?.kind).toBe("emitted");
    });
  });

  it("AC#4: an OBJECT substitution still rejects at template-substitution-unsupported", async () => {
    // The other side of the boundary: object/`any` substitutions need a
    // ToPrimitive walk the IR does not own, and they must not be swept in by
    // the widened family test.
    const src = `
class P { x: number; constructor(x: number) { this.x = x; } }
function o(p: P): string { return \`v=\${p}!\`; }
export function olen(x: number): number { return o(new P(x)).length; }
`;
    const result = await compileLane(src, {}, true);
    expect(result.success).toBe(true);
    const outcome = outcomeOf(result, "o");
    expect(outcome?.kind).toBe("unsupported");
    expect(outcome?.code).toBe("template-substitution-unsupported");
  });
});
