// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1924 — IR verifier: instruction-level type rules.
 *
 * The verifier previously checked SSA scope, dominance, branch *arity*, the
 * union trio, and return assignability — but NO per-instruction operand typing.
 * `f64.add` over two i32 values, a `binary` whose denormalized `resultType`
 * disagreed with the op's actual result, a branch arg of the wrong type, or a
 * `slot.read` out of bounds all passed verification and only failed (or silently
 * miscompiled) at the engine.
 *
 * These tests pin the new rules. They fire ONLY on a *definite* mismatch — a
 * known operand/result type whose `ValType.kind` contradicts the op — so a
 * well-formed function (and one with unknown/unannotated operand types) verifies
 * clean and is never demoted spuriously.
 */
import { describe, expect, it } from "vitest";
import {
  asBlockId,
  asValueId,
  irVal,
  verifyIrFunction,
  type IrBlock,
  type IrFunction,
  type IrInstr,
  type IrType,
} from "../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-1924");

const I32 = irVal({ kind: "i32" });
const F64 = irVal({ kind: "f64" });
const STRING: IrType = { kind: "string" };

function constF64(id: number, value: number): IrInstr {
  return { kind: "const", value: { kind: "f64", value }, result: asValueId(id), resultType: F64 };
}
function constI32(id: number, value: number): IrInstr {
  return { kind: "const", value: { kind: "i32", value }, result: asValueId(id), resultType: I32 };
}

/** A binary instr with explicit operand/result wiring (test-controlled types). */
function binary(
  id: number,
  op: IrInstr extends { kind: "binary"; op: infer O } ? O : never,
  lhs: number,
  rhs: number,
  resultType: IrType,
): IrInstr {
  return {
    kind: "binary",
    op,
    lhs: asValueId(lhs),
    rhs: asValueId(rhs),
    result: asValueId(id),
    resultType,
  } as IrInstr;
}

function block(
  id: number,
  instrs: IrInstr[],
  terminator: IrBlock["terminator"],
  blockArgs: number[] = [],
  blockArgTypes: IrType[] = [],
): IrBlock {
  return {
    id: asBlockId(id),
    blockArgs: blockArgs.map(asValueId),
    blockArgTypes,
    instrs,
    terminator,
  };
}

function singleBlockFn(name: string, instrs: IrInstr[], returnValue: number, resultType: IrType): IrFunction {
  return {
    ...irIdentities.next(name),
    params: [],
    resultTypes: [resultType],
    blocks: [block(0, instrs, { kind: "return", values: [asValueId(returnValue)] })],
    exported: false,
    valueCount: 64,
  };
}

describe("#1924 — IR verifier instruction-level type rules", () => {
  it("accepts a well-formed f64.add over two f64 operands", () => {
    const fn = singleBlockFn("ok", [constF64(1, 1), constF64(2, 2), binary(3, "f64.add", 1, 2, F64)], 3, F64);
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects f64.add over i32 operands (AC: i32-into-f64.add)", () => {
    const fn = singleBlockFn(
      "i32IntoF64Add",
      [constI32(1, 1), constI32(2, 2), binary(3, "f64.add", 1, 2, F64)],
      3,
      F64,
    );
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => /f64\.add lhs must be f64, got i32/.test(e.message))).toBe(true);
    expect(errors.some((e) => /f64\.add rhs must be f64, got i32/.test(e.message))).toBe(true);
  });

  it("rejects a wrong resultType on a binary (AC: injected wrong-resultType)", () => {
    // f64.add legitimately produces f64, but resultType claims i32.
    const fn = singleBlockFn("wrongResult", [constF64(1, 1), constF64(2, 2), binary(3, "f64.add", 1, 2, I32)], 3, I32);
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => /f64\.add resultType must be f64, got i32/.test(e.message))).toBe(true);
  });

  it("accepts an f64 comparison whose result is i32 (bool)", () => {
    const fn = singleBlockFn("cmpOk", [constF64(1, 1), constF64(2, 2), binary(3, "f64.lt", 1, 2, I32)], 3, I32);
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects an f64 comparison whose resultType claims f64", () => {
    const fn = singleBlockFn("cmpBadResult", [constF64(1, 1), constF64(2, 2), binary(3, "f64.lt", 1, 2, F64)], 3, F64);
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => /f64\.lt resultType must be i32/.test(e.message))).toBe(true);
  });

  it("does NOT constrain js.bit* operands (i32 OR f64 both valid)", () => {
    // js.bitand accepts i32 or f64 operands per the lowerer's Stage-3 fast path.
    const i32Operands = singleBlockFn(
      "jsBitI32",
      [constI32(1, 6), constI32(2, 3), binary(3, "js.bitand", 1, 2, I32)],
      3,
      I32,
    );
    expect(verifyIrFunction(i32Operands)).toEqual([]);
    const f64Operands = singleBlockFn(
      "jsBitF64",
      [constF64(1, 6), constF64(2, 3), binary(3, "js.bitand", 1, 2, F64)],
      3,
      F64,
    );
    expect(verifyIrFunction(f64Operands)).toEqual([]);
  });

  it("skips the rule when an operand type is unknown (no false positive)", () => {
    // A binary whose lhs has no resolvable type (referencing a value with no
    // resultType in the map) must NOT be flagged — the rule is conservative.
    const fn: IrFunction = {
      ...irIdentities.next("unknownOperand"),
      params: [{ name: "p", value: asValueId(1), type: F64 }],
      resultTypes: [F64],
      blocks: [
        block(
          0,
          [
            // value 2 has resultType null (effect-only const-less placeholder via raw.wasm-like) — emulate by
            // referencing param value 1 (known f64) on lhs and an unmapped value 9 on rhs.
            {
              kind: "binary",
              op: "f64.add",
              lhs: asValueId(1),
              rhs: asValueId(9),
              result: asValueId(3),
              resultType: F64,
            } as IrInstr,
          ],
          { kind: "return", values: [asValueId(3)] },
        ),
      ],
      exported: false,
      valueCount: 64,
    };
    // rhs (value 9) is unknown → skipped; lhs (param, f64) matches → no error
    // from the binary rule. (A separate use-before-def error for value 9 is
    // expected and fine; we only assert the TYPE rule did not fire.)
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => /f64\.add (lhs|rhs) must be/.test(e.message))).toBe(false);
  });

  it("rejects a branch arg whose type mismatches the target block arg", () => {
    // b0: v1 = const f64; br b1(v1)   — but b1 expects an i32 block arg.
    const fn: IrFunction = {
      ...irIdentities.next("branchArgTypeBad"),
      params: [],
      resultTypes: [I32],
      blocks: [
        block(0, [constF64(1, 3)], { kind: "br", branch: { target: asBlockId(1), args: [asValueId(1)] } }),
        block(1, [], { kind: "return", values: [asValueId(2)] }, [2], [I32]),
      ],
      exported: false,
      valueCount: 64,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => /branch arg 0 type mismatch.*passes f64.*expects i32/.test(e.message))).toBe(true);
  });

  it("accepts a branch arg whose type matches the target block arg", () => {
    const fn: IrFunction = {
      ...irIdentities.next("branchArgTypeOk"),
      params: [],
      resultTypes: [I32],
      blocks: [
        block(0, [constI32(1, 3)], { kind: "br", branch: { target: asBlockId(1), args: [asValueId(1)] } }),
        block(1, [], { kind: "return", values: [asValueId(2)] }, [2], [I32]),
      ],
      exported: false,
      valueCount: 64,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects a slot.write index out of bounds", () => {
    const fn: IrFunction = {
      ...irIdentities.next("slotOob"),
      params: [],
      resultTypes: [],
      slots: [{ index: 0, name: "s0", type: { kind: "f64" } }],
      blocks: [
        block(
          0,
          [
            constF64(1, 1),
            { kind: "slot.write", slotIndex: 5, value: asValueId(1), result: null, resultType: null } as IrInstr,
          ],
          { kind: "return", values: [] },
        ),
      ],
      exported: false,
      valueCount: 64,
    };
    const errors = verifyIrFunction(fn);
    expect(errors.some((e) => /slot\.write slot index 5 out of bounds/.test(e.message))).toBe(true);
  });

  it("accepts a string.len whose resultType is f64", () => {
    const fn: IrFunction = {
      ...irIdentities.next("strLenOk"),
      params: [{ name: "s", value: asValueId(1), type: STRING }],
      resultTypes: [F64],
      blocks: [
        block(0, [{ kind: "string.len", value: asValueId(1), result: asValueId(2), resultType: F64 } as IrInstr], {
          kind: "return",
          values: [asValueId(2)],
        }),
      ],
      exported: false,
      valueCount: 64,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });
});
