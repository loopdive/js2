// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

export const sameValueNaNPath = "src/runtime/wasmgc/values/object-same-value-body.ts";
const beforeHash = "ab29f1bc725f56fc8e33c66818ee103fc316faa0c11077a9b5a20e08fde00ebb";
const afterHash = "32b7cba6e06b3a56112c2662133ee29affc4cc39a68090639bebb5401bac88c2";
const correction =
  '        // Every NaN payload/sign denotes the same Number value for SameValue.\n        ...[0, 1].flatMap((index): Instr[] => [\n          { op: "local.get", index },\n          { op: "call", funcIdx: unboxNumIdx },\n          { op: "local.get", index },\n          { op: "call", funcIdx: unboxNumIdx },\n          { op: "f64.ne" },\n        ]),\n        { op: "i32.and" },\n        { op: "i32.or" },\n';
const anchor = '        { op: "i64.eq" },\n      ],\n      else: elseArm,\n    },\n  ];\n  const nullArm';
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Exact semantic successor; historical receipts remain immutable. */
export function applySameValueNaNCorrection(source: string, inverse: boolean): string {
  if (hash(source) !== (inverse ? afterHash : beforeHash)) throw Error("SameValue NaN source mismatch");
  const from = inverse ? anchor.replace("      ],", correction + "      ],") : anchor;
  const to = inverse ? anchor : anchor.replace("      ],", correction + "      ],");
  if (source.split(from).length !== 2) throw Error("SameValue NaN span mismatch");
  const result = source.replace(from, () => to);
  if (hash(result) !== (inverse ? beforeHash : afterHash)) throw Error("SameValue NaN retained source mismatch");
  return result;
}
/**
 * #7354 D1 (2026-11-16): a later reviewed edit gives the number rule a parameter (IsStrictlyEqual's
 * Number::equal) and makes the BigInt arm optional, so the dynamic value's strict equality shares this
 * dispatch. Its exact inverse, hash-checked at both ends, re-derives the NaN-corrected source the receipts
 * start from.
 */
const foldHash = "c89a35a23349696e23912fea48a3660382e218311d1d30890404937015ce5098";
const foldSpans: readonly (readonly [current: string, previous: string])[] = [
  [
    "/** Actual dependencies of the complete existing SameValue dispatch. No provider is inferred from a signature. */\nexport type ObjectSameValueResources = PrimitiveEqualityResources & (BigIntEqualityArm | NoBigIntEqualityArm);\ninterface PrimitiveEqualityResources {\n  readonly typeofNumIdx: FuncHandle;\n",
    "/** Actual dependencies of the complete existing SameValue dispatch. No provider is inferred from a signature. */\nexport interface ObjectSameValueResources {\n  readonly typeofNumIdx: FuncHandle;\n",
  ],
  [
    "  readonly typeofBoolIdx: FuncHandle;\n  readonly unboxNumIdx: FuncHandle;\n",
    "  readonly typeofBoolIdx: FuncHandle;\n  readonly typeofBigIdx: FuncHandle;\n  readonly unboxNumIdx: FuncHandle;\n",
  ],
  [
    "  readonly unboxBoolIdx: FuncHandle;\n  /**\n   * (#7354 D1) The number rule: SameValue's by default (equal bit patterns, every NaN equal), or\n   * IsStrictlyEqual's Number::equal (`f64.eq`: `NaN !== NaN`, `+0 === -0`).\n   */\n  readonly numberEquality?: \"number-equal\";\n  readonly anyStrTypeIdx: TypeHandle;\n",
    '  readonly unboxBoolIdx: FuncHandle;\n  /** The legacy-i64 case exists only to preserve explicitly selected historical recipes. */\n  readonly bigint:\n    | { readonly kind: "carrier"; readonly equalIdx: FuncHandle }\n    | { readonly kind: "legacy-i64"; readonly toBigIdx: FuncHandle };\n  readonly anyStrTypeIdx: TypeHandle;\n',
  ],
  [
    '}\ninterface BigIntEqualityArm {\n  readonly typeofBigIdx: FuncHandle;\n  /** The legacy-i64 case exists only to preserve explicitly selected historical recipes. */\n  readonly bigint:\n    | { readonly kind: "carrier"; readonly equalIdx: FuncHandle }\n    | { readonly kind: "legacy-i64"; readonly toBigIdx: FuncHandle };\n}\n/** (#7354 D1) A comparison no BigInt can reach (the Prepared dynamic value admits none) has no BigInt arm. */\ninterface NoBigIntEqualityArm {\n  readonly typeofBigIdx?: undefined;\n  readonly bigint?: undefined;\n}\n\n',
    "}\n\n",
  ],
  [
    "export function buildObjectSameValueBody(resources: ObjectSameValueResources): Instr[] {\n  const { typeofNumIdx, typeofBoolIdx, unboxNumIdx, unboxBoolIdx, anyStrTypeIdx, strFlattenIdx, strEqualsIdx } =\n    resources;\n  const EQ_HEAP = -19; // WasmGC `eq` abstract heap type\n",
    "export function buildObjectSameValueBody(resources: ObjectSameValueResources): Instr[] {\n  const {\n    typeofNumIdx,\n    typeofBoolIdx,\n    typeofBigIdx,\n    unboxNumIdx,\n    unboxBoolIdx,\n    bigint,\n    anyStrTypeIdx,\n    strFlattenIdx,\n    strEqualsIdx,\n  } = resources;\n  const EQ_HEAP = -19; // WasmGC `eq` abstract heap type\n",
  ],
  [
    "  ];\n  const bigintArm = ({ typeofBigIdx, bigint }: BigIntEqualityArm, elseArm: Instr[]): Instr[] => [\n    ...bothTag(typeofBigIdx),\n",
    "  ];\n  const bigintArm = (elseArm: Instr[]): Instr[] => [\n    ...bothTag(typeofBigIdx),\n",
  ],
  [
    '  ];\n  const numberEqual: Instr[] = [\n    { op: "local.get", index: 0 },\n    { op: "call", funcIdx: unboxNumIdx },\n    { op: "local.get", index: 1 },\n    { op: "call", funcIdx: unboxNumIdx },\n    { op: "f64.eq" },\n  ];\n  const numberArm = (elseArm: Instr[]): Instr[] => [\n',
    "  ];\n  const numberArm = (elseArm: Instr[]): Instr[] => [\n",
  ],
  [
    '      blockType: { kind: "val", type: { kind: "i32" } },\n      then:\n        resources.numberEquality === "number-equal"\n          ? numberEqual\n          : [\n              // SameValue numbers: compare f64 bit patterns (NaN==NaN, +0!=-0).\n              { op: "local.get", index: 0 },\n              { op: "call", funcIdx: unboxNumIdx },\n              { op: "i64.reinterpret_f64" },\n              { op: "local.get", index: 1 },\n              { op: "call", funcIdx: unboxNumIdx },\n              { op: "i64.reinterpret_f64" },\n              { op: "i64.eq" },\n              // Every NaN payload/sign denotes the same Number value for SameValue.\n              ...[0, 1].flatMap((index): Instr[] => [\n                { op: "local.get", index },\n                { op: "call", funcIdx: unboxNumIdx },\n                { op: "local.get", index },\n                { op: "call", funcIdx: unboxNumIdx },\n                { op: "f64.ne" },\n              ]),\n              { op: "i32.and" },\n              { op: "i32.or" },\n            ],\n      else: elseArm,\n',
    '      blockType: { kind: "val", type: { kind: "i32" } },\n      then: [\n        // SameValue numbers: compare f64 bit patterns (NaN==NaN, +0!=-0).\n        { op: "local.get", index: 0 },\n        { op: "call", funcIdx: unboxNumIdx },\n        { op: "i64.reinterpret_f64" },\n        { op: "local.get", index: 1 },\n        { op: "call", funcIdx: unboxNumIdx },\n        { op: "i64.reinterpret_f64" },\n        { op: "i64.eq" },\n        // Every NaN payload/sign denotes the same Number value for SameValue.\n        ...[0, 1].flatMap((index): Instr[] => [\n          { op: "local.get", index },\n          { op: "call", funcIdx: unboxNumIdx },\n          { op: "local.get", index },\n          { op: "call", funcIdx: unboxNumIdx },\n          { op: "f64.ne" },\n        ]),\n        { op: "i32.and" },\n        { op: "i32.or" },\n      ],\n      else: elseArm,\n',
  ],
  [
    "  ];\n  return nullArm(numberArm(boolArm(resources.bigint === undefined ? identityArm : bigintArm(resources, identityArm))));\n}\n",
    "  ];\n  return nullArm(numberArm(boolArm(bigintArm(identityArm))));\n}\n",
  ],
];
export function beforeStrictEqualityFold(source: string): string {
  if (hash(source) !== foldHash) throw Error("SameValue fold source mismatch");
  let previous = source;
  for (const [current, before] of foldSpans) {
    if (previous.split(current).length !== 2) throw Error("SameValue fold span mismatch");
    previous = previous.replace(current, () => before);
  }
  if (hash(previous) !== afterHash) throw Error("SameValue fold retained source mismatch");
  return previous;
}
export function beforeSameValueNaNCorrection(path: string, source: string): string {
  if (path !== sameValueNaNPath || hash(source) === beforeHash) return source;
  const corrected = hash(source) === foldHash ? beforeStrictEqualityFold(source) : source;
  const before = applySameValueNaNCorrection(corrected, true);
  if (applySameValueNaNCorrection(before, false) !== corrected) throw Error("SameValue NaN replay mismatch");
  return before;
}
