import { describe, it, expect } from "vitest";

import { repairStructTypeMismatches } from "../src/codegen/fixups.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

// #1725 — the struct.set repair in `repairStructTypeMismatches` walks
// backwards from a `struct.set` to find the instruction that produced the
// struct-ref receiver, tracking stack depth via `instrStackDelta`. That delta
// treats `if`/`block`/`loop`/`try` as opaque (delta 0). When the field-VALUE
// sub-expression contains control flow (e.g. a ternary + multi-struct
// dispatch — as in acorn's `Parser` function-constructor body), the depth
// accounting under-counts and the backward walk OVERSHOOTS the real receiver,
// landing on an externref `local.get` deep inside the value sub-expression.
// The pass then spliced `any.convert_extern + ref.cast_null` after that
// externref producer, where it was immediately consumed by the value
// sub-expression's own `any.convert_extern` — producing the invalid
// `ref.cast_null … ; any.convert_extern` adjacency that failed
// `WebAssembly.compile()` on `__fnctor_Parser_new` (the acorn dogfood
// blocker, surfaced via tests/dogfood/acorn-harness.mjs).
//
// The fix: when the backward depth-walk crosses any opaque control-flow
// instruction, the located producer is not a trustworthy struct-ref receiver,
// so skip the splice and leave codegen's own (correct) receiver lowering
// intact.

/**
 * Build a minimal module whose single function body reproduces the #1725
 * shape: a `struct.set` whose field-VALUE sub-expression contains an `if`
 * block, AND an externref `local.get` (the function's param 0) sits deeper in
 * the value computation than the struct receiver. The struct receiver is a
 * non-externref local (param 1 = a struct ref), so codegen needs no repair.
 */
function buildModule(): WasmModule {
  // struct $S { field0: f64 (mut) }
  // func (param $opts externref) (param $self (ref null 0)) (local $x externref):
  //   local.get $self                 ;; struct receiver (already a struct ref)
  //   ;; --- field VALUE sub-expression: produces the f64 to store ----------
  //   local.get $opts                 ;; externref, consumed inside the if below
  //   any.convert_extern
  //   ref.test 0
  //   (if (result f64)                ;; opaque to instrStackDelta (counted 0)
  //     (then f64.const 1)
  //     (else f64.const 2))
  //   struct.set 0 0
  //
  // `instrStackDelta` counts the structured `if` as delta 0 and
  // `any.convert_extern`/`ref.test` as delta 0, so walking back from
  // `struct.set` (which needs cumulative +2 to locate the struct receiver) the
  // accounting reaches +1 at `local.get $opts` and +2 at `local.get $self`.
  // Here the receiver IS `local.get $self` — correct — BUT the walk has to step
  // PAST the `if`. If the value sub-expression had any extra unbalanced push
  // (as acorn's multi-struct dispatch does), the +2 would instead land on the
  // externref `local.get $opts`. The control-flow guard (#1725) disables the
  // heuristic the moment the walk crosses an `if`/`block`/`loop`/`try`, so the
  // pass never splices a bogus `any.convert_extern + ref.cast_null` regardless
  // of how the opaque block's true stack effect differs from the delta estimate.
  const body: Instr[] = [
    // `local.get $opts` is the externref VALUE-side producer the unguarded
    // backward walk would mistake for the struct receiver. The intervening
    // structured `if` is counted as delta 0 by `instrStackDelta`, so the +2
    // depth target is reached AT this externref instead of at the genuine
    // struct receiver (which, in the real acorn body, lay even deeper behind
    // the control flow). The two `local.get`s sit between the `if` and the
    // `struct.set` so the cumulative backward depth reaches +2 exactly at the
    // externref `local.get $opts`.
    { op: "local.get", index: 0 } as Instr, // externref param ($opts) — must NOT be cast
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: 0 } },
      then: [{ op: "local.get", index: 1 } as Instr], // a struct ref (the true receiver)
      else: [{ op: "ref.null", typeIdx: 0 } as Instr],
    } as unknown as Instr,
    { op: "f64.const", value: 1 } as Instr, // the field VALUE to store
    { op: "struct.set", typeIdx: 0, fieldIdx: 0 } as Instr,
  ];

  const mod = {
    types: [
      {
        kind: "struct",
        name: "$S",
        fields: [{ name: "field0", type: { kind: "f64" }, mutable: true }],
      },
      {
        kind: "func",
        name: "$f",
        params: [{ kind: "externref" }, { kind: "ref_null", typeIdx: 0 }],
        results: [],
      },
    ],
    imports: [],
    functions: [
      {
        name: "__fnctor_Parser_new",
        typeIdx: 1,
        locals: [],
        body,
        exported: false,
      },
    ],
    exports: [],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set<string>(),
    stringLiteralValues: new Map<string, string>(),
    asyncFunctions: new Set<string>(),
    declaredFuncRefs: [],
    memories: [],
    dataSegments: [],
  } as unknown as WasmModule;

  return mod;
}

/** Recursively detect the invalid `ref.cast_null|ref.cast → any.convert_extern` adjacency. */
function hasBadAdjacency(body: Instr[]): boolean {
  for (let i = 0; i < body.length - 1; i++) {
    const a = body[i] as { op: string };
    const b = body[i + 1] as { op: string };
    if ((a.op === "ref.cast_null" || a.op === "ref.cast") && b.op === "any.convert_extern") {
      return true;
    }
    for (const k of ["then", "else", "body", "catchAll"] as const) {
      const arr = (body[i] as Record<string, unknown>)[k];
      if (Array.isArray(arr) && hasBadAdjacency(arr as Instr[])) return true;
    }
    const catches = (body[i] as { catches?: { body?: Instr[] }[] }).catches;
    if (Array.isArray(catches)) {
      for (const c of catches) if (c.body && hasBadAdjacency(c.body)) return true;
    }
  }
  return false;
}

describe("#1725 — functor-constructor struct.set repair must not cast a value-side externref", () => {
  it("does not splice any.convert_extern/ref.cast_null when the struct.set value sub-expression has control flow", () => {
    const mod = buildModule();
    const before = JSON.stringify(mod.functions[0]!.body);

    repairStructTypeMismatches(mod);

    const fixedBody = mod.functions[0]!.body;
    // The pass must NOT introduce the invalid ref.cast_null → any.convert_extern
    // adjacency that broke WebAssembly.compile() on acorn's __fnctor_Parser_new.
    expect(hasBadAdjacency(fixedBody)).toBe(false);

    // The externref `local.get 0` (a VALUE-side producer) must be left intact —
    // it must NOT be followed by a spurious `any.convert_extern + ref.cast_null`
    // splice. With the depth walk crossing the `if`, the heuristic is disabled,
    // so the body is unchanged (the receiver is already a struct ref).
    expect(JSON.stringify(fixedBody)).toBe(before);
  });

  it("does not duplicate an exact receiver cast already emitted before struct.set", () => {
    const mod = buildModule();
    mod.functions[0]!.body = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast_null", typeIdx: 0 },
      { op: "f64.const", value: 1 },
      { op: "struct.set", typeIdx: 0, fieldIdx: 0 },
    ];
    const before = JSON.stringify(mod.functions[0]!.body);

    expect(repairStructTypeMismatches(mod)).toBe(0);
    expect(JSON.stringify(mod.functions[0]!.body)).toBe(before);
    expect(hasBadAdjacency(mod.functions[0]!.body)).toBe(false);
  });
});
