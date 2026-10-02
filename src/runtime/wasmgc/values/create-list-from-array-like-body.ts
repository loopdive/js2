// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { ArgumentVectorLayout } from "./argument-vector-bodies.js";

/** Semantic dependencies only. Coordinates do not authenticate resource ownership.
 * Get preserves its original receiver; ToLength returns an integral f64 up to 2^53-1.
 * NewVector returns externref and Push returns void, using this exact vector layout.
 * Property-key classification accepts actual String/Symbol values without coercion.
 */
export interface CreateListFromArrayLikeBindings {
  readonly vector: ArgumentVectorLayout;
  readonly isObject: FuncHandle;
  readonly get: FuncHandle;
  readonly toLength: FuncHandle;
  readonly indexToString: FuncHandle;
  readonly newVector: FuncHandle;
  readonly push: FuncHandle;
  readonly typeError: FuncHandle;
  readonly exceptionTag: number;
  readonly lengthKey: readonly Instr[];
  readonly errorMessage: readonly Instr[];
  readonly isPropertyKey?: FuncHandle;
}
export type CreateListElementTypes = "all" | "property-key";

function fail(detail: string): never {
  throw new Error("invoker body bindings: " + detail);
}
/** Inspect own descriptors before consuming data; never invoke a configuration getter. */
export function invokerBodyOwnData(record: unknown, key: string): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("expected data record");
  const field = Object.getOwnPropertyDescriptor(record, key);
  if (!field || !Object.hasOwn(field, "value")) fail("missing/non-data binding " + key);
  return field.value;
}
export function invokerBodyCoordinate(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    fail("invalid coordinate " + key);
  return value;
}
export function captureInvokerVector(input: unknown): ArgumentVectorLayout {
  return {
    objVecTypeIdx: invokerBodyCoordinate(invokerBodyOwnData(input, "objVecTypeIdx"), "objVecTypeIdx"),
    objVecArrTypeIdx: invokerBodyCoordinate(invokerBodyOwnData(input, "objVecArrTypeIdx"), "objVecArrTypeIdx"),
  };
}
/** Clone plain instruction data recursively, rejecting nested accessors, cycles and holes. */
export function cloneInvokerOperand(input: unknown, key: string): Instr[] {
  const active = new Set<object>();
  const clone = (value: unknown): unknown => {
    if (value === null || ["string", "number", "boolean", "bigint"].includes(typeof value)) return value;
    if (!value || typeof value !== "object" || active.has(value)) fail("invalid operand data " + key);
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      !(Array.isArray(value) && prototype === Array.prototype)
    )
      fail("non-plain operand data " + key);
    active.add(value);
    const fields = Object.getOwnPropertyDescriptors(value);
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (!Object.hasOwn(fields, String(i))) fail("sparse operand data " + key);
    }
    for (const field of Reflect.ownKeys(fields)) {
      if (Array.isArray(value) && field === "length") continue;
      if (typeof field !== "string") fail("symbol operand field " + key);
      const descriptor = fields[field]!;
      if (!Object.hasOwn(descriptor, "value")) fail("non-data operand field " + key);
      Object.defineProperty(result, field, {
        value: clone(descriptor.value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    active.delete(value);
    return result;
  };
  const result = clone(input);
  if (!Array.isArray(result) || result.length === 0) fail("missing operand " + key);
  for (const instruction of result)
    if (typeof invokerBodyOwnData(instruction, "op") !== "string") fail("invalid instruction " + key);
  return result as Instr[];
}

/** ECMA-262 2026 §7.3.19. Parameter 0 is obj; result is the authentic (ref V).
 * Reads length once, then every indexed Get in order. No HasProperty or iterator.
 * No integer narrowing or length pre-cap: early observable failures precede allocation limits.
 */
export function buildCreateListFromArrayLikeDefinition(
  input: CreateListFromArrayLikeBindings,
  elementTypes: CreateListElementTypes = "all",
): { locals: LocalDef[]; body: Instr[] } {
  if (elementTypes !== "all" && elementTypes !== "property-key") throw new Error("CreateList body: unknown mode");
  const roles = [
    "isObject",
    "get",
    "toLength",
    "indexToString",
    "newVector",
    "push",
    "typeError",
    "exceptionTag",
  ] as const;
  const d = Object.fromEntries(
    roles.map((key) => [key, invokerBodyCoordinate(invokerBodyOwnData(input, key), key)]),
  ) as Record<(typeof roles)[number], number>;
  const vector = captureInvokerVector(invokerBodyOwnData(input, "vector"));
  const lengthKey = cloneInvokerOperand(invokerBodyOwnData(input, "lengthKey"), "lengthKey");
  const errorMessage = cloneInvokerOperand(invokerBodyOwnData(input, "errorMessage"), "errorMessage");
  const propertyField = Object.getOwnPropertyDescriptor(input, "isPropertyKey");
  const isPropertyKey =
    propertyField || elementTypes === "property-key"
      ? invokerBodyCoordinate(invokerBodyOwnData(input, "isPropertyKey"), "isPropertyKey")
      : undefined;
  const error = (): Instr[] => [
    ...cloneInvokerOperand(errorMessage, "errorMessage"),
    { op: "call", funcIdx: d.typeError },
    { op: "throw", tagIdx: d.exceptionTag },
  ];
  return {
    locals: [
      { name: "$length", type: { kind: "f64" } },
      { name: "$index", type: { kind: "f64" } },
      { name: "$vector", type: { kind: "externref" } },
      { name: "$element", type: { kind: "externref" } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.isObject },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: error() },
      { op: "local.get", index: 0 },
      ...lengthKey,
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.get },
      { op: "call", funcIdx: d.toLength },
      { op: "local.set", index: 1 },
      { op: "call", funcIdx: d.newVector },
      { op: "local.set", index: 3 },
      { op: "f64.const", value: 0 },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: d.indexToString },
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: d.get },
              { op: "local.set", index: 4 },
              ...(elementTypes === "property-key"
                ? ([
                    { op: "local.get", index: 4 },
                    { op: "call", funcIdx: isPropertyKey! },
                    { op: "i32.eqz" },
                    { op: "if", blockType: { kind: "empty" }, then: error() },
                  ] as Instr[])
                : []),
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "call", funcIdx: d.push },
              { op: "local.get", index: 2 },
              { op: "f64.const", value: 1 },
              { op: "f64.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 3 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: vector.objVecTypeIdx },
    ],
  };
}
