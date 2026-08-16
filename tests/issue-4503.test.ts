// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4503 — the IR BOOLEAN BRAND, and the one consumer that pays for it now.
//
// Before: a JS `boolean` and a native-annotated integer shared the IR's bare
// `i32` carrier, so once the checker family was gone the lowerer could not tell
// `${true}` from `${1}`. #4467 therefore had to keep REJECTING boolean template
// substitutions (its measured residual) — admitting them would have produced
// WRONG OUTPUT ("1"/"0") rather than a demote.
//
// After: `irBool()` brands the boolean-producing sites (literal, comparison,
// `!`, the equality folds) on the same `i32` carrier, and the template arm
// dispatches on the brand BEFORE the numeric conversion.
//
// The brand is deliberately ERASABLE under `irTypeEquals` (see the first
// describe block): that is what makes threading it through producers unable to
// create a new join mismatch or demotion — the backward-compatibility property
// this change rests on. It lives in `src/ir/boolean-brand.ts` together with the
// §7.1.17 ToString(Boolean) lowering that reads it.
//
// READING STRINGS BACK: the native lanes carry a string as an opaque
// `$AnyString` struct that JS cannot stringify at the export boundary, so every
// runtime assertion reconstructs the string through `.length` / `.charCodeAt`
// INSIDE wasm (same convention as tests/issue-4467.test.ts).

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { irBool, irTypeIsBoolean } from "../src/ir/boolean-brand.js";
import { irTypeEquals, irVal } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";

type LaneOptions = Record<string, unknown>;

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

/** One substitution per shape, so each pin reads exactly `String(value)`. */
const BOOLEAN_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["boolean param", "function fmt(b: boolean): string { return `v=${b}!`; }"],
  ["comparison", "function fmt(b: boolean): string { return `v=${b === true}!`; }"],
  ["logical not", "function fmt(b: boolean): string { return `v=${!!b}!`; }"],
  ["boolean local", "function fmt(b: boolean): string { const t: boolean = b; return `v=${t}!`; }"],
];

/** `fmt(v)` for a boolean `v`, read back through wasm-side length/charCodeAt. */
const HARNESS = `
export function flen(x: number): number { return fmt(x > 0).length; }
export function fcode(x: number, i: number): number { return fmt(x > 0).charCodeAt(i); }
`;

describe("#4503 IR boolean brand", () => {
  describe("the brand itself", () => {
    it("marks a boolean-carrying i32 and nothing else", () => {
      expect(irTypeIsBoolean(irBool())).toBe(true);
      expect(irTypeIsBoolean(irVal({ kind: "i32" }))).toBe(false);
      expect(irTypeIsBoolean(irVal({ kind: "f64" }))).toBe(false);
      expect(irTypeIsBoolean({ kind: "string" })).toBe(false);
    });

    it("does NOT change the value representation — still the i32 carrier", () => {
      const t = irBool();
      expect(t.kind).toBe("val");
      expect(t.kind === "val" && t.val.kind).toBe("i32");
    });

    it("is ERASABLE under irTypeEquals, so it cannot create a new join mismatch", () => {
      // This is the backward-compatibility property, not an accident: a branded
      // and an unbranded i32 stay interchangeable at joins/slot writes/verify,
      // so branding a producer can only add information a consumer may read —
      // never reject something that used to type-check. A new `bool` IrType arm
      // would have been STRICT here and broken exactly those joins.
      expect(irTypeEquals(irBool(), irVal({ kind: "i32" }))).toBe(true);
      expect(irTypeEquals(irVal({ kind: "i32" }), irBool())).toBe(true);
      expect(irTypeEquals(irBool(), irVal({ kind: "f64" }))).toBe(false);
    });
  });

  describe.each(LANES)("lane %s", (laneName, laneOptions) => {
    it.each(BOOLEAN_SHAPES)("AC#1: %s claims (was template-substitution-unsupported)", async (_shape, fmtSrc) => {
      const result = await compileLane(`${fmtSrc}${HARNESS}`, laneOptions, true);
      expect(result.success).toBe(true);
      const outcome = outcomeOf(result, "fmt");
      expect(outcome, `no IR outcome for fmt in lane ${laneName}`).toBeDefined();
      expect(outcome!.kind).toBe("emitted");
    });

    it("AC#2: §7.1.17 ToString(Boolean) — the spelling is true/false, never 1/0", async () => {
      const exports = await instantiate(await compileLane(`${BOOLEAN_SHAPES[0]![1]}${HARNESS}`, laneOptions, true));
      expect(readString(exports, "flen", "fcode", [1])).toBe(`v=${true}!`);
      expect(readString(exports, "flen", "fcode", [-1])).toBe(`v=${false}!`);
    });

    it("AC#3: IR and legacy agree on every boolean shape (dual run)", async () => {
      for (const [shape, fmtSrc] of BOOLEAN_SHAPES) {
        const ir = await instantiate(await compileLane(`${fmtSrc}${HARNESS}`, laneOptions, true));
        const legacy = await instantiate(await compileLane(`${fmtSrc}${HARNESS}`, laneOptions, false));
        for (const x of [1, -1]) {
          expect(readString(ir, "flen", "fcode", [x]), `${shape} @ ${x}`).toBe(
            readString(legacy, "flen", "fcode", [x]),
          );
        }
      }
    });

    it("AC#4: booleans, numbers and strings mix in ONE template without cross-talk", async () => {
      // The load-bearing case: `${n}` and `${b}` are the same i32/f64 machinery
      // away from each other, and `${s.length}` is an i32-CARRIED NUMBER — it
      // must still print its digits, not "true"/"false".
      const src = `
function mixed(s: string, n: number, b: boolean): string { return \`\${s}|\${n}|\${b}|\${!b}|\${true}|\${false}|\${s.length}\`; }
export function mlen(x: number): number { return mixed("ab", x, x > 0).length; }
export function mcode(x: number, i: number): number { return mixed("ab", x, x > 0).charCodeAt(i); }
`;
      const result = await compileLane(src, laneOptions, true);
      expect(result.success).toBe(true);
      expect(outcomeOf(result, "mixed")?.kind).toBe("emitted");
      const exports = await instantiate(result);
      for (const x of [1, -3.5]) {
        const b = x > 0;
        expect(readString(exports, "mlen", "mcode", [x])).toBe(`ab|${x}|${b}|${!b}|${true}|${false}|2`);
      }
    });

    it("AC#5: the NUMERIC path is untouched — an i32-carried number still prints digits", async () => {
      // #4467's `${s.length}` arm, re-pinned here because the brand dispatch
      // now runs in front of it: a plain (unbranded) i32 must keep taking the
      // number→string provider.
      const src = `
function numeric(s: string, n: number): string { return \`\${s.length}/\${n}\`; }
export function nlen(x: number): number { return numeric("abc", x).length; }
export function ncode(x: number, i: number): number { return numeric("abc", x).charCodeAt(i); }
`;
      const result = await compileLane(src, laneOptions, true);
      expect(outcomeOf(result, "numeric")?.kind).toBe("emitted");
      const exports = await instantiate(result);
      for (const x of [0, 1, -1, 3.5, NaN, Infinity]) {
        expect(readString(exports, "nlen", "ncode", [x])).toBe(`3/${x}`);
      }
    });
  });

  describe("boundaries that must keep rejecting", () => {
    it("an OBJECT substitution still rejects at template-substitution-unsupported", async () => {
      const src = `
class P { x: number; constructor(x: number) { this.x = x; } }
function o(p: P): string { return \`v=\${p}!\`; }
export function olen(x: number): number { return o(new P(x)).length; }
`;
      const outcome = outcomeOf(await compileLane(src, {}, true), "o");
      expect(outcome?.kind).toBe("unsupported");
      expect(outcome?.code).toBe("template-substitution-unsupported");
    });

    it("an `any` substitution still rejects — ToPrimitive is not the IR's", async () => {
      const src = `
function u(v: any): string { return \`v=\${v}!\`; }
export function ulen(x: number): number { return u(x).length; }
`;
      const outcome = outcomeOf(await compileLane(src, {}, true), "u");
      expect(outcome?.kind).toBe("unsupported");
      expect(outcome?.code).toBe("template-substitution-unsupported");
    });
  });
});
