// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";

/** The primitive carrier functions the comparison reads; no provider is inferred from a signature. */
export interface StrictEqualityResources {
  readonly isNumber: FuncHandle;
  readonly unboxNumber: FuncHandle;
  readonly isBoolean: FuncHandle;
  readonly unboxBoolean: FuncHandle;
}

/**
 * (#7354 D1) `(externref, externref) -> i32` IsStrictlyEqual (§7.2.15) over the
 * values a Prepared dynamic value can hold: numbers (Number::equal, so
 * `NaN !== NaN` and `+0 === -0`), booleans, and the `undefined` singleton,
 * which is equal only to itself. Two numbers or two booleans compare by
 * payload; every other pair compares by reference (both null is equal).
 *
 * The SameValue builder (`object-same-value-body.ts`) has the same dispatch
 * shape with the other number rule and BigInt/string arms; it is pinned by the
 * #3518 replay receipts, so it is not parameterised here.
 *
 * Params a=0, b=1; locals aa=2, ba=3 (anyref).
 */
export function buildStrictEqualityBody(resources: StrictEqualityResources): Instr[] {
  const EQ_HEAP = -19; // WasmGC `eq` abstract heap type
  const both = (test: FuncHandle): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: test },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: test },
    { op: "i32.and" },
  ];
  const payloads = (unbox: FuncHandle, eq: "f64.eq" | "i32.eq"): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: unbox },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: unbox },
    { op: eq },
  ];
  const identity: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: 2 },
        { op: "ref.test", typeIdx: EQ_HEAP },
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: 3 },
        { op: "ref.test", typeIdx: EQ_HEAP },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.cast", typeIdx: EQ_HEAP },
            { op: "local.get", index: 3 },
            { op: "ref.cast", typeIdx: EQ_HEAP },
            { op: "ref.eq" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    },
  ];
  const arm = (test: FuncHandle, compare: Instr[], elseArm: Instr[]): Instr[] => [
    ...both(test),
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: compare, else: elseArm },
  ];
  return arm(
    resources.isNumber,
    payloads(resources.unboxNumber, "f64.eq"),
    arm(resources.isBoolean, payloads(resources.unboxBoolean, "i32.eq"), identity),
  );
}
