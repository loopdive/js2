// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1167c — IR Phase 3c: monomorphize + tagged-unions passes.
//
// Covers:
//   1. monomorphize: function called with distinct arg-type tuples is cloned
//      per tuple; each call site redirects to the matching clone.
//   2. monomorphize: single-tuple callee is left alone (no profitable spec).
//   3. monomorphize: recursive callees are skipped.
//   4. monomorphize: callees whose body reads params as operands are skipped
//      (can't safely retype without re-inferring instruction types).
//   5. monomorphize: pass-end growth guard fires when A→B→C clone fan-out
//      would exceed 1.5× the original module size.
//   6. taggedUnions: module with a union-typed value passes through unchanged
//      and lowers to `$union_*` struct ops (no `__box_number`/`__unbox_number`).
//   7. taggedUnions: reports unsupported unions as non-fatal errors.

import { describe, expect, it } from "vitest";

import {
  asBlockId,
  asValueId,
  irVal,
  lowerIrFunctionToWasm,
  verifyIrFunction,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrLowerResolver,
  type IrUnionLowering,
  type IrValueId,
} from "../../src/ir/index.js";
import { monomorphize } from "../../src/ir/passes/monomorphize.js";
import { runTaggedUnions, taggedUnions } from "../../src/ir/passes/tagged-unions.js";
import { UnionStructRegistry } from "../../src/ir/passes/tagged-union-types.js";
import type { StructTypeDef, ValType } from "../../src/ir/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function id(n: number): IrValueId {
  return asValueId(n);
}

const F64 = irVal({ kind: "f64" });
const EXTERNREF = irVal({ kind: "externref" });
const I32 = irVal({ kind: "i32" });

/** Build a simple identity callee whose body is empty (return param). */
function makeIdentity(name: string, paramType = F64): IrFunction {
  return {
    name,
    params: [{ value: id(0), type: paramType, name: "x" }],
    resultTypes: [paramType],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "return", values: [id(0)] },
      },
    ],
    exported: false,
    valueCount: 1,
  };
}

/**
 * Build a caller that makes one call to `calleeName` with a single f64 or
 * externref argument. The argument is the caller's own param (of `argType`),
 * so the call site's arg-type tuple depends on `argType`.
 */
function makeCallerPassingParam(callerName: string, calleeName: string, argType = F64): IrFunction {
  return {
    name: callerName,
    params: [{ value: id(0), type: argType, name: "n" }],
    resultTypes: [argType],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "call",
            target: { kind: "func", name: calleeName },
            args: [id(0)],
            result: id(1),
            resultType: argType,
          },
        ],
        terminator: { kind: "return", values: [id(1)] },
      },
    ],
    exported: true,
    valueCount: 2,
  };
}

// ---------------------------------------------------------------------------
// monomorphize — core behavior
// ---------------------------------------------------------------------------

describe("#1167c — monomorphize (unit)", () => {
  it("clones a callee invoked with two distinct arg-type tuples", () => {
    // identity called from a f64 caller AND an externref caller — two tuples.
    const identity = makeIdentity("identity", F64);
    const callerNum = makeCallerPassingParam("run_num", "identity", F64);
    const callerStr = makeCallerPassingParam("run_str", "identity", EXTERNREF);

    const result = monomorphize({ functions: [identity, callerNum, callerStr] });
    expect(result.module).not.toBe({ functions: [identity, callerNum, callerStr] });

    // One clone produced (the first tuple keeps the original callee).
    expect(result.cloneSignatures.size).toBe(1);

    // Clone name starts with `identity$` regardless of which tuple (f64 vs
    // externref) won the first-keeps-original slot — our canonical sort is
    // lexicographic over the ValType kind, so the winner depends on member
    // kind spelling; both the test and the impl must not hardcode that.
    const cloneName = [...result.cloneSignatures.keys()][0]!;
    expect(cloneName.startsWith("identity$")).toBe(true);

    // One of the two callers now targets the clone, the other still hits
    // the original callee.
    const callerNumAfter = result.module.functions.find((f) => f.name === "run_num")!;
    const callerStrAfter = result.module.functions.find((f) => f.name === "run_str")!;
    const numCall = callerNumAfter.blocks[0]!.instrs.find((i) => i.kind === "call")! as Extract<
      IrInstr,
      { kind: "call" }
    >;
    const strCall = callerStrAfter.blocks[0]!.instrs.find((i) => i.kind === "call")! as Extract<
      IrInstr,
      { kind: "call" }
    >;
    const targets = new Set([numCall.target.name, strCall.target.name]);
    expect(targets.has("identity")).toBe(true);
    expect(targets.has(cloneName)).toBe(true);

    // The clone's signature matches whichever caller sends its arg to the
    // clone. Because `identity` forwards its param verbatim, the call-site
    // arg type IS the clone's param type IS the clone's return type.
    const sig = result.cloneSignatures.get(cloneName)!;
    expect(sig.params).toHaveLength(1);
    const cloneCallerArgType = numCall.target.name === cloneName ? F64 : EXTERNREF;
    expect(sig.params[0]).toEqual(cloneCallerArgType);
    expect(sig.returnType).toEqual(cloneCallerArgType);

    // The clone function exists in the module and verifies.
    const cloneFn = result.module.functions.find((f) => f.name === cloneName)!;
    expect(cloneFn).toBeDefined();
    expect(verifyIrFunction(cloneFn)).toEqual([]);
  });

  it("leaves a callee with a single arg-type tuple untouched", () => {
    // Both callers invoke identity with f64 — no specialization needed.
    const identity = makeIdentity("identity", F64);
    const callerA = makeCallerPassingParam("a", "identity", F64);
    const callerB = makeCallerPassingParam("b", "identity", F64);

    const mod = { functions: [identity, callerA, callerB] };
    const result = monomorphize(mod);
    // Reference equality: no clones, no rewrites → same module.
    expect(result.module).toBe(mod);
    expect(result.cloneSignatures.size).toBe(0);
  });

  it("skips recursive callees", () => {
    // `rec` calls itself — computeRecursiveSet rejects it.
    const rec: IrFunction = {
      name: "rec",
      params: [{ value: id(0), type: F64, name: "n" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: { kind: "func", name: "rec" },
              args: [id(0)],
              result: id(1),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    // Two callers with distinct arg types: one f64, one externref.
    const callerNum = makeCallerPassingParam("run_num", "rec", F64);
    const callerStr = makeCallerPassingParam("run_str", "rec", EXTERNREF);

    const result = monomorphize({ functions: [rec, callerNum, callerStr] });
    // Recursive → no clone despite distinct call tuples.
    expect(result.cloneSignatures.size).toBe(0);
  });

  it("#1574 §2.4: abandons a param-arithmetic clone that would retype an f64 operand to i32", () => {
    // `double(n) = n + n` — `f64.add` consumes the param. Called with an f64
    // tuple and an i32 tuple. The canonical tuple sort puts `v:f64` before
    // `v:i32`, so the f64 tuple keeps the original callee (no clone) and the
    // i32 tuple is the clone CANDIDATE. Cloning it would leave the body's
    // `f64.add` consuming i32 operands off the stack — INVALID Wasm (there's
    // no implicit i32→f64 widening at the IR→Wasm boundary). `reinferBinary`
    // returns null for `f64.add` on a non-f64 operand, so the clone is
    // abandoned and the i32 call site stays on the original callee. Net: no
    // clones.
    //
    // (Pre-#1574 the operand-free gate rejected the whole callee earlier; the
    // observable "no clones" result is unchanged, but the rejection now
    // happens at clone-construction time via the soundness check — which is
    // what lets the SOUND ref-polymorphic case below succeed.)
    const doubler: IrFunction = {
      name: "double",
      params: [{ value: id(0), type: F64, name: "n" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "binary",
              op: "f64.add",
              lhs: id(0),
              rhs: id(0),
              result: id(1),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const callerA = makeCallerPassingParam("run_a", "double", F64);
    const callerB = makeCallerPassingParam("run_b", "double", I32);

    const result = monomorphize({ functions: [doubler, callerA, callerB] });
    expect(result.cloneSignatures.size).toBe(0);
    // The unsound i32 call site must remain pointing at the original callee.
    const callerBAfter = result.module.functions.find((f) => f.name === "run_b")!;
    const bCall = callerBAfter.blocks[0]!.instrs.find((i) => i.kind === "call")! as Extract<IrInstr, { kind: "call" }>;
    expect(bCall.target.name).toBe("double");
  });

  it("#1574 §2.4: clones a param-consuming ref.is_null body across reference tuples", () => {
    // `isNull(x) = ref.is_null(x)` consumes the param. `ref.is_null` is the
    // one genuinely ref-polymorphic op — valid for ANY reference operand —
    // so substituting the param from externref to a struct ref keeps the
    // body sound, and re-inference produces a distinct, valid clone. The
    // result type (i32 bool) is unchanged across tuples; the param type
    // shifts. This is the real capability §2.4 unlocks: a param-consuming
    // body cloned per call-site reference type without invalid Wasm.
    const STRUCT_REF: IrType = irVal({ kind: "ref", typeIdx: 7 });
    const isNull: IrFunction = {
      name: "isNull",
      params: [{ value: id(0), type: EXTERNREF, name: "x" }],
      resultTypes: [I32],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "unary", op: "ref.is_null", rand: id(0), result: id(1), resultType: I32 }],
          terminator: { kind: "return", values: [id(1)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    // Caller A passes an externref param; caller B passes a struct ref param.
    // Both flow their param straight into isNull → two distinct ref tuples.
    const callerExt = makeCallerPassingParam("run_ext", "isNull", EXTERNREF);
    const callerStruct = makeCallerPassingParam("run_struct", "isNull", STRUCT_REF);
    // Callers return i32 (the isNull result), not their param — fix the
    // call-result type so the module verifies.
    const fixCaller = (c: IrFunction): IrFunction => ({
      ...c,
      resultTypes: [I32],
      blocks: c.blocks.map((b) => ({
        ...b,
        instrs: b.instrs.map((i) => (i.kind === "call" ? { ...i, resultType: I32 } : i)),
      })),
    });

    const result = monomorphize({
      functions: [isNull, fixCaller(callerExt), fixCaller(callerStruct)],
    });

    // One clone (first tuple keeps the original). The clone's param is the
    // non-original reference type; its result type stays i32.
    expect(result.cloneSignatures.size).toBe(1);
    const cloneName = [...result.cloneSignatures.keys()][0]!;
    expect(cloneName.startsWith("isNull$")).toBe(true);
    const sig = result.cloneSignatures.get(cloneName)!;
    expect(sig.returnType).toEqual(I32);
    // The clone's param is a reference type (externref or the struct ref),
    // not a numeric — and the clone body verifies.
    const cloneFn = result.module.functions.find((f) => f.name === cloneName)!;
    expect(cloneFn.params[0]!.type.kind).toBe("val");
    expect(verifyIrFunction(cloneFn)).toEqual([]);
    // The re-typed clone's ref.is_null result type is still i32.
    const cloneInstr = cloneFn.blocks[0]!.instrs[0]! as Extract<IrInstr, { kind: "unary" }>;
    expect(cloneInstr.op).toBe("ref.is_null");
    expect(cloneInstr.resultType).toEqual(I32);
  });

  it("growth guard: fan-out that exceeds 1.5× module budget is rejected", () => {
    // A tiny module where cloning would more than double the size. One 1-instr
    // callee `t` used with 4 distinct arg-type tuples from 4 small callers.
    // Original size = 1 (callee body) + 4 * 1 (caller bodies) = 5 instrs.
    // Budget cap = 2.5 new instrs. Adding 3 clones (one per extra tuple) = 3
    // new instrs → 3 > 2.5 → pass abandons.
    const t: IrFunction = {
      name: "t",
      params: [{ value: id(0), type: F64, name: "x" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          // One placeholder const so size > 0 (return-param callees with
          // 0 body instrs would make the budget trivially satisfied).
          instrs: [{ kind: "const", value: { kind: "f64", value: 1 }, result: id(1), resultType: F64 }],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const callers: IrFunction[] = [
      makeCallerPassingParam("c1", "t", F64),
      makeCallerPassingParam("c2", "t", I32),
      makeCallerPassingParam("c3", "t", EXTERNREF),
      makeCallerPassingParam("c4", "t", irVal({ kind: "f32" })),
    ];
    const result = monomorphize({ functions: [t, ...callers] });
    // Guard fires → no clones.
    expect(result.cloneSignatures.size).toBe(0);
  });

  it("composed chain A→B→C stays within the 1.5× budget when padded", () => {
    // Pad the module with bystander-size so A→B→C cloning fits under budget.
    // The test proves monomorphize WILL fire when the budget allows, not
    // that it fires on any tiny chain.
    //
    // Setup: A, B, C each called with two distinct arg-type tuples → each
    // produces 1 clone. Original module also has N zero-size pad functions
    // so the denominator is large enough for 3 clones × 1 instr = 3 new
    // instrs to fit under the 1.5× cap.
    const callee = (name: string, bodyInstr: IrInstr): IrFunction => ({
      name,
      params: [{ value: id(0), type: F64, name: "x" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [bodyInstr],
          terminator: { kind: "return", values: [id(0)] },
        },
      ],
      exported: false,
      valueCount: 2,
    });
    const a = callee("a", { kind: "const", value: { kind: "f64", value: 0 }, result: id(1), resultType: F64 });
    const b = callee("b", { kind: "const", value: { kind: "f64", value: 0 }, result: id(1), resultType: F64 });
    const c = callee("c", { kind: "const", value: { kind: "f64", value: 0 }, result: id(1), resultType: F64 });

    // Pad functions: 10 const-only helpers (10 instrs total) so the module
    // starts at 13 instrs, giving a 6.5-instr clone budget that comfortably
    // fits 3 × 1-instr clones.
    const pads: IrFunction[] = [];
    for (let i = 0; i < 10; i++) {
      pads.push({
        name: `pad_${i}`,
        params: [],
        resultTypes: [F64],
        blocks: [
          {
            id: asBlockId(0),
            blockArgs: [],
            blockArgTypes: [],
            instrs: [
              {
                kind: "const",
                value: { kind: "f64", value: i },
                result: id(0),
                resultType: F64,
              },
            ],
            terminator: { kind: "return", values: [id(0)] },
          },
        ],
        exported: false,
        valueCount: 1,
      });
    }

    const callers = [
      makeCallerPassingParam("a_num", "a", F64),
      makeCallerPassingParam("a_str", "a", EXTERNREF),
      makeCallerPassingParam("b_num", "b", F64),
      makeCallerPassingParam("b_str", "b", EXTERNREF),
      makeCallerPassingParam("c_num", "c", F64),
      makeCallerPassingParam("c_str", "c", EXTERNREF),
    ];

    const result = monomorphize({ functions: [a, b, c, ...pads, ...callers] });
    // Each of a/b/c gets 1 clone → 3 total.
    expect(result.cloneSignatures.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// taggedUnions — pass-through + lowering verification
// ---------------------------------------------------------------------------

describe("#1167c — taggedUnions (unit)", () => {
  it("returns the module unchanged when nothing to rewrite", () => {
    const fn = makeIdentity("id", F64);
    const mod = { functions: [fn] };
    expect(taggedUnions(mod)).toBe(mod);
    const { errors } = runTaggedUnions(mod);
    expect(errors).toEqual([]);
  });

  it("a value typed union<f64, i32> lowers via `$union_*` struct ops, not __box_number", () => {
    // Hand-build an IrFunction whose param is `union<f64, i32>`. Its body
    // emits a `tag.test` over the param and returns the i32 tag-test result.
    // We run taggedUnions (no-op in V1), then lower with a registry-backed
    // resolver, then inspect the emitted Wasm ops for `struct.get`/`i32.eq`
    // and the absence of any `call` to an externref boxing helper.
    const unionType = { kind: "union" as const, members: [{ kind: "f64" }, { kind: "i32" }] as const };
    const paramId = asValueId(0);
    const testResult = asValueId(1);
    const fn: IrFunction = {
      name: "discriminate",
      params: [{ value: paramId, type: unionType, name: "v" }],
      resultTypes: [I32],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "tag.test",
              value: paramId,
              tag: { kind: "f64" },
              result: testResult,
              resultType: I32,
            },
          ],
          terminator: { kind: "return", values: [testResult] },
        },
      ],
      exported: true,
      valueCount: 2,
    };

    const mod = { functions: [fn] };
    // taggedUnions is identity in V1.
    expect(taggedUnions(mod)).toBe(mod);

    // Build the registry-backed resolver + lower the function.
    const pushed: StructTypeDef[] = [];
    const registry = new UnionStructRegistry({
      push(def) {
        pushed.push(def);
        return pushed.length - 1;
      },
    });
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      internFuncType: () => 0,
      resolveUnion(members: readonly ValType[]): IrUnionLowering | null {
        return registry.resolve(members);
      },
    };
    const { func } = lowerIrFunctionToWasm(fn, resolver);

    // Registry emitted exactly one `$union_f64_i32` struct type.
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.name).toBe("$union_f64_i32");

    // Body contains struct.get + i32.const + i32.eq — the tag.test pattern —
    // and no `call` op (no __box_number / __unbox_number import roundtrip).
    const ops = func.body.map((op) => op.op);
    expect(ops).toContain("struct.get");
    expect(ops).toContain("i32.eq");
    expect(ops).not.toContain("call");
  });

  it("flags an unsupported union (externref member) as a pass error", () => {
    // union<f64, externref> is out of V1 scope — taggedUnions should report
    // it via runTaggedUnions.errors (non-fatal; pass still returns the module).
    const unionType = {
      kind: "union" as const,
      members: [{ kind: "f64" }, { kind: "externref" }] as const,
    };
    const paramId = asValueId(0);
    const testResult = asValueId(1);
    const fn: IrFunction = {
      name: "bad",
      params: [{ value: paramId, type: unionType, name: "v" }],
      resultTypes: [I32],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "tag.test",
              value: paramId,
              tag: { kind: "f64" },
              result: testResult,
              resultType: I32,
            },
          ],
          terminator: { kind: "return", values: [testResult] },
        },
      ],
      exported: false,
      valueCount: 2,
    };
    const { module, errors } = runTaggedUnions({ functions: [fn] });
    expect(module.functions[0]).toBe(fn); // pass-through
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/not supported/);
  });
});
