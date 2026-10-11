// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { cloneInvokerOperand } from "./create-list-from-array-like-body.js";

/**
 * Complete bindings for Number(value), not a declaration of provider ownership.
 * Every predicate accepts externref and returns i32. Get is the complete scalar
 * Get(target, key, receiver), including inherited properties, getters and abrupt results;
 * a lookup returning (status, value) is not this ABI. IsCallable follows the language internal-method contract; class constructors
 * are callable by that test even though invoking their [[Call]] throws.
 *
 * method0(receiver, method) and method1(receiver, method, argument) return
 * externref. primitiveToNumber and bigintToNumber return f64. The former owns
 * native undefined/null/Boolean/Number/String conversion, including StringToNumber;
 * the latter owns the full canonical narrow/wide BigInt carrier conversion.
 * typeError(message) returns the exception payload thrown with exceptionTag.
 */
export interface NumberFromValueBindings {
  readonly get: FuncHandle;
  readonly isPrimitive: FuncHandle;
  readonly isCallable: FuncHandle;
  readonly isNullish: FuncHandle;
  readonly isSymbol: FuncHandle;
  readonly isBigInt: FuncHandle;
  readonly method0: FuncHandle;
  readonly method1: FuncHandle;
  readonly primitiveToNumber: FuncHandle;
  readonly bigintToNumber: FuncHandle;
  readonly typeError: FuncHandle;
  readonly exceptionTag: number;
  /** Each operand produces one externref, without evaluating source expressions. */
  readonly operands: {
    readonly toPrimitiveSymbol: readonly Instr[];
    readonly numberHint: readonly Instr[];
    readonly valueOfKey: readonly Instr[];
    readonly toStringKey: readonly Instr[];
    readonly nonCallableError: readonly Instr[];
    readonly nonPrimitiveError: readonly Instr[];
    readonly symbolError: readonly Instr[];
  };
}

const functionKeys = [
  "get",
  "isPrimitive",
  "isCallable",
  "isNullish",
  "isSymbol",
  "isBigInt",
  "method0",
  "method1",
  "primitiveToNumber",
  "bigintToNumber",
  "typeError",
] as const;
const operandKeys = [
  "toPrimitiveSymbol",
  "numberHint",
  "valueOfKey",
  "toStringKey",
  "nonCallableError",
  "nonPrimitiveError",
  "symbolError",
] as const;

function ownRecord(input: unknown, keys: readonly string[], detail: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("number from value: " + detail);
  const proto = Object.getPrototypeOf(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(descriptors).length !== keys.length)
    throw new Error("number from value: " + detail);
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable)
      throw new Error("number from value: " + detail + " " + key);
    captured[key] = field.value;
  }
  return captured;
}
/** Validate descriptor shape before the shared pure instruction copier consumes data. */
function auditOperand(input: unknown, active = new Set<object>()): void {
  if (input === null || ["string", "number", "boolean", "bigint"].includes(typeof input)) return;
  if (!input || typeof input !== "object" || active.has(input))
    throw new Error("number from value: invalid operand data");
  active.add(input);
  const fields = Object.getOwnPropertyDescriptors(input);
  const array = Array.isArray(input);
  for (const key of Reflect.ownKeys(fields)) {
    if (array && key === "length") continue;
    if (typeof key !== "string") throw new Error("number from value: symbol operand field");
    const field = fields[key]!;
    if (!Object.hasOwn(field, "value") || !field.enumerable)
      throw new Error("number from value: non-data operand field");
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length))
      throw new Error("number from value: extra operand array field");
    if (
      ["funcIdx", "typeIdx", "tagIdx", "index", "depth", "fieldIdx"].includes(key) &&
      (typeof field.value !== "number" || !Number.isInteger(field.value) || field.value < 0 || field.value > 0xffffffff)
    )
      throw new Error("number from value: unresolved operand coordinate");
    auditOperand(field.value, active);
  }
  active.delete(input);
}
function captureBindings(input: NumberFromValueBindings): NumberFromValueBindings {
  const fields = ownRecord(input, [...functionKeys, "exceptionTag", "operands"], "invalid binding record");
  for (const key of [...functionKeys, "exceptionTag"] as const) {
    const value = fields[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new Error("number from value: unresolved binding " + key);
  }
  const operands = ownRecord(fields.operands, operandKeys, "invalid operand record");
  for (const key of operandKeys) {
    if (!Array.isArray(operands[key]) || (operands[key] as unknown[]).length === 0)
      throw new Error("number from value: unresolved operand " + key);
    auditOperand(operands[key]);
    operands[key] = cloneInvokerOperand(operands[key], key);
  }
  return Object.freeze({ ...fields, operands: Object.freeze(operands) }) as unknown as NumberFromValueBindings;
}

const L_PRIMITIVE = 1,
  L_METHOD = 2;
function operand(body: readonly Instr[]): Instr[] {
  return structuredClone(body) as Instr[];
}
function typeError(d: NumberFromValueBindings, message: readonly Instr[]): Instr[] {
  return [...operand(message), { op: "call", funcIdx: d.typeError }, { op: "throw", tagIdx: d.exceptionTag }];
}
function getMethod(d: NumberFromValueBindings, key: readonly Instr[]): Instr[] {
  return [
    { op: "local.get", index: 0 },
    ...operand(key),
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: d.get },
    { op: "local.set", index: L_METHOD },
  ];
}
/** Called directly inside the ToPrimitive block, so br_if 1 exits that block. */
function ordinaryMethod(d: NumberFromValueBindings, key: readonly Instr[]): Instr[] {
  return [
    ...getMethod(d, key),
    { op: "local.get", index: L_METHOD },
    { op: "call", funcIdx: d.isCallable },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: L_METHOD },
        { op: "call", funcIdx: d.method0 },
        { op: "local.tee", index: L_PRIMITIVE },
        { op: "call", funcIdx: d.isPrimitive },
        { op: "br_if", depth: 1 },
      ],
    },
  ];
}

/**
 * Pure externref -> f64 Number(value) algorithm. No exception is caught here:
 * getter and invocation failures propagate unchanged. Dependencies are mandatory,
 * but only an eventual issued backend owner can attest their semantics/completion.
 */
export function buildNumberFromValueDefinition(input: NumberFromValueBindings): { locals: LocalDef[]; body: Instr[] } {
  const d = captureBindings(input);
  return {
    locals: [
      { name: "$primitive", type: { kind: "externref" } },
      { name: "$method", type: { kind: "externref" } },
    ],
    body: [
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: 0 },
          { op: "local.tee", index: L_PRIMITIVE },
          { op: "call", funcIdx: d.isPrimitive },
          { op: "br_if", depth: 0 },
          ...getMethod(d, d.operands.toPrimitiveSymbol),
          { op: "local.get", index: L_METHOD },
          { op: "call", funcIdx: d.isNullish },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_METHOD },
              { op: "call", funcIdx: d.isCallable },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: typeError(d, d.operands.nonCallableError),
              },
              { op: "local.get", index: 0 },
              { op: "local.get", index: L_METHOD },
              ...operand(d.operands.numberHint),
              { op: "call", funcIdx: d.method1 },
              { op: "local.tee", index: L_PRIMITIVE },
              { op: "call", funcIdx: d.isPrimitive },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: typeError(d, d.operands.nonPrimitiveError),
              },
              { op: "br", depth: 1 },
            ],
          },
          ...ordinaryMethod(d, d.operands.valueOfKey),
          ...ordinaryMethod(d, d.operands.toStringKey),
          ...typeError(d, d.operands.nonPrimitiveError),
        ],
      },
      { op: "local.get", index: L_PRIMITIVE },
      { op: "call", funcIdx: d.isSymbol },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: typeError(d, d.operands.symbolError),
      },
      { op: "local.get", index: L_PRIMITIVE },
      { op: "call", funcIdx: d.isBigInt },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: L_PRIMITIVE },
          { op: "call", funcIdx: d.bigintToNumber },
        ],
        else: [
          { op: "local.get", index: L_PRIMITIVE },
          { op: "call", funcIdx: d.primitiveToNumber },
        ],
      },
    ],
  };
}
