import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { BytecodeEmitter, BytecodeSink, BytecodeTypeConverter, OP } from "../src/ir/backend/bytecode-emitter.js";
import { runSink } from "../src/ir/backend/bytecode-vm.js";
import type { IrObjectStructLowering } from "../src/ir/backend/handles.js";
import { type IrFunction, type IrLowerResolver, asBlockId, asValueId, irVal } from "../src/ir/index.js";
// #1584 (a0-tail): the REAL production lowerer, generic over the sink. The arm
// at the bottom of this file drives it (not a hand-lowerer) through a
// BytecodeEmitter for the #1715 three functions — the (a0) acceptance criterion.
import { lowerIrFunctionBody } from "../src/ir/lower.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("ir-bytecode-proof");

// #1715 → #1584 — bytecode-emitter triple-equivalence (backend-agnostic IR).
//
// The proof: the #1713 BackendEmitter seam can target a NON-Wasm execution model
// (a bytecode stream + dispatch loop) using the same primitive set and operand-
// evaluation contract that targets WasmGC. TRIPLE-EQUIVALENCE: for the same
// source function,
//
//     bytecode-interpreted result  ==  WasmGC-compiled result  ==  plain-JS result
//
// #1584 productionized the emitter: it now implements the `BackendEmitter<S>`
// trait surface (over a `BytecodeSink`) rather than the proof's bespoke API, so
// the SAME drive shape `lower.ts` uses for WasmGC drives it here. This test
// hand-lowers each function through that production trait surface exactly as
// `lower.ts` would: emit operand subtrees first, then the terminal-op primitive
// (the seam's operand-order contract); build each `if`-arm into its own sink via
// `newSink()`, then hand both to `emitIf` (mirroring how `lower.ts` builds
// `thenBody`/`elseBody` as separate buffers).
//
// Routing the REAL `lower.ts` through the bytecode sink (dropping the hand-
// lowering) is the #1584 (a0) follow-on: it threads the generic sink through
// `lower.ts` so the bytecode arm is produced by the production lowering. The
// emitter seam this test exercises is the foundation that step builds on.
//
// The WasmGC arm DOES go through the real compiler (`compile()`), so the
// equivalence pins the bytecode result against production WasmGC lowering.

async function runWasmGc(src: string, fn: string, args: number[]): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  const f = (instance.exports as Record<string, (...a: number[]) => number>)[fn];
  return f(...args);
}

const E = new BytecodeEmitter();

/** Emit a numeric `const` through the production trait surface. */
function emitNumberConst(value: number, out: BytecodeSink): void {
  // The production emitConst takes an IR `const` instr; the f64 literal path is
  // a single CONST <poolIdx>, which is what these numeric proofs need.
  E.emitConst(
    {
      kind: "const",
      result: null,
      resultType: null,
      value: { kind: "f64", value },
    },
    "proof",
    out,
  );
}

describe("#1584 — bytecode-emitter triple equivalence (production trait surface)", () => {
  // ── f(a, b) = a + b ───────────────────────────────────────────────────────
  it("arithmetic: bytecode == WasmGC == JS for f(a,b)=a+b", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // a
      E.emitLocalGet(1, s); // b
      E.emitBinary("f64.add", s);
      E.emitReturn(s);
      return s;
    };
    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      expect(runSink(lower(), [a, b])).toBe(js(a, b));
      expect(await runWasmGc(src, "f", [a, b])).toBe(js(a, b));
    }
  });

  // ── g(a) = { let x = a * 2; return x; }  (a local) ───────────────────────
  it("local + mul: bytecode == WasmGC == JS for g(a)={let x=a*2;return x}", async () => {
    const src = `export function g(a: number): number { let x = a * 2; return x; }`;
    const js = (a: number): number => {
      const x = a * 2;
      return x;
    };
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // a
      emitNumberConst(2, s); // 2
      E.emitBinary("f64.mul", s); // a * 2
      E.emitLocalSet(1, s); // x =
      E.emitLocalGet(1, s); // return x
      E.emitReturn(s);
      return s;
    };
    for (const a of [3, -4, 0, 1.5, 1000]) {
      expect(runSink(lower(), [a])).toBe(js(a));
      expect(await runWasmGc(src, "g", [a])).toBe(js(a));
    }
  });

  // ── h(a, b) = a > 0 ? a + b : a - b  (the conditional branch) ────────────
  it("conditional branch: bytecode == WasmGC == JS for h(a,b)=a>0?a+b:a-b", async () => {
    const src = `export function h(a: number, b: number): number { return a > 0 ? a + b : a - b; }`;
    const js = (a: number, b: number): number => (a > 0 ? a + b : a - b);
    const lower = (): BytecodeSink => {
      const s = new BytecodeSink();
      // cond: a > 0 — emitted into the outer sink, left on the stack for emitIf
      E.emitLocalGet(0, s);
      emitNumberConst(0, s);
      E.emitBinary("f64.gt", s);
      // then arm: a + b — built into its own sink (as lower.ts builds thenBody)
      const thenArm = E.newSink();
      E.emitLocalGet(0, thenArm);
      E.emitLocalGet(1, thenArm);
      E.emitBinary("f64.add", thenArm);
      // else arm: a - b
      const elseArm = E.newSink();
      E.emitLocalGet(0, elseArm);
      E.emitLocalGet(1, elseArm);
      E.emitBinary("f64.sub", elseArm);
      E.emitIf({ kind: "empty" }, thenArm, elseArm, s);
      E.emitReturn(s);
      return s;
    };
    for (const [a, b] of [
      [5, 3], // then-arm
      [-2, 7], // else-arm
      [0, 9], // boundary → else (0 > 0 is false)
      [1.5, -0.5],
      [-100, -1],
    ]) {
      expect(runSink(lower(), [a, b])).toBe(js(a, b));
      expect(await runWasmGc(src, "h", [a, b])).toBe(js(a, b));
    }
  });

  // ── The #1584 not-yet-migrated boundary: out-of-subset ops throw loudly ──
  it("out-of-subset ops throw with a clear #1584 message", () => {
    const s = new BytecodeSink();
    // js-bitwise / i32 logical families have not migrated behind the trait yet.
    expect(() => E.emitBinary("js.bitor", s)).toThrow(/not in the #1584 production subset/);
    expect(() => E.emitUnary("i32.eqz", s)).toThrow(/not in the #1584 production subset/);
    // The raw-Instr escape hatch rejects an Instr for an unrealized op family.
    expect(() => E.pushRaw(s, { op: "struct.get", typeIdx: 0, fieldIdx: 0 })).toThrow(
      /out of the #1584 production subset/,
    );
  });
});

// ── #1584 (a0-tail): the bytecode arm is produced by the REAL lower.ts ──────
//
// The block above hand-drives the production trait surface (the test calls
// `E.emitLocalGet` / `E.emitBinary` itself). This block instead hands the REAL
// IR to the production `lowerIrFunctionBody(fn, resolver, new BytecodeEmitter())`
// and lets `lower.ts` decide which primitives to emit — exactly as it does for
// the WasmGC path. That is the (a0) acceptance criterion: "the bytecode arm is
// produced by real `lower.ts`, not the hand-lowerer." The same generic
// `lowerIrFunctionBody<S>` produces the WasmGC `Instr[]` (validated byte-
// identical by the equivalence suite) and this `BytecodeSink`; only the sink
// type differs (the #1715 finding).
const F64 = irVal({ kind: "f64" });

// Minimal resolver — the #1715 numeric subset reaches no funcs/globals/types
// except `internFuncType`, which only feeds the (discarded) typeIdx.
function numericResolver(): IrLowerResolver {
  let nextTypeIdx = 0;
  return {
    resolveFunc: () => {
      throw new Error("resolveFunc not used in the #1715 numeric subset");
    },
    resolveGlobal: () => {
      throw new Error("resolveGlobal not used in the #1715 numeric subset");
    },
    resolveType: () => {
      throw new Error("resolveType not used in the #1715 numeric subset");
    },
    internFuncType: () => nextTypeIdx++,
  };
}

/** Lower a hand-built IR function to a bytecode sink via the REAL lowerer. */
function lowerToBytecode(fn: IrFunction): BytecodeSink {
  return lowerIrFunctionBody(fn, numericResolver(), new BytecodeEmitter(), new BytecodeTypeConverter()).body;
}

describe("#1584 (a0-tail) — REAL lower.ts drives the bytecode sink (triple equivalence)", () => {
  // f(a, b) = a + b — `const`-free flat arithmetic with a `return` terminator.
  it("real lower.ts: f(a,b)=a+b → bytecode == WasmGC == JS", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;
    // IR: %2 = binary f64.add %0 %1 ; return %2
    const fn: IrFunction = {
      ...irIdentities.next("f"),
      params: [
        { value: asValueId(0), type: F64, name: "a" },
        { value: asValueId(1), type: F64, name: "b" },
      ],
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
              lhs: asValueId(0),
              rhs: asValueId(1),
              result: asValueId(2),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(2)] },
        },
      ],
      exported: true,
      valueCount: 3,
    };
    const sink = lowerToBytecode(fn);
    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      expect(runSink(sink, [a, b])).toBe(js(a, b));
      expect(await runWasmGc(src, "f", [a, b])).toBe(js(a, b));
    }
  });

  // g(a) = a * 2 — exercises a `const` (the literal 2) through real lowering.
  it("real lower.ts: g(a)=a*2 → bytecode == WasmGC == JS", async () => {
    const src = `export function g(a: number): number { return a * 2; }`;
    const js = (a: number): number => a * 2;
    // IR: %1 = const f64 2 ; %2 = binary f64.mul %0 %1 ; return %2
    const fn: IrFunction = {
      ...irIdentities.next("g"),
      params: [{ value: asValueId(0), type: F64, name: "a" }],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "const",
              value: { kind: "f64", value: 2 },
              result: asValueId(1),
              resultType: F64,
            },
            {
              kind: "binary",
              op: "f64.mul",
              lhs: asValueId(0),
              rhs: asValueId(1),
              result: asValueId(2),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(2)] },
        },
      ],
      exported: true,
      valueCount: 3,
    };
    const sink = lowerToBytecode(fn);
    for (const a of [3, -4, 0, 1.5, 1000]) {
      expect(runSink(sink, [a])).toBe(js(a));
      expect(await runWasmGc(src, "g", [a])).toBe(js(a));
    }
  });

  // h(a, b) = a > 0 ? a + b : a - b — the value-producing `if` (the bytecode
  // subset's `emitIf`), driven by real lower.ts building each arm into its own
  // sink via `emitter.newSink()` then handing both to `emitIf`.
  it("real lower.ts: h(a,b)=a>0?a+b:a-b → bytecode == WasmGC == JS", async () => {
    const src = `export function h(a: number, b: number): number { return a > 0 ? a + b : a - b; }`;
    const js = (a: number, b: number): number => (a > 0 ? a + b : a - b);
    // IR: %2 = const f64 0
    //     %3 = binary f64.gt %0 %2                 (cond)
    //     %6 = if %3 then { %4 = f64.add %0 %1 } value %4
    //              else { %5 = f64.sub %0 %1 } value %5
    //     return %6
    const fn: IrFunction = {
      ...irIdentities.next("h"),
      params: [
        { value: asValueId(0), type: F64, name: "a" },
        { value: asValueId(1), type: F64, name: "b" },
      ],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "const",
              value: { kind: "f64", value: 0 },
              result: asValueId(2),
              resultType: F64,
            },
            {
              kind: "binary",
              op: "f64.gt",
              lhs: asValueId(0),
              rhs: asValueId(2),
              result: asValueId(3),
              resultType: irVal({ kind: "i32" }),
            },
            {
              kind: "if",
              cond: asValueId(3),
              then: [
                {
                  kind: "binary",
                  op: "f64.add",
                  lhs: asValueId(0),
                  rhs: asValueId(1),
                  result: asValueId(4),
                  resultType: F64,
                },
              ],
              thenValue: asValueId(4),
              else: [
                {
                  kind: "binary",
                  op: "f64.sub",
                  lhs: asValueId(0),
                  rhs: asValueId(1),
                  result: asValueId(5),
                  resultType: F64,
                },
              ],
              elseValue: asValueId(5),
              result: asValueId(6),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(6)] },
        },
      ],
      exported: true,
      valueCount: 7,
    };
    const sink = lowerToBytecode(fn);
    for (const [a, b] of [
      [5, 3], // then-arm
      [-2, 7], // else-arm
      [0, 9], // boundary → else (0 > 0 is false)
      [1.5, -0.5],
      [-100, -1],
    ]) {
      expect(runSink(sink, [a, b])).toBe(js(a, b));
      expect(await runWasmGc(src, "h", [a, b])).toBe(js(a, b));
    }
  });
});

// ── #1584 (a1) call family — real lower.ts emits OP.CALL / OP.CALL_REF ───────
//
// The full bytecode==WasmGC==JS round-trip for a multi-function program needs
// the VM's program-wrapper + call-frame stack (sdev-vm's slice — `runProgram`).
// This emitter-side test (my lane) asserts the REAL `lowerIrFunctionBody`
// routes the `call` IR node and `closure.call`'s terminal through the typed
// emitCall/emitCallRef primitives, so the BytecodeEmitter produces the right
// opcode stream: `... CALL <funcIdx>` / `... CALL_REF <typeIdx>`. The locked
// contract (sdev-vm): args on stack arg0-deepest, callee arity from the
// function-table entry, funcref ≡ f64(tableIndex), null ≡ f64(-1).

/** Resolver that maps any func ref to a fixed table index, for call lowering. */
function callResolver(funcIdx: number): IrLowerResolver {
  let nextTypeIdx = 0;
  return {
    resolveFunc: () => funcIdx,
    resolveGlobal: () => {
      throw new Error("resolveGlobal not used in the a1 call subset");
    },
    resolveType: () => {
      throw new Error("resolveType not used in the a1 call subset");
    },
    internFuncType: () => nextTypeIdx++,
  };
}

describe("#1584 (a1) — real lower.ts drives OP.CALL through the BytecodeEmitter", () => {
  it("a `call` IR node lowers to `LOAD args…; CALL <funcIdx>; RET`", () => {
    // main(a, b): return add(a, b)  where `add` resolves to table index 1.
    //   %2 = call add(%0, %1)
    //   return %2
    const main: IrFunction = {
      ...irIdentities.next("main"),
      params: [
        { value: asValueId(0), type: F64, name: "a" },
        { value: asValueId(1), type: F64, name: "b" },
      ],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: { kind: "func", name: "add" },
              args: [asValueId(0), asValueId(1)],
              result: asValueId(2),
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [asValueId(2)] },
        },
      ],
      exported: true,
      valueCount: 3,
    };

    const sink = lowerIrFunctionBody(main, callResolver(1), new BytecodeEmitter(), new BytecodeTypeConverter()).body;
    // The call's result is single-use in the return, so it inlines: the body is
    //   LOAD 0 ; LOAD 1 ; CALL 1 ; RET
    expect(sink.code).toEqual([OP.LOAD, 0, OP.LOAD, 1, OP.CALL, 1, OP.RET]);
  });

  it("BytecodeEmitter.emitCall / emitCallRef emit OP.CALL / OP.CALL_REF with their inline operand", () => {
    const E = new BytecodeEmitter();
    const s1 = new BytecodeSink();
    E.emitCall(7, s1);
    expect(s1.code).toEqual([OP.CALL, 7]);

    const s2 = new BytecodeSink();
    E.emitCallRef(3, s2);
    expect(s2.code).toEqual([OP.CALL_REF, 3]);
  });

  it("spliceArm relocates CALL / CALL_REF as single-operand opcodes", () => {
    // An if-arm containing a CALL keeps its inline operand after splice.
    const arm = new BytecodeSink();
    arm.emit(OP.LOAD, 0);
    arm.emit(OP.CALL, 5);
    arm.emit(OP.CALL_REF, 2);
    const dest = new BytecodeSink();
    dest.spliceArm(arm);
    expect(dest.code).toEqual([OP.LOAD, 0, OP.CALL, 5, OP.CALL_REF, 2]);
  });
});

// ── #1584 (a2) struct/object family — STRUCT_NEW / STRUCT_GET / STRUCT_SET ──
//
// The full bytecode==WasmGC==JS round-trip for object.new/get/set needs the
// VM's heap (sdev-vm's slice — struct ref ≡ f64(heapIndex)). These emitter-side
// tests (my lane) assert the BytecodeEmitter realizes the (a2) trait primitives
// as the right opcodes: STRUCT_NEW carries the field COUNT; STRUCT_GET/SET carry
// the numeric field INDEX (lower.ts resolves name→fieldIdx via the layout).

/** Minimal object-struct layout: field name → index in declaration order. */
function objLayout(fields: string[]): IrObjectStructLowering {
  return { typeIdx: 99, fieldIdx: (name: string) => fields.indexOf(name) };
}

describe("#1584 (a2) — BytecodeEmitter realizes the struct/object family", () => {
  it("emitAggregateNew emits OP.STRUCT_NEW with the field count", () => {
    const E = new BytecodeEmitter();
    const s = new BytecodeSink();
    E.emitAggregateNew(objLayout(["x", "y"]), 2, s);
    expect(s.code).toEqual([OP.STRUCT_NEW, 2]);
  });

  it("emitFieldGet / emitFieldSet emit OP.STRUCT_GET / STRUCT_SET with the resolved field index", () => {
    const E = new BytecodeEmitter();
    const layout = objLayout(["x", "y", "z"]);
    const g = new BytecodeSink();
    E.emitFieldGet(layout, "y", g);
    expect(g.code).toEqual([OP.STRUCT_GET, 1]);

    const s = new BytecodeSink();
    E.emitFieldSet(layout, "z", s);
    expect(s.code).toEqual([OP.STRUCT_SET, 2]);
  });

  it("spliceArm relocates STRUCT_NEW / STRUCT_GET / STRUCT_SET as single-operand opcodes", () => {
    const arm = new BytecodeSink();
    arm.emit(OP.STRUCT_NEW, 2);
    arm.emit(OP.STRUCT_GET, 0);
    arm.emit(OP.STRUCT_SET, 1);
    const dest = new BytecodeSink();
    dest.spliceArm(arm);
    expect(dest.code).toEqual([OP.STRUCT_NEW, 2, OP.STRUCT_GET, 0, OP.STRUCT_SET, 1]);
  });
});

// ── #1584 (a3) control-flow family — block / loop / br / br_if → JZ/JNZ/JMP ──
//
// The structured `block`/`loop`/`br`/`br_if` family compiles AWAY in the
// BytecodeEmitter to JZ/JNZ/JMP + backpatch labels (issue §1c/§2a; `emitIf`
// already demonstrates the pattern for `if`). The only new VM opcode is JNZ —
// the exact dual of JZ — so `br_if`'s "branch if truthy" needs no `eqz`+`JZ`.
// `block`/`loop` add NO opcode (they resolve to backpatched targets at splice).
//
// These emitter-side tests (my lane) assert the lowering: `br`/`br_if` emit a
// JMP/JNZ placeholder + a depth-tagged pending branch; `emitLoop` resolves a
// depth-0 branch to the loop HEADER (back-edge / continue); `emitBlock` resolves
// a depth-0 branch to the block EXIT (forward / break). The De Bruijn depth is
// decremented as branches cross each enclosing construct outward. The matching
// `OP.JNZ` VM dispatch arm is sdev-vm's slice (exercised in the VM unit tests).
describe("#1584 (a3) — BytecodeEmitter realizes the control-flow family", () => {
  it("emitBr / emitBrIf emit JMP / JNZ placeholders + record a depth-tagged pending branch", () => {
    const E = new BytecodeEmitter();
    const s = new BytecodeSink();
    E.emitBr(0, s);
    E.emitBrIf(2, s);
    // Two placeholder jumps, both unpatched (-1) until an enclosing construct resolves them.
    expect(s.code).toEqual([OP.JMP, -1, OP.JNZ, -1]);
    expect(s.pendingBranches).toEqual([
      { slot: 1, depth: 0 }, // the JMP operand slot
      { slot: 3, depth: 2 }, // the JNZ operand slot
    ]);
  });

  it("emitLoop resolves a depth-0 branch to the loop HEADER (back-edge / continue)", () => {
    const E = new BytecodeEmitter();
    const body = new BytecodeSink();
    body.emit(OP.LOAD, 0);
    E.emitBr(0, body); // `br 0` — continue, targets the loop header
    const out = new BytecodeSink();
    E.emitLoop({ kind: "empty" }, body, out);
    // header = position the body begins = 0; the JMP back-edge patches to 0.
    expect(out.code).toEqual([OP.LOAD, 0, OP.JMP, 0]);
    expect(out.pendingBranches).toEqual([]); // depth-0 fully resolved
  });

  it("emitBlock resolves a depth-0 branch to the block EXIT (forward / break)", () => {
    const E = new BytecodeEmitter();
    const body = new BytecodeSink();
    E.emitBrIf(0, body); // `br_if 0` — exit-if, targets the block end
    body.emit(OP.LOAD, 1);
    const out = new BytecodeSink();
    E.emitBlock({ kind: "empty" }, body, out);
    // exit = position past the spliced body = 4; the JNZ patches to 4.
    expect(out.code).toEqual([OP.JNZ, 4, OP.LOAD, 1]);
    expect(out.pendingBranches).toEqual([]);
  });

  it("the canonical loop `block{ loop{ cond; br_if 1; body; br 0 } }` backpatches both targets", () => {
    // Mirrors the 4 fenced loop arms in lower.ts (forof.vec/iter/string, for/while).
    const E = new BytecodeEmitter();
    const loopBody = new BytecodeSink();
    loopBody.emit(OP.LOAD, 0); // cond (truthy ⇒ exit)
    E.emitBrIf(1, loopBody); // br_if 1 — exit the enclosing BLOCK
    loopBody.emit(OP.LOAD, 1); // body
    E.emitBr(0, loopBody); // br 0 — continue the LOOP

    const loopWrap = new BytecodeSink();
    E.emitLoop({ kind: "empty" }, loopBody, loopWrap);
    const out = new BytecodeSink();
    E.emitBlock({ kind: "empty" }, loopWrap, out);

    // JNZ (br_if 1) → block exit = 8 (past the whole loop);
    // JMP (br 0)    → loop header = 0 (back-edge to cond).
    expect(out.code).toEqual([OP.LOAD, 0, OP.JNZ, 8, OP.LOAD, 1, OP.JMP, 0]);
    expect(out.pendingBranches).toEqual([]); // every structured branch resolved
  });

  it("nested loops resolve each `br`/`br_if` to its own construct (De Bruijn depth)", () => {
    // outer block{ loop{ inner block{ loop{ br_if 1(inner exit); br 0(inner cont) };
    //                                   br 0(outer cont) } } }
    // Validates depth decrement as branches cross constructs outward.
    const E = new BytecodeEmitter();

    const innerBody = new BytecodeSink();
    innerBody.emit(OP.LOAD, 0);
    E.emitBrIf(1, innerBody); // exit inner block
    E.emitBr(0, innerBody); // continue inner loop
    const innerLoopWrap = new BytecodeSink();
    E.emitLoop({ kind: "empty" }, innerBody, innerLoopWrap);
    const innerBlockOut = new BytecodeSink();
    E.emitBlock({ kind: "empty" }, innerLoopWrap, innerBlockOut);
    // After inner block fully resolves, no pending branches escape it.
    expect(innerBlockOut.pendingBranches).toEqual([]);

    // Now wrap the inner block in the outer loop, appending an outer `br 0`.
    const outerBody = new BytecodeSink();
    outerBody.spliceArm(innerBlockOut);
    E.emitBr(0, outerBody); // continue outer loop
    const outerLoopWrap = new BytecodeSink();
    E.emitLoop({ kind: "empty" }, outerBody, outerLoopWrap);
    const out = new BytecodeSink();
    E.emitBlock({ kind: "empty" }, outerLoopWrap, out);

    // inner: LOAD 0; JNZ → inner-block exit (6); JMP → inner-loop header (0)
    // outer: JMP → outer-loop header (0); outer-block exit unused here
    expect(out.code).toEqual([OP.LOAD, 0, OP.JNZ, 6, OP.JMP, 0, OP.JMP, 0]);
    expect(out.pendingBranches).toEqual([]);
  });

  it("spliceArm carries an UNPATCHED structured branch outward (relocated) but still rejects a stray unpatched jump", () => {
    // A pending br to an as-yet-unseen enclosing construct survives a splice.
    const E = new BytecodeEmitter();
    const inner = new BytecodeSink();
    inner.emit(OP.LOAD, 9);
    E.emitBr(3, inner); // depth 3 — far outer construct, stays pending
    const mid = new BytecodeSink();
    mid.emit(OP.DROP);
    mid.spliceArm(inner);
    // The JMP relocated by +base (base=1 ⇒ operand slot 3) and its depth survives.
    expect(mid.code).toEqual([OP.DROP, OP.LOAD, 9, OP.JMP, -1]);
    expect(mid.pendingBranches).toEqual([{ slot: 4, depth: 3 }]);

    // A non-structured unpatched jump (no pending-branch record) is still an error.
    const bad = new BytecodeSink();
    bad.code.push(OP.JZ, -1); // hand-forged unpatched JZ, not recorded
    const dest = new BytecodeSink();
    expect(() => dest.spliceArm(bad)).toThrow(/unpatched jump/);
  });
});

// ── #1584 (a4) try-throw family — THROW + TRY_START/TRY_END + exceptionTable ──
//
// The exception ops (throw / try / rethrow) realize via a per-function STATIC
// `exceptionTable` (table-scan model, sdev-vm-locked): THROW unwinds to the
// innermost covering entry (walking call frames); TRY_START/TRY_END are runtime
// no-op region markers (the table is authoritative). The thrown value is a
// single boxed JSValue on the stack; rethrow = re-push + THROW; finally is
// compiled away in lower.ts. These emitter-side tests (my lane) assert the
// BytecodeEmitter lowering; the OP.THROW/TRY_* VM dispatch is sdev-vm's slice.
describe("#1584 (a4) — BytecodeEmitter realizes the try-throw family", () => {
  it("emitThrow / emitRethrow emit OP.THROW (rethrow = re-push caught value + THROW)", () => {
    const E = new BytecodeEmitter();
    const t = new BytecodeSink();
    E.emitThrow(7, t); // tagIdx is informational (single __exn tag)
    expect(t.code).toEqual([OP.THROW]);

    const r = new BytecodeSink();
    E.emitRethrow(0, r);
    expect(r.code).toEqual([OP.THROW]);
  });

  it("emitTry (catch) lowers to TRY_START/body/TRY_END/JMP-end/catchTarget + a table entry", () => {
    // try { LOAD 0 } catch (x) { STORE 1; LOAD 1 }
    const E = new BytecodeEmitter();
    const body = new BytecodeSink();
    body.emit(OP.LOAD, 0);
    const catchBody = new BytecodeSink();
    catchBody.emit(OP.STORE, 1); // bind payload
    catchBody.emit(OP.LOAD, 1);
    const out = new BytecodeSink();
    E.emitTry({ kind: "empty" }, body, [{ tagIdx: 5, body: catchBody }], undefined, out);

    // TRY_START<catchTarget=7>; LOAD 0; TRY_END; JMP<end=11>; STORE 1; LOAD 1
    expect(out.code).toEqual([OP.TRY_START, 7, OP.LOAD, 0, OP.TRY_END, OP.JMP, 11, OP.STORE, 1, OP.LOAD, 1]);
    // Protected region [tryStart=2, tryEnd=4) = the spliced body; spAtEntry=0.
    expect(out.exceptionTable).toEqual([{ tryStart: 2, tryEnd: 4, catchTarget: 7, spAtEntry: 0 }]);
  });

  it("emitTry (finally-only / catchAll) routes the catchAll arm as the handler", () => {
    // try { LOAD 0 } finally { LOAD 9; rethrow }  → catchAll = [LOAD 9, THROW]
    const E = new BytecodeEmitter();
    const body = new BytecodeSink();
    body.emit(OP.LOAD, 0);
    const catchAll = new BytecodeSink();
    catchAll.emit(OP.LOAD, 9);
    E.emitRethrow(0, catchAll); // finally re-throws on the leak path
    const out = new BytecodeSink();
    E.emitTry({ kind: "empty" }, body, [], catchAll, out);

    expect(out.code).toEqual([OP.TRY_START, 7, OP.LOAD, 0, OP.TRY_END, OP.JMP, 10, OP.LOAD, 9, OP.THROW]);
    expect(out.exceptionTable).toEqual([{ tryStart: 2, tryEnd: 4, catchTarget: 7, spAtEntry: 0 }]);
  });

  it("spliceArm relocates a nested try's code AND its exceptionTable by +base", () => {
    // An inner try built into its own sink, then spliced into a larger sink:
    // its TRY_START<catchTarget> operand + its table entries all shift by +base.
    const E = new BytecodeEmitter();
    const innerBody = new BytecodeSink();
    innerBody.emit(OP.LOAD, 0);
    const innerCatch = new BytecodeSink();
    innerCatch.emit(OP.DROP);
    const arm = new BytecodeSink();
    E.emitTry({ kind: "empty" }, innerBody, [{ tagIdx: 5, body: innerCatch }], undefined, arm);
    // arm: [TRY_START,7, LOAD,0, TRY_END, JMP,8, DROP], table {2,4,7,0}
    expect(arm.code).toEqual([OP.TRY_START, 7, OP.LOAD, 0, OP.TRY_END, OP.JMP, 8, OP.DROP]);
    expect(arm.exceptionTable).toEqual([{ tryStart: 2, tryEnd: 4, catchTarget: 7, spAtEntry: 0 }]);

    const dest = new BytecodeSink();
    dest.emit(OP.LOAD, 3); // base = 2 before the splice
    dest.spliceArm(arm);
    // Code relocated by +2: TRY_START operand 7→9, JMP operand 8→10.
    expect(dest.code).toEqual([OP.LOAD, 3, OP.TRY_START, 9, OP.LOAD, 0, OP.TRY_END, OP.JMP, 10, OP.DROP]);
    // Table entry relocated by +2.
    expect(dest.exceptionTable).toEqual([{ tryStart: 4, tryEnd: 6, catchTarget: 9, spAtEntry: 0 }]);
  });
});
