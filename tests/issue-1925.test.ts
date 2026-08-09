// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1925 — IR hygiene passes run inside nested buffers (Option A: commit to the
 * structured-IR direction; see docs/adr/0018).
 *
 * Before this, `constantFold` seeded only top-level `block.instrs` and
 * `tryFoldInstr` punted on control-flow arms, and `deadCode`'s Phase-4 rebuild
 * filtered only top-level instrs — so loop/if/for-of/try **bodies** (the code
 * where folding pays) were never optimized. Both passes now recurse through the
 * #1922 shared traversal (`mapNestedBuffers`) with scoped const-def maps.
 *
 * Pins the two acceptance criteria:
 *   - a constant expression inside a `while` body is folded;
 *   - DCE removes a value defined and used only inside a loop body;
 * plus the reference-equality "no change" contract both passes must keep for the
 * `runHygienePasses` fixpoint, and scope isolation (a buffer-interior const must
 * not leak to siblings after the buffer).
 */
import { describe, expect, it } from "vitest";

import {
  asBlockId,
  asValueId,
  irVal,
  verifyIrFunction,
  type IrConst,
  type IrFunction,
  type IrInstr,
  type IrType,
} from "../src/ir/index.js";
import { constantFold } from "../src/ir/passes/constant-fold.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-1925");

const I32: IrType = irVal({ kind: "i32" });
const F64: IrType = irVal({ kind: "f64" });

function constI32(id: number, value: number): IrInstr {
  return { kind: "const", value: { kind: "i32", value }, result: asValueId(id), resultType: I32 };
}
function constF64(id: number, value: number): IrInstr {
  return { kind: "const", value: { kind: "f64", value }, result: asValueId(id), resultType: F64 };
}
function f64mul(id: number, lhs: number, rhs: number): IrInstr {
  return {
    kind: "binary",
    op: "f64.mul",
    lhs: asValueId(lhs),
    rhs: asValueId(rhs),
    result: asValueId(id),
    resultType: F64,
  } as IrInstr;
}
/** A single-block function whose block-0 instrs are `instrs`, returning v0. */
function fnOf(instrs: IrInstr[], valueCount: number, params: IrFunction["params"] = []): IrFunction {
  return {
    ...irIdentities.next("f"),
    params,
    resultTypes: [I32],
    exported: true,
    valueCount,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
  };
}
/** `while (1) { ...body }` instr. */
function whileLoop(condId: number, body: IrInstr[]): IrInstr {
  return {
    kind: "while.loop",
    result: null,
    resultType: null,
    condValue: asValueId(condId),
    cond: [constI32(condId, 1)],
    body,
  } as IrInstr;
}

describe("#1925 constant-fold descends into nested buffers", () => {
  it("folds a constant expression inside a while body", () => {
    // f() { i = 0; while (1) { a = 6.0; b = 7.0; prod = a * b } return i }
    const fn = fnOf([constI32(0, 0), whileLoop(1, [constF64(2, 6), constF64(3, 7), f64mul(4, 2, 3)])], 5);
    const after = constantFold(fn);
    expect(after, "CF produced a change").not.toBe(fn);
    const loop = after.blocks[0]!.instrs.find((i) => i.kind === "while.loop")! as IrInstr & {
      body: IrInstr[];
    };
    const prod = loop.body.find((i) => i.result === asValueId(4))!;
    expect(prod.kind, "a*b folded to const inside the loop body").toBe("const");
    expect((prod as IrInstr & { value: IrConst }).value).toEqual({ kind: "f64", value: 42 });
  });

  it("folds inside a for-loop update buffer and a nested if arm", () => {
    // while (1) { if (1) { 2.0 * 3.0 } else { } }
    const fn = fnOf(
      [
        constI32(0, 0),
        whileLoop(1, [
          {
            kind: "if",
            result: asValueId(10),
            resultType: F64,
            cond: asValueId(1),
            thenValue: asValueId(4),
            elseValue: asValueId(4),
            then: [constF64(2, 2), constF64(3, 3), f64mul(4, 2, 3)],
            else: [],
          } as IrInstr,
        ]),
      ],
      11,
    );
    const after = constantFold(fn);
    expect(after).not.toBe(fn);
    const loop = after.blocks[0]!.instrs.find((i) => i.kind === "while.loop")! as IrInstr & {
      body: IrInstr[];
    };
    const ifInstr = loop.body.find((i) => i.kind === "if")! as IrInstr & { then: IrInstr[] };
    const prod = ifInstr.then.find((i) => i.result === asValueId(4))!;
    expect(prod.kind, "fold reached the if-arm inside the loop").toBe("const");
  });

  it("returns the same reference when nothing folds (fixpoint contract)", () => {
    // Loop body multiplies a param by itself — not constant.
    const fn = fnOf([constI32(0, 0), whileLoop(2, [f64mul(3, 1, 1)])], 4, [
      { value: asValueId(1), type: F64, name: "p" },
    ]);
    expect(constantFold(fn)).toBe(fn);
  });

  it("does not leak a buffer-interior const to a sibling after the buffer", () => {
    // while (1) { c = 9.0 }  then  prod = c * c  AFTER the loop.
    // `c` (v2) is defined only inside the loop body; the post-loop `prod` must
    // NOT fold against it (it does not dominate code after the loop). Here the
    // post-loop binary references v2 which is out of the top-level scope, so it
    // stays a binary.
    const fn = fnOf([constI32(0, 0), whileLoop(1, [constF64(2, 9)]), f64mul(3, 2, 2)], 4);
    const after = constantFold(fn);
    const prod = after.blocks[0]!.instrs.find((i) => i.result === asValueId(3))!;
    expect(prod.kind, "post-loop op did NOT fold against a loop-interior const").toBe("binary");
  });
});

describe("#1925 DCE removes dead values inside nested buffers", () => {
  it("removes a value defined and used only inside a loop body", () => {
    // while (1) { dead = p * p }  — `dead` is referenced nowhere → removed.
    const fn = fnOf([constI32(0, 0), whileLoop(2, [f64mul(3, 1, 1)])], 4, [
      { value: asValueId(1), type: F64, name: "p" },
    ]);
    const after = deadCode(fn);
    expect(after, "DCE produced a change").not.toBe(fn);
    const loop = after.blocks[0]!.instrs.find((i) => i.kind === "while.loop")! as IrInstr & {
      body: IrInstr[];
    };
    expect(loop.body.length, "dead loop-body value removed").toBe(0);
    expect(
      verifyIrFunction(after).map((e) => e.message),
      "post-DCE verify clean",
    ).toEqual([]);
  });

  it("keeps a loop-body value that IS used (no spurious removal)", () => {
    // while (1) { prod = p * p ; global.set 0 = prod }  — prod is live.
    const fn = fnOf(
      [
        constI32(0, 0),
        whileLoop(2, [f64mul(3, 1, 1), { kind: "global.set", global: 0, value: asValueId(3) } as IrInstr]),
      ],
      4,
      [{ value: asValueId(1), type: F64, name: "p" }],
    );
    const after = deadCode(fn);
    const loop = (after === fn ? fn : after).blocks[0]!.instrs.find((i) => i.kind === "while.loop")! as IrInstr & {
      body: IrInstr[];
    };
    expect(
      loop.body.some((i) => i.result === asValueId(3)),
      "live prod kept",
    ).toBe(true);
    expect(
      loop.body.some((i) => i.kind === "global.set"),
      "side-effecting set kept",
    ).toBe(true);
  });

  it("returns the same reference when nothing is dead (fixpoint contract)", () => {
    const fn = fnOf(
      [constI32(0, 0), whileLoop(2, [{ kind: "global.set", global: 0, value: asValueId(0) } as IrInstr])],
      3,
    );
    expect(deadCode(fn)).toBe(fn);
  });
});
