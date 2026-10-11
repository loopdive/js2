// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../src/wasm/model/instructions.js";
import type { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import type { NativeBigIntReservations } from "../../src/backend/wasmgc/resources/native-bigint.js";

export const bigintOperandValues = {
  zero: 0n,
  one: 1n,
  negative: -1n,
  minimum: -(1n << 63n),
  maximum: (1n << 63n) - 1n,
  wide63: 1n << 63n,
  wide64: 1n << 64n,
  wide64one: (1n << 64n) + 1n,
  wideNegative: -(1n << 64n),
  wide96one: (1n << 96n) + 1n,
  wide96high: (1n << 96n) + (1n << 64n) + 1n,
  wide96low: (1n << 96n) + 2n,
} as const;
export type BigIntOperand = keyof typeof bigintOperandValues;

/** Test observers materialize known canonical operands; they grant no producer acceptance. */
export function reserveBigIntOperands(tx: PhysicalModuleReservations) {
  return Object.fromEntries(
    Object.keys(bigintOperandValues).map((name) => [
      name,
      tx.reserveFunction("observer:bigint:" + name, name, { params: [], results: [{ kind: "externref" }] }),
    ]),
  ) as Record<BigIntOperand, ReturnType<PhysicalModuleReservations["reserveFunction"]>>;
}

export function fillBigIntOperands(
  tx: PhysicalModuleReservations,
  pack: NativeBigIntReservations,
  operands: ReturnType<typeof reserveBigIntOperands>,
) {
  for (const [name, value] of Object.entries(bigintOperandValues)) {
    let body: Instr[];
    if (value >= -(1n << 63n) && value < 1n << 63n) {
      body = [
        { op: "i64.const", value },
        { op: "call", funcIdx: pack.box.handle },
      ];
    } else {
      const limbs: Instr[] = [];
      for (let rest = value < 0n ? -value : value; rest > 0n; rest >>= 32n)
        limbs.push({ op: "i32.const", value: Number(BigInt.asIntN(32, rest & 0xffffffffn)) });
      body = [
        { op: "i64.const", value: BigInt.asIntN(64, value) },
        { op: "i32.const", value: value < 0n ? -1 : 1 },
        ...limbs,
        { op: "array.new_fixed", typeIdx: pack.limbs.typeIndex, length: limbs.length },
        { op: "struct.new", typeIdx: pack.wide.typeIndex },
        { op: "extern.convert_any" },
      ];
    }
    tx.fillFunction(operands[name as BigIntOperand], { locals: [], body });
  }
}

export const bigintComparisonCases: readonly [BigIntOperand, BigIntOperand][] = [
  ["zero", "zero"],
  ["minimum", "minimum"],
  ["maximum", "maximum"],
  ["one", "negative"],
  ["wide63", "minimum"],
  ["minimum", "wide63"],
  ["wide64", "zero"],
  ["zero", "wide64"],
  ["wide64one", "one"],
  ["one", "wide64one"],
  ["wide64", "wide64"],
  ["wideNegative", "wideNegative"],
  ["wide64", "wideNegative"],
  ["wide64one", "wide96one"],
  ["wide96one", "wide96high"],
  ["wide96one", "wide96low"],
  ["wide96high", "wide96high"],
];
