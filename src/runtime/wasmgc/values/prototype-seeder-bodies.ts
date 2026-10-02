// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";

/** Exact legacy descriptor encodings; accessor flags use a distinct word. */
export const PROTOTYPE_SEED_FLAGS = Object.freeze({
  method: 0xbd,
  symbolTag: 0xbc,
  constant: 0xb8,
  accessor: (1 << 4) | (1 << 5) | (1 << 2),
});

/** An already resolved value operand, never a complete descriptor operation. */
export type PrototypeSeedOperand = readonly Instr[];
export type PrototypeSeedKey =
  | { readonly kind: "string"; readonly literal: PrototypeSeedOperand }
  | { readonly kind: "symbol"; readonly symbolId: number; readonly boxSymbolIdx: number };

interface StringKey {
  readonly key: { readonly kind: "string"; readonly literal: PrototypeSeedOperand };
}

/** Planning and provider authentication remain outside this instruction recipe. */
export type PrototypeSeedEntry =
  | (StringKey & {
      readonly kind: "constructor";
      readonly value: PrototypeSeedOperand;
      readonly defineValueIdx: number;
    })
  | {
      readonly kind: "method" | "getter";
      /** Keep the exact spelling: only "@@3", not other numeric spellings, is read-only. */
      readonly member: string;
      readonly key: PrototypeSeedKey;
      readonly singleton: PrototypeSeedOperand;
      readonly defineIdx: number;
    }
  | (StringKey & {
      readonly kind: "string-data";
      readonly value: PrototypeSeedOperand;
      readonly defineValueIdx: number;
    })
  | (StringKey & {
      readonly kind: "number-data";
      readonly value: number;
      readonly boxNumberIdx: number;
      readonly defineValueIdx: number;
    })
  | (StringKey & {
      readonly kind: "accessor-pair";
      readonly getter: PrototypeSeedOperand;
      readonly setter: PrototypeSeedOperand;
      readonly defineAccessorIdx: number;
    })
  | {
      readonly kind: "symbol-tag";
      readonly value: PrototypeSeedOperand;
      readonly boxSymbolIdx: number;
      readonly defineValueIdx: number;
    };

/** Reused nested literal/singleton graphs must not be remapped twice by later passes. */
export function copyPrototypeSeedOperand(operand: PrototypeSeedOperand): Instr[] {
  return structuredClone(operand) as Instr[];
}

/** Kept separate so a legacy adapter can append this before acquiring a literal. */
export function buildPrototypeSeedReceiver(): Instr[] {
  return [{ op: "local.get", index: 0 }];
}

export function buildPrototypeSeedSymbolKey(symbolId: number, boxSymbolIdx: number): Instr[] {
  return [
    { op: "i32.const", value: symbolId },
    { op: "call", funcIdx: boxSymbolIdx },
  ];
}

export function buildPrototypeSeedCallableValue(singleton: PrototypeSeedOperand): Instr[] {
  return [...copyPrototypeSeedOperand(singleton), { op: "extern.convert_any" }];
}

export function buildPrototypeSeedNumberValue(value: number, boxNumberIdx: number): Instr[] {
  return [
    { op: "f64.const", value },
    { op: "call", funcIdx: boxNumberIdx },
  ];
}

/** The actual descriptor target returns the receiver. A void provider is not this ABI. */
export function buildPrototypeSeedDataTail(defineValueIdx: number, defineFlags: number): Instr[] {
  return [{ op: "f64.const", value: defineFlags }, { op: "call", funcIdx: defineValueIdx }, { op: "drop" }];
}

export function buildPrototypeSeedAccessorTail(defineAccessorIdx: number): Instr[] {
  return buildPrototypeSeedDataTail(defineAccessorIdx, PROTOTYPE_SEED_FLAGS.accessor);
}

export function buildPrototypeSeedMemberValue(
  member: string,
  kind: "method" | "getter",
  defineIdx: number,
  singleton: PrototypeSeedOperand,
): Instr[] {
  return [...copyPrototypeSeedOperand(singleton), ...buildPrototypeSeedMemberTail(member, kind, defineIdx)];
}

/** Append after a separately acquired callable, preserving borrowed compiler nodes. */
export function buildPrototypeSeedMemberTail(member: string, kind: "method" | "getter", defineIdx: number): Instr[] {
  return [
    { op: "extern.convert_any" },
    ...(kind === "getter"
      ? [
          // This is the descriptor helper's absent-setter slot, not JavaScript undefined.
          { op: "ref.null.extern" } as Instr,
          ...buildPrototypeSeedAccessorTail(defineIdx),
        ]
      : buildPrototypeSeedDataTail(
          defineIdx,
          member === "@@3"
            ? PROTOTYPE_SEED_FLAGS.symbolTag
            : // (#6775 S16) §20.2.3.6 `Function.prototype[@@hasInstance]` is {w:F,e:F,c:F}.
              member === "@@hasInstance"
              ? PROTOTYPE_SEED_FLAGS.constant
              : PROTOTYPE_SEED_FLAGS.method,
        )),
  ];
}

export function buildPrototypeSeedDataPropertyTail(kind: "string" | "number", defineValueIdx: number): Instr[] {
  return buildPrototypeSeedDataTail(
    defineValueIdx,
    kind === "number" ? PROTOTYPE_SEED_FLAGS.constant : PROTOTYPE_SEED_FLAGS.method,
  );
}

function keyOperand(key: PrototypeSeedKey): Instr[] {
  return key.kind === "string"
    ? copyPrototypeSeedOperand(key.literal)
    : buildPrototypeSeedSymbolKey(key.symbolId, key.boxSymbolIdx);
}

/** One actual installation; constructor/alias selection and missing obligations are not inferred here. */
export function buildPrototypeSeedEntry(entry: PrototypeSeedEntry): Instr[] {
  const receiver = buildPrototypeSeedReceiver();
  if (entry.kind === "symbol-tag")
    return [
      ...receiver,
      ...buildPrototypeSeedSymbolKey(4, entry.boxSymbolIdx),
      ...copyPrototypeSeedOperand(entry.value),
      ...buildPrototypeSeedDataTail(entry.defineValueIdx, PROTOTYPE_SEED_FLAGS.symbolTag),
    ];
  const prefix = [...receiver, ...keyOperand(entry.key)];
  switch (entry.kind) {
    case "constructor":
    case "string-data":
      return [
        ...prefix,
        ...copyPrototypeSeedOperand(entry.value),
        ...buildPrototypeSeedDataTail(entry.defineValueIdx, PROTOTYPE_SEED_FLAGS.method),
      ];
    case "number-data":
      return [
        ...prefix,
        ...buildPrototypeSeedNumberValue(entry.value, entry.boxNumberIdx),
        ...buildPrototypeSeedDataPropertyTail("number", entry.defineValueIdx),
      ];
    case "method":
    case "getter":
      return [...prefix, ...buildPrototypeSeedMemberValue(entry.member, entry.kind, entry.defineIdx, entry.singleton)];
    case "accessor-pair":
      return [
        ...prefix,
        ...buildPrototypeSeedCallableValue(entry.getter),
        ...buildPrototypeSeedCallableValue(entry.setter),
        ...buildPrototypeSeedAccessorTail(entry.defineAccessorIdx),
      ];
  }
}

/** Preserve supplied order, including constructor first. An empty list proves no provider completeness. */
export function buildPrototypeSeederBody(entries: readonly PrototypeSeedEntry[]): Instr[] {
  return entries.flatMap(buildPrototypeSeedEntry);
}
