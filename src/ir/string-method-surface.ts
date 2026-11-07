// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — the one `String.prototype` method surface the IR lowers. The
// selector, the WasmGC resolver and the linear resolver all read
// {@link stringMethodPlan}, so a call is claimed exactly when the backend that
// builds it has a plan for it: a helper, or the typed string intrinsic. Adding
// a method is adding a row.
//
// Pure data and pure functions: no builder, no checker.

import { stripParens } from "../shared/binding-writes.js";
import { ts } from "../ts-api.js";
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

/**
 * One backend's plan for a call: the helper, its parameters after the receiver,
 * and its result. Without a helper the call lowers only through the typed
 * string intrinsic, which needs the receiver's encoding evidence.
 */
export interface StringMethodPlan {
  readonly helper?: string;
  /** `charAt` / `charCodeAt`: a receiver with encoding evidence lowers to the typed string intrinsic. */
  readonly typedIntrinsic?: true;
  /**
   * `charCodeAt`: a resolver that keeps the #3931 char-read loop on a `const`
   * substring receiver (`preferLegacyFlatSubstringCharCodeAt`) declines it.
   */
  readonly flatSubstringReceiverPrefersLegacy?: true;
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
  /** The helper per backend; a backend with neither a helper nor the typed intrinsic has no plan. */
  readonly helpers: Partial<Record<IrBackendKind, string>>;
}

const position = (omitted: StringArgumentDefault): StringMethodParameter => ({ role: "position", omitted });
const search: StringMethodParameter = { role: "search" };
const caseRow = (helper: string): StringMethodRow => ({
  helpers: wasmgc(helper),
  asciiHelper: `${helper}_ascii`,
  parameters: [],
  result: "string",
});
const trimRow = (helper: string): StringMethodRow => ({ helpers: wasmgc(helper), parameters: [], result: "string" });
const padRow = (helper: string): StringMethodRow => ({
  helpers: wasmgc(helper),
  parameters: [
    { role: "length", omitted: "zero" },
    { role: "fill", omitted: "space" },
  ],
  result: "string",
});
const searchRow = (helper: string, omitted: StringArgumentDefault): StringMethodRow => ({
  helpers: wasmgc(helper),
  parameters: [search, position(omitted)],
  result: "boolean",
});
const replaceRow = (helper: string): StringMethodRow => ({
  helpers: wasmgc(helper),
  parameters: [search, search],
  result: "string",
  literalArguments: true,
});
const wasmgc = (helper: string): Partial<Record<IrBackendKind, string>> => ({ wasmgc: helper });

const ROWS: Readonly<Record<string, StringMethodRow>> = Object.freeze({
  toUpperCase: caseRow("__str_toUpperCase"),
  toLowerCase: caseRow("__str_toLowerCase"),
  // Without ECMA-402 the locale forms are the default case mappings (§22.1.3.27 / §22.1.3.29).
  toLocaleUpperCase: caseRow("__str_toUpperCase"),
  toLocaleLowerCase: caseRow("__str_toLowerCase"),
  trim: trimRow("__str_trim"),
  trimStart: trimRow("__str_trimStart"),
  trimEnd: trimRow("__str_trimEnd"),
  padStart: padRow("__str_padStart"),
  padEnd: padRow("__str_padEnd"),
  charAt: { helpers: wasmgc("__str_charAt"), typedIntrinsic: true, parameters: [position("zero")], result: "string" },
  charCodeAt: {
    helpers: { wasmgc: NATIVE_CHARCODEAT_FN, linear: "__linear_ir_str_char_code_at" },
    typedIntrinsic: true,
    flatSubstringReceiverPrefersLegacy: true,
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
    result: "index",
    fold: (receiver, needle) => receiver.indexOf(needle),
  },
  lastIndexOf: {
    helpers: wasmgc("__str_lastIndexOf"),
    parameters: [search, { role: "position", omitted: "end", nanIsOmitted: true }],
    result: "index",
  },
  includes: { ...searchRow("__str_includes", "zero"), fold: (receiver, needle) => receiver.includes(needle) },
  startsWith: searchRow("__str_startsWith", "zero"),
  endsWith: searchRow("__str_endsWith", "end"),
  replace: replaceRow("__str_replace"),
  // (#7313) The same `$`-pattern GetSubstitution helper legacy calls.
  replaceAll: replaceRow("__str_replaceAll"),
});

/** Own rows only: `toString` / `valueOf` must not reach `Object.prototype`. */
function stringMethodRow(method: string): StringMethodRow | undefined {
  return Object.prototype.hasOwnProperty.call(ROWS, method) ? ROWS[method] : undefined;
}

/** The plan for `receiver.<method>(argCount arguments)` on `backend`, or `null` when it has none. */
export function stringMethodPlan(backend: IrBackendKind, method: string, argCount: number): StringMethodPlan | null {
  const row = stringMethodRow(method);
  const helper = row?.helpers[backend];
  if (!row || (helper === undefined && !row.typedIntrinsic)) return null;
  const required = row.parameters.filter((parameter) => parameter.omitted === undefined).length;
  if (argCount < required || argCount > row.parameters.length) return null;
  const { typedIntrinsic, flatSubstringReceiverPrefersLegacy, asciiHelper, parameters, result } = row;
  const { literalArguments, fold } = row;
  return {
    helper,
    typedIntrinsic,
    flatSubstringReceiverPrefersLegacy,
    asciiHelper,
    parameters,
    result,
    literalArguments,
    fold,
  };
}

/** Whether `symbol` names a WasmGC string-method helper (the resolver materialises them on demand). */
export function isStringMethodHelper(symbol: string): boolean {
  return Object.values(ROWS).some((row) => row.helpers.wasmgc === symbol || row.asciiHelper === symbol);
}

type StaticStringMethodArgument = "undefined" | "null" | "true" | "false";

/**
 * A literal argument whose conversions are static: `undefined` (or `void 0`),
 * `null`, `true` or `false`; the value is its ToString. A shadowed
 * `undefined` (`isGlobalUndefined` false) is a value.
 */
export function staticStringMethodArgument(
  expression: ts.Expression,
  isGlobalUndefined: (identifier: ts.Identifier) => boolean,
): StaticStringMethodArgument | undefined {
  const arg = stripParens(expression);
  if (ts.isIdentifier(arg)) return arg.text === "undefined" && isGlobalUndefined(arg) ? "undefined" : undefined;
  if (ts.isVoidExpression(arg)) return ts.isNumericLiteral(arg.expression) ? "undefined" : undefined;
  if (arg.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (arg.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return arg.kind === ts.SyntaxKind.NullKeyword ? "null" : undefined;
}
