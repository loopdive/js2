// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** Predicates and SameValue return i32. NewTarget is canonical undefined for Call.
 * OrdinaryCreate() uses the actual realm Object.prototype. CreateFromConstructor
 * accepts NewTarget, uses GetPrototypeFromConstructor with %Object.prototype%
 * fallback from NewTarget's actual realm, and propagates its property-read failures.
 * ActiveFunction is the exact singleton whose call/construct body this is.
 * These are complete semantic contracts, not proof of native provider ownership.
 */
export interface ObjectConstructorBindings {
  readonly isUndefined: FuncHandle;
  readonly isNull: FuncHandle;
  readonly sameValue: FuncHandle;
  readonly ordinaryCreate: FuncHandle;
  readonly createFromConstructor: FuncHandle;
  readonly toObject: FuncHandle;
  readonly activeFunction: readonly Instr[];
}

/** ECMA-262 §20.1.1.1. Parameters are (value:externref, NewTarget:externref).
 * A different NewTarget takes precedence over value, even an existing object.
 * https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object-value
 */
export function buildObjectConstructorDefinition(d: ObjectConstructorBindings): { locals: LocalDef[]; body: Instr[] } {
  for (const key of [
    "isUndefined",
    "isNull",
    "sameValue",
    "ordinaryCreate",
    "createFromConstructor",
    "toObject",
  ] as const)
    if (!d || !Number.isSafeInteger(d[key]) || d[key] < 0)
      throw new Error("object constructor: unresolved binding " + key);
  if (!Array.isArray(d.activeFunction) || !d.activeFunction.length)
    throw new Error("object constructor: unresolved active function");
  return {
    locals: [],
    body: [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.isUndefined },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          ...structuredClone(d.activeFunction),
          { op: "call", funcIdx: d.sameValue },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 1 }, { op: "call", funcIdx: d.createFromConstructor }, { op: "return" }],
          },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.isUndefined },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.isNull },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "call", funcIdx: d.ordinaryCreate }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.toObject },
    ],
  };
}
