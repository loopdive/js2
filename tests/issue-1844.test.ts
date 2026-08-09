// #1844 — IR verifier must recurse into nested if/try/loop buffers.
//
// Before this fix, `verifyIrFunction` scanned only top-level `block.instrs`.
// Values defined inside `then`/`else`/`try`/`catch`/`finally`/loop buffers
// were invisible to:
//   1. the #1798 return-type assignability gate (`operandIrType` returned
//      `null` → the gate silently `continue`d), and
//   2. the SSA single-def / use-before-def invariants.
// So a malformed nested body slipped past the verifier and failed Wasm
// validation only at instantiate time (or threw in the lowerer) instead of
// demoting cleanly to legacy. These tests pin the recursion.

import { describe, expect, it } from "vitest";

import { asBlockId, asValueId, irVal, verifyIrFunction, type IrFunction, type IrInstr } from "../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-1844");

const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });

function constF64(id: number, value: number): IrInstr {
  return {
    kind: "const",
    value: { kind: "f64", value },
    result: asValueId(id),
    resultType: F64,
  };
}

function constI32(id: number, value: number): IrInstr {
  return {
    kind: "const",
    value: { kind: "i32", value },
    result: asValueId(id),
    resultType: I32,
  };
}

describe("#1844 — IR verifier recurses into nested buffers", () => {
  it("accepts a value defined inside an if-arm and returned via the if result", () => {
    // function f(): f64 {
    //   const cond = ...;  (id 1, supplied as param-free precomputed bool)
    //   const r = if (cond) { const a = 1; a } else { const b = 2; b };
    //   return r;
    // }
    const cond = asValueId(1);
    const a = asValueId(2);
    const b = asValueId(3);
    const r = asValueId(4);
    const fn: IrFunction = {
      ...irIdentities.next("f"),
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "bool", value: true }, result: cond, resultType: irVal({ kind: "i32" }) },
            {
              kind: "if",
              cond,
              then: [constF64(2, 1)],
              thenValue: a,
              else: [constF64(3, 2)],
              elseValue: b,
              result: r,
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [r] },
        },
      ],
      exported: false,
      valueCount: 8,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("flags a duplicate SSA def that lives inside a nested if-arm", () => {
    // value id 2 is defined twice: once at top level, once inside an if-arm.
    const cond = asValueId(1);
    const dup = asValueId(2);
    const elseV = asValueId(3);
    const ifRes = asValueId(4);
    const fn: IrFunction = {
      ...irIdentities.next("dupNested"),
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "bool", value: true }, result: cond, resultType: irVal({ kind: "i32" }) },
            constF64(2, 9), // top-level def of id 2
            {
              kind: "if",
              cond,
              then: [constF64(2, 1)], // duplicate def of id 2 inside the arm
              thenValue: dup,
              else: [constF64(3, 2)],
              elseValue: elseV,
              result: ifRes,
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [ifRes] },
        },
      ],
      exported: false,
      valueCount: 8,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => e.message.includes("duplicate SSA def for value"))).toBe(true);
  });

  it("fires the #1798 return-type gate on a value defined inside a try body", () => {
    // function g(): f64 { try { const x = <i32 1>; return x; } ... }
    // The returned value `x` is i32 but the declared result is f64 — invalid.
    // Pre-fix this slipped past because `operandIrType` never scanned the try
    // body, returned null, and the gate `continue`d.
    const x = asValueId(1);
    const fn: IrFunction = {
      ...irIdentities.next("g"),
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "try",
              body: [constI32(1, 1)],
              result: null,
              resultType: null,
            },
          ],
          // The return references a value defined inside the try body.
          terminator: { kind: "return", values: [x] },
        },
      ],
      exported: false,
      valueCount: 8,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => e.message.includes("not assignable to declared result"))).toBe(true);
  });

  it("flags use-before-def inside a nested if-arm", () => {
    // Inside the if-arm, an instruction references an SSA value (id 7) that is
    // never defined anywhere — must be reported, not silently ignored.
    const cond = asValueId(1);
    const undef = asValueId(7);
    const sum = asValueId(2);
    const elseV = asValueId(3);
    const ifRes = asValueId(4);
    const fn: IrFunction = {
      ...irIdentities.next("useBeforeDefNested"),
      params: [],
      resultTypes: [F64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "bool", value: true }, result: cond, resultType: irVal({ kind: "i32" }) },
            {
              kind: "if",
              cond,
              // `binary` uses id 7 (undef) and id 7 again — never defined.
              then: [
                {
                  kind: "binary",
                  op: "f64.add",
                  lhs: undef,
                  rhs: undef,
                  result: sum,
                  resultType: F64,
                } as IrInstr,
              ],
              thenValue: sum,
              else: [constF64(3, 2)],
              elseValue: elseV,
              result: ifRes,
              resultType: F64,
            },
          ],
          terminator: { kind: "return", values: [ifRes] },
        },
      ],
      exported: false,
      valueCount: 8,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => e.message.includes("before def"))).toBe(true);
  });
});
