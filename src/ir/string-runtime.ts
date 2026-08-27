// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** String operations whose observable behavior is shared by every IR backend. */
export type IrStringRuntimeIntrinsic =
  | "constant"
  | "concat"
  | "repeat"
  | "equals"
  | "length"
  | "char-at"
  | "char-code-at"
  | "iterator-char-at";

/** Audited producer evidence consumed by linear string backends. */
export type IrStringEncoding = "ascii" | "utf8-guaranteed" | "wtf16";
export type IrStringConcatMode = "immutable" | "owned-append";

export type IrStringRuntimeOperand = "string" | "number-index" | "number-count";
export type IrStringRuntimeResult = "string" | "number" | "boolean";

/** Backend-neutral callable intents attached during final IR preparation. */
export const IR_STRING_CONCAT_FN = "__ir_string_concat";
export const IR_STRING_CONCAT_OWNED_FN = "__ir_string_concat_owned";
/** Full `String.prototype.repeat` semantics over the backend's string carrier. */
export const IR_STRING_REPEAT_FN = "__ir_string_repeat";
/** Native provider for a checker-authenticated exact i32 repeat count. */
export const IR_STRING_REPEAT_COUNTED_NATIVE_FN = "__ir_string_repeat_counted_native";
/** Largest exact counted-repeat proof accepted by the native i32 kernel. */
export const IR_COUNTED_STRING_REPEAT_I32_MAX = 0x7fff_ffff;
/** Largest non-empty result whose rope-doubling intermediates stay signed-i32-safe. */
export const IR_COUNTED_STRING_REPEAT_NATIVE_MAX_RESULT_CODE_UNITS = 0x40000000;

export function irCountedStringRepeatFitsNativeKernel(tripCount: number, fragmentCodeUnits: number): boolean {
  return (
    Number.isSafeInteger(tripCount) &&
    tripCount >= 2 &&
    tripCount <= IR_COUNTED_STRING_REPEAT_I32_MAX &&
    Number.isSafeInteger(fragmentCodeUnits) &&
    fragmentCodeUnits >= 0 &&
    BigInt(tripCount) * BigInt(fragmentCodeUnits) <= BigInt(IR_COUNTED_STRING_REPEAT_NATIVE_MAX_RESULT_CODE_UNITS)
  );
}
/** Semantic prefix for an exact host-provided fixed-arity concat operation. */
export const IR_STRING_CONCAT_MANY_PREFIX = "string.concat$arity";
export const IR_STRING_EQUALS_FN = "__ir_string_equals";
export const IR_STRING_CHAR_AT_FN = "__ir_string_char_at";
export const IR_STRING_CHAR_CODE_AT_FN = "__ir_string_char_code_at";
/** String-iterator extraction: returns one full code point, unlike `char-at`'s UTF-16 code unit. */
export const IR_STRING_ITERATOR_CHAR_AT_FN = "__ir_string_iterator_char_at";
/** Prefix for per-literal backend materializers used beyond `array.new_fixed` limits. */
export const IR_STRING_LITERAL_MATERIALIZE_FN = "__ir_string_literal_materialize";
/**
 * (#4467) §7.1.17 `Number::toString(value, 10)` as a backend-neutral callable
 * intent: `(f64) -> string`, where `string` is whatever the lane's string
 * carrier is. Both wasmgc lanes bind a provider (host import / native #3912
 * formatter behind a carrier thunk), so from-ast asks no mode question — it
 * emits this call and the resolver picks the provider.
 */
export const IR_NUMBER_TO_STRING_FN = "__ir_number_to_string";
/**
 * Bounded `Number::toFixed(value, fractionDigits)` as a backend-neutral
 * callable intent. The native provider adapts the formatter's historical
 * `externref` result back to the lane's `(ref $AnyString)` carrier.
 */
export const IR_NUMBER_TO_FIXED_FN = "__ir_number_to_fixed";

export function irStringConcatManySymbol(arity: number): string {
  if (!Number.isInteger(arity) || arity < 3) {
    throw new RangeError(`string concat-many arity must be an integer >= 3, got ${arity}`);
  }
  return `${IR_STRING_CONCAT_MANY_PREFIX}${arity}`;
}

export function parseIrStringConcatManyArity(symbol: string): number | null {
  if (!symbol.startsWith(IR_STRING_CONCAT_MANY_PREFIX)) return null;
  const suffix = symbol.slice(IR_STRING_CONCAT_MANY_PREFIX.length);
  if (!/^[0-9]+$/.test(suffix)) return null;
  const arity = Number(suffix);
  return Number.isSafeInteger(arity) && arity >= 3 ? arity : null;
}

export interface IrStringIndexContract {
  readonly conversion: "ToIntegerOrInfinity";
  readonly unit: "utf16-code-unit";
  readonly omitted: 0;
  readonly outOfBounds: "empty-string" | "nan";
}

export interface IrStringRuntimeSpec {
  readonly operands: readonly IrStringRuntimeOperand[];
  readonly result: IrStringRuntimeResult;
  readonly allocatesResult: boolean;
  readonly index?: IrStringIndexContract;
  readonly count?: IrStringRepeatCountContract;
}

export interface IrStringRepeatCountContract {
  readonly conversion: "ToIntegerOrInfinity";
  readonly negative: "range-error-or-backend-trap";
  readonly positiveInfinity: "range-error-or-backend-trap";
  readonly nan: 0;
  readonly negativeZero: 0;
}

const CHAR_AT_INDEX: IrStringIndexContract = Object.freeze({
  conversion: "ToIntegerOrInfinity",
  unit: "utf16-code-unit",
  omitted: 0,
  outOfBounds: "empty-string",
});

const CHAR_CODE_AT_INDEX: IrStringIndexContract = Object.freeze({
  conversion: "ToIntegerOrInfinity",
  unit: "utf16-code-unit",
  omitted: 0,
  outOfBounds: "nan",
});

const REPEAT_COUNT: IrStringRepeatCountContract = Object.freeze({
  conversion: "ToIntegerOrInfinity",
  negative: "range-error-or-backend-trap",
  positiveInfinity: "range-error-or-backend-trap",
  nan: 0,
  negativeZero: 0,
});

/**
 * Semantic ABI for typed string IR. It contains no artifact symbols or
 * instruction encodings; concrete backends bind these operations separately.
 */
export const IR_STRING_RUNTIME: Readonly<Record<IrStringRuntimeIntrinsic, IrStringRuntimeSpec>> = Object.freeze({
  constant: Object.freeze({ operands: Object.freeze([]), result: "string", allocatesResult: true }),
  concat: Object.freeze({
    operands: Object.freeze(["string", "string"] as const),
    result: "string",
    allocatesResult: true,
  }),
  repeat: Object.freeze({
    operands: Object.freeze(["string", "number-count"] as const),
    result: "string",
    allocatesResult: true,
    count: REPEAT_COUNT,
  }),
  equals: Object.freeze({
    operands: Object.freeze(["string", "string"] as const),
    result: "boolean",
    allocatesResult: false,
  }),
  length: Object.freeze({ operands: Object.freeze(["string"] as const), result: "number", allocatesResult: false }),
  "char-at": Object.freeze({
    operands: Object.freeze(["string", "number-index"] as const),
    result: "string",
    allocatesResult: true,
    index: CHAR_AT_INDEX,
  }),
  "char-code-at": Object.freeze({
    operands: Object.freeze(["string", "number-index"] as const),
    result: "number",
    allocatesResult: false,
    index: CHAR_CODE_AT_INDEX,
  }),
  "iterator-char-at": Object.freeze({
    operands: Object.freeze(["string", "number-index"] as const),
    result: "string",
    allocatesResult: true,
  }),
});

/** ECMAScript ToIntegerOrInfinity after the caller has performed ToNumber. */
export function toIntegerOrInfinity(value: number): number {
  if (Number.isNaN(value) || value === 0) return value === 0 ? value : 0;
  if (!Number.isFinite(value)) return value;
  return Math.trunc(value);
}

/** Reference semantics used by backend-independent evidence tests. */
export function utf16CharCodeAt(value: string, position: number | undefined): number {
  const index = toIntegerOrInfinity(position ?? 0);
  if (!Number.isFinite(index) || index < 0 || index >= value.length) return Number.NaN;
  return value.charCodeAt(index);
}

/** Reference semantics used by backend-independent evidence tests. */
export function utf16CharAt(value: string, position: number | undefined): string {
  const codeUnit = utf16CharCodeAt(value, position);
  return Number.isNaN(codeUnit) ? "" : String.fromCharCode(codeUnit);
}

/** Reference semantics used by backend-independent repeat-provider tests. */
export function repeatString(value: string, count: number): string {
  const integerCount = toIntegerOrInfinity(count);
  if (integerCount < 0 || integerCount === Number.POSITIVE_INFINITY) {
    throw new RangeError("Invalid count value");
  }
  return value.repeat(integerCount);
}
