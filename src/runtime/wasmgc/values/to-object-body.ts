// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

/**
 * Semantic bindings, not provider-ownership evidence. Predicates take externref
 * and return i32 without observable property access. Factories take the unchanged
 * primitive and return a fresh wrapper with its real realm intrinsic prototype.
 * stringCreate must implement the complete String exotic operation; ordinary
 * wrapper storage alone does not satisfy it. No public constructor is invoked.
 * typeError(message) returns the payload thrown with the parent's actual tag.
 */
export interface ToObjectBindings {
  readonly isUndefined: FuncHandle;
  readonly isNull: FuncHandle;
  readonly isBoolean: FuncHandle;
  readonly isNumber: FuncHandle;
  readonly isString: FuncHandle;
  readonly isSymbol: FuncHandle;
  readonly isBigInt: FuncHandle;
  readonly booleanCreate: FuncHandle;
  readonly numberCreate: FuncHandle;
  readonly stringCreate: FuncHandle;
  readonly symbolCreate: FuncHandle;
  readonly bigintCreate: FuncHandle;
  readonly typeError: FuncHandle;
  readonly exceptionTag: number;
  /** Compiler-owned operand producing one externref String, evaluated only on error. */
  readonly errorMessage: readonly Instr[];
}
const wrappers = [
  ["isBoolean", "booleanCreate"],
  ["isNumber", "numberCreate"],
  ["isString", "stringCreate"],
  ["isSymbol", "symbolCreate"],
  ["isBigInt", "bigintCreate"],
] as const;
const coordinates = ["isUndefined", "isNull", ...wrappers.flat(), "typeError", "exceptionTag"] as const;
function fail(detail: string): never {
  throw new Error("ToObject body: " + detail);
}
function capture(input: ToObjectBindings): ToObjectBindings {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("bindings must be a data record");
  const fields = Object.getOwnPropertyDescriptors(input);
  const own = (key: keyof ToObjectBindings): unknown => {
    if (!Object.hasOwn(fields, key) || !Object.hasOwn(fields[key]!, "value")) fail("missing/non-data binding " + key);
    return fields[key]!.value;
  };
  const result = Object.fromEntries(
    coordinates.map((key) => {
      const value = own(key);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
        fail("invalid coordinate " + key);
      return [key, value];
    }),
  );
  const message = own("errorMessage");
  if (!Array.isArray(message) || message.length === 0) fail("missing error-message operand");
  return { ...result, errorMessage: structuredClone(message) } as unknown as ToObjectBindings;
}
/** Complete ToObject control flow; physical provider completion is the caller's obligation. */
export function buildToObjectDefinition(input: ToObjectBindings): { locals: LocalDef[]; body: Instr[] } {
  const d = capture(input);
  const body: Instr[] = [];
  for (const predicate of [d.isUndefined, d.isNull]) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: predicate },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...structuredClone(d.errorMessage),
          { op: "call", funcIdx: d.typeError },
          { op: "throw", tagIdx: d.exceptionTag },
        ],
        else: [],
      },
    );
  }
  for (const [predicate, factory] of wrappers) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d[predicate] },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: d[factory] }, { op: "return" }],
        else: [],
      },
    );
  }
  // Every remaining ECMAScript value is already an Object, including proxies,
  // callable objects and primitive wrappers. Do not inspect or coerce it.
  body.push({ op: "local.get", index: 0 });
  return { locals: [], body };
}
