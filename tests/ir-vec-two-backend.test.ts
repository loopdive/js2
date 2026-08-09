// #1714 — the vec IR node lowers, from the SAME emission intent, to TWO
// structurally different backends via the #1713 BackendEmitter seam.
//
// This is the proof the seam *abstracts* a real second backend, not just
// indirection. We assert:
//
//   1. WasmGcEmitter and LinearEmitter produce DIFFERENT, each-backend-correct
//      Instr sequences for the same three vec primitives (emitVecLen,
//      emitVecDataPtr, emitElemGet) — the divergence proof.
//   2. The LinearEmitter's emitted ops, executed against a hand-laid-out linear
//      array using the documented layout (src/codegen-linear/runtime.ts:339
//      `[header 8B][len@+8][cap@+12][elements@+16]`), compute the correct
//      length and element values at runtime — the linear-correctness proof.
//
// The WasmGC path's runtime correctness for these same primitives is already
// covered by the full IR equivalence suite (which routes vec.len/vec.get
// through WasmGcEmitter via #1713). Together: same IR intent → two backends →
// matching results.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { collectIrDirectCallLoweringPlans } from "../src/ir/ast-lowering-plans.js";
import type { IrVecLowering, LinearVecLowering } from "../src/ir/backend/handles.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { lowerIrFunctionToWasm } from "../src/ir/lower.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  defaultOperationsForLayout,
  irVal,
  planLinearVectorLayout,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import type { BlockType, Instr, ValType, WasmFunction, WasmModule } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const wasmgc = new WasmGcEmitter();
const linear = new LinearEmitter();
const irIdentities = createTestIrFunctionIdentityFactory("ir-vec-two-backend");

const gcVec: IrVecLowering = {
  vecStructTypeIdx: 7,
  lengthFieldIdx: 0,
  dataFieldIdx: 1,
  arrayTypeIdx: 4,
  elementValType: { kind: "f64" },
};
function linearVec(elementValType: ValType): LinearVecLowering {
  const layout = planLinearVectorLayout(irVal(elementValType));
  const operations = defaultOperationsForLayout(layout);
  return {
    elementValType,
    linearMemory: {
      layout,
      allocate: operations.find((operation) => operation.family === "vector" && operation.operation === "allocate")!,
      initializeElement: operations.find(
        (operation) => operation.family === "vector" && operation.operation === "initialize-element",
      )!,
    },
  };
}

const linVec = linearVec({ kind: "f64" });

describe("#1714 vec primitives diverge per backend (same intent, two emitters)", () => {
  it("emitVecLen: WasmGC struct.get vs linear i32.load@8", () => {
    const gc: Instr[] = [];
    wasmgc.emitVecLen(gcVec, gc);
    expect(gc).toEqual([{ op: "struct.get", typeIdx: 7, fieldIdx: 0 }]);

    const lin: Instr[] = [];
    linear.emitVecLen(linVec, lin);
    expect(lin).toEqual([{ op: "i32.load", align: 2, offset: 8 }]);
  });

  it("emitVecDataPtr: WasmGC struct.get(data) vs linear base+16", () => {
    const gc: Instr[] = [];
    wasmgc.emitVecDataPtr(gcVec, gc);
    expect(gc).toEqual([{ op: "struct.get", typeIdx: 7, fieldIdx: 1 }]);

    const lin: Instr[] = [];
    linear.emitVecDataPtr(linVec, lin);
    expect(lin).toEqual([{ op: "i32.const", value: 16 }, { op: "i32.add" }]);
  });

  it("emitElemGet: WasmGC array.get vs linear index*stride+load (f64)", () => {
    const gc: Instr[] = [];
    wasmgc.emitElemGet(gcVec, gc);
    expect(gc).toEqual([{ op: "array.get", typeIdx: 4 }]);

    const lin: Instr[] = [];
    linear.emitElemGet(linVec, lin);
    // dataBase + index*8, then f64.load
    expect(lin).toEqual([
      { op: "i32.const", value: 8 },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "f64.load", align: 3, offset: 0 },
    ]);
  });

  it("emitElemGet stride follows elementValType (i32 → stride 4, i32.load)", () => {
    const lin: Instr[] = [];
    linear.emitElemGet(linearVec({ kind: "i32" }), lin);
    expect(lin).toEqual([
      { op: "i32.const", value: 4 },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "i32.load", align: 2, offset: 0 },
    ]);
  });
});

describe("#1714 LinearEmitter ops execute correctly against the linear layout", () => {
  it("sums an f64 array via the emitted len + dataPtr + elemGet ops", async () => {
    // Build a tiny WAT module that mirrors EXACTLY what lower.ts would emit if
    // it routed a sum-of-array loop through LinearEmitter for the vec ops:
    //   len      = i32.load offset=8           (emitVecLen)
    //   dataBase = base + 16                    (emitVecDataPtr: i32.const 16; i32.add)
    //   elem     = f64.load(dataBase + i*8)     (emitElemGet: i32.const 8; i32.mul; i32.add; f64.load)
    // Array [10,20,30] laid out at ptr=0: len=3 @8, elements @16,24,32. Sum=60.
    const wat = `
(module
  (memory (export "mem") 1)
  (func (export "sum") (param $base i32) (result f64)
    (local $i i32) (local $len i32) (local $data i32) (local $acc f64)
    ;; len = emitVecLen(base)
    (local.set $len (i32.load offset=8 (local.get $base)))
    ;; data = emitVecDataPtr(base) = base + 16
    (local.set $data (i32.add (local.get $base) (i32.const 16)))
    (local.set $acc (f64.const 0))
    (block $exit
      (loop $loop
        (br_if $exit (i32.ge_s (local.get $i) (local.get $len)))
        ;; elem = emitElemGet(data, i) = f64.load(data + i*8)
        (local.set $acc
          (f64.add (local.get $acc)
            (f64.load (i32.add (local.get $data)
                               (i32.mul (local.get $i) (i32.const 8))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $acc)))
`;
    // @ts-expect-error — wabt has no bundled types
    const wabtMod = await (await import("wabt")).default();
    const parsed = wabtMod.parseWat("vec.wat", wat, { mutable_globals: true });
    const { buffer } = parsed.toBinary({});
    const { instance } = await WebAssembly.instantiate(buffer, {});
    const mem = new DataView((instance.exports.mem as WebAssembly.Memory).buffer);
    // Lay out the array at ptr=0 per the linear layout.
    mem.setUint32(8, 3, true); // len
    mem.setUint32(12, 3, true); // cap
    mem.setFloat64(16, 10, true);
    mem.setFloat64(24, 20, true);
    mem.setFloat64(32, 30, true);
    const sum = (instance.exports.sum as (b: number) => number)(0);
    expect(sum).toBe(60);
    parsed.destroy?.();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2954 — the LinearEmitter's CORE-OP families are byte-identical to WasmGc.
//
// #1714 proved the seam with the vec primitives (which DIVERGE per backend).
// #2954 extends LinearEmitter to the core-op families — const / binary / unary /
// locals / globals / drop / select / return / unreachable / if / br / br_if /
// block / loop / direct call. These emit CORE Wasm (both backends share the
// `Instr` encoding), so — unlike the vec ops — they must be BYTE-IDENTICAL to
// WasmGcEmitter. This block pins that method-by-method: same call, same
// `Instr[]`. A future divergence in a core op would be a bug (the linear
// backend does not get to lower `f64.add` differently), and this catches it.
// ─────────────────────────────────────────────────────────────────────────────
describe("#2954 LinearEmitter core-op families are byte-identical to WasmGc", () => {
  const EMPTY: BlockType = { kind: "empty" };
  /** Run the same emitter method on both backends and assert identical Instr[]. */
  function bothEqual(fn: (e: WasmGcEmitter | LinearEmitter, out: Instr[]) => void): Instr[] {
    const gc: Instr[] = [];
    const lin: Instr[] = [];
    fn(wasmgc, gc);
    fn(linear, lin);
    expect(lin).toEqual(gc);
    return lin;
  }

  it("emitConst (f64 / i32 / bool) — identical literal ops", () => {
    expect(
      bothEqual((e, out) =>
        e.emitConst({ kind: "const", result: null, resultType: null, value: { kind: "f64", value: 3.5 } }, "f", out),
      ),
    ).toEqual([{ op: "f64.const", value: 3.5 }]);
    expect(
      bothEqual((e, out) =>
        e.emitConst({ kind: "const", result: null, resultType: null, value: { kind: "i32", value: 7 } }, "f", out),
      ),
    ).toEqual([{ op: "i32.const", value: 7 }]);
    expect(
      bothEqual((e, out) =>
        e.emitConst({ kind: "const", result: null, resultType: null, value: { kind: "bool", value: true } }, "f", out),
      ),
    ).toEqual([{ op: "i32.const", value: 1 }]);
  });

  it("emitBinary / emitUnary — identical pass-through ops", () => {
    expect(bothEqual((e, out) => e.emitBinary("f64.add", out))).toEqual([{ op: "f64.add" }]);
    expect(bothEqual((e, out) => e.emitBinary("i32.lt_s", out))).toEqual([{ op: "i32.lt_s" }]);
    expect(bothEqual((e, out) => e.emitUnary("f64.neg", out))).toEqual([{ op: "f64.neg" }]);
  });

  it("locals / globals — identical index ops", () => {
    expect(bothEqual((e, out) => e.emitLocalGet(2, out))).toEqual([{ op: "local.get", index: 2 }]);
    expect(bothEqual((e, out) => e.emitLocalSet(3, out))).toEqual([{ op: "local.set", index: 3 }]);
    expect(bothEqual((e, out) => e.emitLocalTee(4, out))).toEqual([{ op: "local.tee", index: 4 }]);
    expect(bothEqual((e, out) => e.emitGlobalGet(1, out))).toEqual([{ op: "global.get", index: 1 }]);
    expect(bothEqual((e, out) => e.emitGlobalSet(5, out))).toEqual([{ op: "global.set", index: 5 }]);
  });

  it("stack / return ops — identical", () => {
    expect(bothEqual((e, out) => e.emitDrop(out))).toEqual([{ op: "drop" }]);
    expect(bothEqual((e, out) => e.emitSelect(out))).toEqual([{ op: "select" }]);
    expect(bothEqual((e, out) => e.emitReturn(out))).toEqual([{ op: "return" }]);
    expect(bothEqual((e, out) => e.emitUnreachable(out))).toEqual([{ op: "unreachable" }]);
  });

  it("structured control flow (if / block / loop) + br / br_if — identical", () => {
    const then: Instr[] = [{ op: "i32.const", value: 1 }];
    const els: Instr[] = [{ op: "i32.const", value: 0 }];
    expect(bothEqual((e, out) => e.emitIf(EMPTY, [...then], [...els], out))).toEqual([
      { op: "if", blockType: EMPTY, then, else: els },
    ]);
    expect(bothEqual((e, out) => e.emitBr(1, out))).toEqual([{ op: "br", depth: 1 }]);
    expect(bothEqual((e, out) => e.emitBrIf(0, out))).toEqual([{ op: "br_if", depth: 0 }]);
    const body: Instr[] = [{ op: "nop" } as Instr];
    expect(bothEqual((e, out) => e.emitBlock(EMPTY, [...body], out))).toEqual([
      { op: "block", blockType: EMPTY, body },
    ]);
    expect(bothEqual((e, out) => e.emitLoop(EMPTY, [...body], out))).toEqual([{ op: "loop", blockType: EMPTY, body }]);
  });

  it("direct call — identical", () => {
    expect(bothEqual((e, out) => e.emitCall(9, out))).toEqual([{ op: "call", funcIdx: 9 }]);
  });

  it("representation-divergent families still fail loudly on LinearEmitter", () => {
    // Boxing-adjacent funcref calls and exceptions still need distinct linear
    // designs. Aggregates/ref-cells are covered by #2956's linear-memory tests.
    for (const call of [
      () => linear.emitCallRef(),
      () => linear.emitThrow(),
      () => linear.emitTry(),
      () => linear.emitVecNewFixed(),
    ]) {
      expect(call).toThrow(/LinearEmitter:/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2954 — a WHOLE function lowers through LinearEmitter and RUNS in a
// linear-memory instantiation.
//
// The byte-identity block above is the unit proof; this is the integration
// proof required by the issue's acceptance: a recursive numeric fib and a
// loop/branch function are lowered from real IR (produced by the from-ast
// frontend) through `LinearEmitter`, assembled into a module that declares a
// LINEAR MEMORY, instantiated, and executed — with correct results. The SAME IR
// lowered through `WasmGcEmitter` yields a byte-identical body (the core-op
// stream does not diverge), so the WasmGC path — already covered for runtime
// correctness by the equivalence suite — pins the linear one.
//
// (These core-op functions do not touch the memory: that is the point — core
// ops are memory-independent. The memory is declared to model the linear
// backend's module shape; the vec/aggregate families that WOULD use it are the
// still-divergent surface, out of #2954 scope.)
// ─────────────────────────────────────────────────────────────────────────────
describe("#2954 whole-function lowering through LinearEmitter runs in linear memory", () => {
  const F64: ValType = { kind: "f64" };

  // Self-call → funcIdx 0; the numeric subset reaches no globals; one func type.
  const resolver: IrLowerResolver = {
    resolveFunc: () => 0,
    resolveGlobal: () => {
      throw new Error("numeric subset reaches no globals");
    },
    resolveType: () => 0,
    internFuncType: () => 0,
  };

  /** Lower a named top-level function from `source` to IR via the frontend. */
  function irOf(
    source: string,
    name: string,
    calleeTypes?: Map<string, { params: IrType[]; returnType: IrType | null }>,
  ) {
    const ast = analyzeSource(source);
    const decl = ast.sourceFile.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
    );
    if (!decl) throw new Error(`no function ${name} in source`);
    const ownerIdentity = irIdentities.next(name);
    const directCalls = calleeTypes
      ? collectIrDirectCallLoweringPlans(
          decl,
          ownerIdentity.unitId,
          new Map(
            [...calleeTypes].map(([calleeName, signature]) => [
              calleeName,
              {
                target: irUnitFuncRef(calleeName === name ? ownerIdentity : irIdentities.next(`callee:${calleeName}`)),
                signature,
              },
            ]),
          ),
        )
      : undefined;
    return lowerFunctionAstToIr(decl, {
      ownerUnitId: ownerIdentity.unitId,
      exported: true,
      directCalls,
    }).main;
  }

  /** Wrap one lowered WasmFunction (index 0, exported) in a linear-memory module. */
  function singleFuncModule(fn: WasmFunction, params: ValType[], results: ValType[]): WasmModule {
    return {
      types: [{ kind: "func", name: "t0", params, results }],
      imports: [],
      functions: [fn],
      exports: [{ name: fn.name, desc: { kind: "func", index: 0 } }],
      tables: [],
      elements: [],
      globals: [],
      tags: [],
      stringPool: [],
      externClasses: [],
      nodeBuiltinModules: new Set(),
      stringLiteralValues: new Map(),
      asyncFunctions: new Set(),
      declaredFuncRefs: [],
      memories: [{ min: 1 }], // linear memory — the backend's module shape
      dataSegments: [],
    } as unknown as WasmModule;
  }

  async function runLinear(
    source: string,
    name: string,
    params: ValType[],
    results: ValType[],
    calleeTypes?: Map<string, { params: IrType[]; returnType: IrType | null }>,
  ): Promise<(...a: number[]) => number> {
    const ir = irOf(source, name, calleeTypes);
    const linFn = lowerIrFunctionToWasm(ir, resolver, new LinearEmitter()).func;
    // Same IR through WasmGc must yield a byte-identical body (core ops don't diverge).
    const gcFn = lowerIrFunctionToWasm(ir, resolver, new WasmGcEmitter()).func;
    expect(linFn.body).toEqual(gcFn.body);
    const binary = emitBinary(singleFuncModule(linFn, params, results));
    const { instance } = await WebAssembly.instantiate(binary, {});
    return instance.exports[name] as (...a: number[]) => number;
  }

  it("recursive numeric fib lowers through LinearEmitter and computes correctly", async () => {
    const fib = await runLinear(
      `export function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }`,
      "fib",
      [F64],
      [F64],
      new Map([["fib", { params: [irVal(F64)], returnType: irVal(F64) }]]),
    );
    // 0,1,1,2,3,5,8,13,21,34,55,...
    expect(fib(0)).toBe(0);
    expect(fib(1)).toBe(1);
    expect(fib(10)).toBe(55);
    expect(fib(15)).toBe(610);
    expect(fib(20)).toBe(6765);
  });

  it("a for-loop / branch function lowers through LinearEmitter and computes correctly", async () => {
    // A `for` loop (structured for.loop IR + slots) carrying a BRANCH inside the
    // body (a ternary → value-producing `if`). Exercises loop + branch + binary +
    // const together on the linear boundary.
    const sumTo = await runLinear(
      `export function sumTo(n: number): number {
         let t = 0;
         for (let i = 0; i < n; i = i + 1) { t = t + (i > 1 ? i : 0); }
         return t;
       }`,
      "sumTo",
      [F64],
      [F64],
    );
    expect(sumTo(0)).toBe(0);
    expect(sumTo(2)).toBe(0); // i=0,1 gated to 0 by i>1
    expect(sumTo(5)).toBe(9); // 2+3+4
    expect(sumTo(100)).toBe(4949); // sum(2..99) = 4950 - 1
  });
});
