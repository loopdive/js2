// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — the one `String.prototype` method surface the IR lowers. The
// selector, the WasmGC resolver and the linear resolver all read
// {@link stringMethodPlan}, so a call is claimed exactly when the backend that
// builds it has a plan for it. Adding a method is adding a row.
//
// Pure data and pure functions: no builder, no checker.

import type { IrBackendKind } from "./analysis/backend-legality.js";
import { NATIVE_CHARCODEAT_FN } from "./runtime-symbols.js";

/**
 * What an argument is, by the conversion the method applies to it:
 * `search` and `fill` take ToString, `position` ToIntegerOrInfinity, `length`
 * ToLength. A `position` or `length` reaches the helper as an i32.
 */
export type StringArgumentRole = "search" | "fill" | "position" | "length";

/**
 * The value an omitted (or `undefined`) argument takes: `zero`, `end` (the i32
 * `0x7fffffff` the helpers clamp to the length), `length` (the receiver's
 * length) or `space` (a one-space string).
 */
export type StringArgumentDefault = "zero" | "end" | "length" | "space";

export interface StringMethodParameter {
  readonly role: StringArgumentRole;
  /** Absent: the argument is required. */
  readonly omitted?: StringArgumentDefault;
  /** `lastIndexOf`: a NaN position searches from the end (§22.1.3.11 step 5). */
  readonly nanIsOmitted?: true;
}

/** `index` is a number the helper answers as an i32. */
export type StringMethodResult = "string" | "number" | "index" | "boolean";

/** One backend's plan for a call: the helper, its parameters after the receiver, and its result. */
export interface StringMethodPlan {
  readonly helper: string;
  /** The helper for a receiver proven ASCII, where one exists. */
  readonly asciiHelper?: string;
  readonly parameters: readonly StringMethodParameter[];
  readonly result: StringMethodResult;
  /** Both arguments literals, on a backend with the literal replace (`supportsLiteralStringReplace`). */
  readonly literalArguments?: true;
  /** A one-argument call over two immutable literal strings folds to this answer. */
  readonly fold?: (receiver: string, search: string) => boolean | number;
}

interface StringMethodRow extends Omit<StringMethodPlan, "helper"> {
  /** The helper per backend; a backend without one has no plan. */
  readonly helpers: Partial<Record<IrBackendKind, string>>;
  /** Fewer arguments than parameters accepted (default: all of them). */
  readonly maxArguments?: number;
}

const position = (omitted: StringArgumentDefault): StringMethodParameter => ({ role: "position", omitted });
const search: StringMethodParameter = { role: "search" };
const wasmgc = (helper: string): Partial<Record<IrBackendKind, string>> => ({ wasmgc: helper });

const ROWS: Readonly<Record<string, StringMethodRow>> = Object.freeze({
  toUpperCase: {
    helpers: wasmgc("__str_toUpperCase"),
    asciiHelper: "__str_toUpperCase_ascii",
    parameters: [],
    result: "string",
  },
  toLowerCase: {
    helpers: wasmgc("__str_toLowerCase"),
    asciiHelper: "__str_toLowerCase_ascii",
    parameters: [],
    result: "string",
  },
  trim: { helpers: wasmgc("__str_trim"), parameters: [], result: "string" },
  charAt: { helpers: wasmgc("__str_charAt"), parameters: [position("zero")], result: "string" },
  charCodeAt: {
    helpers: { wasmgc: NATIVE_CHARCODEAT_FN, linear: "__linear_ir_str_char_code_at" },
    parameters: [position("zero")],
    result: "number",
  },
  slice: {
    helpers: { wasmgc: "__str_slice", linear: "__str_slice" },
    parameters: [{ role: "position" }, position("length")],
    result: "string",
  },
  substring: { helpers: wasmgc("__str_substring"), parameters: [position("zero"), position("end")], result: "string" },
  indexOf: {
    helpers: wasmgc("__str_indexOf"),
    parameters: [search, position("zero")],
    maxArguments: 1,
    result: "index",
    fold: (receiver, needle) => receiver.indexOf(needle),
  },
  includes: {
    helpers: wasmgc("__str_includes"),
    parameters: [search, position("zero")],
    maxArguments: 1,
    result: "boolean",
    fold: (receiver, needle) => receiver.includes(needle),
  },
  replace: { helpers: wasmgc("__str_replace"), parameters: [search, search], result: "string", literalArguments: true },
});

/** Own rows only: `toString` / `valueOf` must not reach `Object.prototype`. */
function stringMethodRow(method: string): StringMethodRow | undefined {
  return Object.prototype.hasOwnProperty.call(ROWS, method) ? ROWS[method] : undefined;
}

/** The plan for `receiver.<method>(argCount arguments)` on `backend`, or `null` when it has none. */
export function stringMethodPlan(backend: IrBackendKind, method: string, argCount: number): StringMethodPlan | null {
  const row = stringMethodRow(method);
  const helper = row?.helpers[backend];
  if (!row || helper === undefined) return null;
  const required = row.parameters.filter((parameter) => parameter.omitted === undefined).length;
  if (argCount < required || argCount > (row.maxArguments ?? row.parameters.length)) return null;
  const { asciiHelper, parameters, result, literalArguments, fold } = row;
  return { helper, asciiHelper, parameters, result, literalArguments, fold };
}

/** Whether `symbol` names a WasmGC string-method helper (the resolver materialises them on demand). */
export function isStringMethodHelper(symbol: string): boolean {
  return Object.values(ROWS).some((row) => row.helpers.wasmgc === symbol || row.asciiHelper === symbol);
}
