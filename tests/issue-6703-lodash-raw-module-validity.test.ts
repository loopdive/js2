// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6703 — lodash standalone-dynamic reported `optimization-error` because the
 * RAW module was invalid; `wasm-opt -O4` only relayed the validator's verdict.
 * Two independent codegen bugs, each reduced here to a minimal program:
 *
 * 1. `return_call` arguments were never attributed by the exact forward stack
 *    model, so the one-instruction-per-argument backward walk in `fixups.ts`
 *    paired a bare dynamic call's `ref.null extern` (the `__current_this`
 *    reset) with a struct-typed parameter and retyped it — `global.set`
 *    of an `externref` global then received `ref.null $struct` (lodash
 *    `baseUpdate`, plus five closure-struct `struct.new` operands).
 * 2. The no-op arm of `Array.prototype.sort` (non-numeric elements whose
 *    comparator is not a compilable closure) `local.tee`d the receiver without
 *    consuming it, leaving an extra vec on the stack that shifted every operand
 *    of the enclosing call by one (lodash `pullAt` → `basePullAt`).
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { locateCallArgProducers } from "../src/codegen/call-arg-producers.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

async function laneBinary(source: string, fileName: string, target: "standalone" | "gc"): Promise<Uint8Array> {
  const result = await compile(source, { target, allowJs: true, fileName });
  expect(result.success).toBe(true);
  expect(result.binary?.length ?? 0).toBeGreaterThan(0);
  return result.binary!;
}

function validationError(binary: Uint8Array): string | null {
  try {
    new WebAssembly.Module(binary);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const TYPED_TAIL_CALL_WITH_BARE_DYNAMIC_ARG = `
function sink(a1: number[], a2: number[], a3: number[], a4: number[], a5: number[], a6: number[], a7: number[], a8: number[], v: any): any {
  if (a1.length > 100) return sink(a2, a3, a4, a5, a6, a7, a8, a1, v);
  return v;
}
export function run(xs: number[], updater: any): any {
  return sink(xs, xs, xs, xs, xs, xs, xs, xs, updater(xs.length));
}
`;

const NOOP_SORT_AS_CALL_ARGUMENT = `
function pick(n: number, xs: any[]): number {
  let total = n;
  for (let i = 0; i < xs.length; i++) total += i;
  if (n > 100) return pick(n - 1, xs);
  return total;
}
export function run(xs: any[], cmp: any): number {
  const r = pick(1, xs.map((x) => x).sort(cmp));
  return r + 1;
}
`;

describe("#6703 lodash standalone raw-module validity", () => {
  for (const target of ["standalone", "gc"] as const) {
    it(`keeps a bare dynamic call's receiver reset externref inside a tail call (${target})`, async () => {
      const binary = await laneBinary(TYPED_TAIL_CALL_WITH_BARE_DYNAMIC_ARG, "tail.ts", target);
      expect(validationError(binary)).toBeNull();
    });

    it(`leaves exactly one value for a no-op sort used as a call argument (${target})`, async () => {
      const binary = await laneBinary(NOOP_SORT_AS_CALL_ARGUMENT, "sort.ts", target);
      expect(validationError(binary)).toBeNull();
    });
  }

  it("attributes return_call arguments exactly across a global.set", () => {
    const mod = {
      imports: [],
      types: [
        { kind: "struct", fields: [] },
        { kind: "func", params: [{ kind: "ref_null", typeIdx: 0 }, { kind: "externref" }], results: [] },
      ],
      functions: [{ name: "callee", typeIdx: 1, locals: [], body: [] }],
    } as unknown as WasmModule;
    const instrs: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.null.extern" },
      { op: "global.set", index: 0 },
      { op: "local.get", index: 1 },
      { op: "return_call", funcIdx: 0 },
    ];
    // The two arguments are the two `local.get`s — never the `ref.null.extern`
    // consumed by `global.set`.
    expect(locateCallArgProducers(instrs, mod).get(4)).toEqual([0, 3]);
  });
});
