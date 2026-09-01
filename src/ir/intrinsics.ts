// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Closed semantic vocabulary for the first R6 runtime-contract slice.
 *
 * These identifiers name meaning, never a concrete helper, import, or module
 * index. The initial vocabulary deliberately matches the exact deterministic,
 * exact-arity f64 Math surface certified by `IR_MATH_METHOD_TABLE`. Widening
 * `PURE_MATH_INTRINSIC_IDS` remains the exact source-Math catalogue; other
 * reviewed semantic families are composed into `INTRINSIC_IDS` separately.
 */
import { effectsArePure, effectsOf } from "./effects.js";
import { irTypeEquals, type IrInstr, type IrType } from "./nodes.js";

export const PURE_MATH_INTRINSIC_IDS = Object.freeze([
  "math.abs",
  "math.acos",
  "math.acosh",
  "math.asin",
  "math.asinh",
  "math.atan",
  "math.atan2",
  "math.atanh",
  "math.cbrt",
  "math.ceil",
  "math.clz32",
  "math.cos",
  "math.cosh",
  "math.exp",
  "math.expm1",
  "math.floor",
  "math.fround",
  "math.imul",
  "math.log",
  "math.log10",
  "math.log1p",
  "math.log2",
  "math.max",
  "math.min",
  "math.pow",
  "math.round",
  "math.sign",
  "math.sin",
  "math.sinh",
  "math.sqrt",
  "math.tan",
  "math.tanh",
  "math.trunc",
] as const);

export const NUMERIC_COERCION_INTRINSIC_IDS = Object.freeze(["js.to_uint32"] as const);

/**
 * (#3526 F1-S1) The synchronous number boundary — the f64⇄externref carrier
 * pair the front-end used to emit as a direct named call to
 * `__box_number` / `__unbox_number` after reading a resolver mode predicate.
 * The IDs name meaning only; which provider (host import vs union-native
 * function) answers them is a frozen-manifest decision, not a front-end one.
 */
export const NUMBER_BOUNDARY_INTRINSIC_IDS = Object.freeze(["js.number.box", "js.number.unbox"] as const);

export type NumberBoundaryIntrinsicId = (typeof NUMBER_BOUNDARY_INTRINSIC_IDS)[number];

/**
 * (#3526 F1-S2) The synchronous BOOLEAN boundary — the branded-i32→externref
 * carrier the front-end used to emit as a direct named call to
 * `__box_boolean` after reading the `hasHostBooleanBox` resolver predicate.
 *
 * A deliberate SIBLING of the number constants, not a widening of them: this
 * family is one-armed. There is no `js.boolean.unbox` because there is no
 * front-end producer for one — `__unbox_boolean` is a union member with no IR
 * consumer, and the boolean capability has no widening follow-up.
 */
export const BOOLEAN_BOUNDARY_INTRINSIC_IDS = Object.freeze(["js.boolean.box"] as const);

export type BooleanBoundaryIntrinsicId = (typeof BOOLEAN_BOUNDARY_INTRINSIC_IDS)[number];

export const INTRINSIC_IDS = Object.freeze([
  ...NUMERIC_COERCION_INTRINSIC_IDS,
  ...NUMBER_BOUNDARY_INTRINSIC_IDS,
  ...BOOLEAN_BOUNDARY_INTRINSIC_IDS,
  ...PURE_MATH_INTRINSIC_IDS,
] as const);

export type IntrinsicId = (typeof INTRINSIC_IDS)[number];

/**
 * Provider requirements reachable from the thirty-three intrinsic entry points.
 * `math.reduce-trig` is the sole provider-only dependency in this slice.
 */
export const PURE_MATH_RUNTIME_FEATURES = Object.freeze([
  "math.abs",
  "math.acos",
  "math.acosh",
  "math.asin",
  "math.asinh",
  "math.atan",
  "math.atan2",
  "math.atanh",
  "math.cbrt",
  "math.ceil",
  "math.clz32",
  "math.cos",
  "math.cosh",
  "math.exp",
  "math.expm1",
  "math.floor",
  "math.fround",
  "math.imul",
  "math.log",
  "math.log10",
  "math.log1p",
  "math.log2",
  "math.max",
  "math.min",
  "math.pow",
  "math.reduce-trig",
  "math.round",
  "math.sign",
  "math.sin",
  "math.sinh",
  "math.sqrt",
  "math.tan",
  "math.tanh",
  "math.trunc",
] as const);

export const NUMERIC_COERCION_RUNTIME_FEATURES = Object.freeze(["js.to_uint32"] as const);

/** Feature rows mirror the number-boundary intrinsic IDs 1:1. */
export const NUMBER_BOUNDARY_RUNTIME_FEATURES = Object.freeze(["js.number.box", "js.number.unbox"] as const);

/** (#3526 F1-S2) The boolean-boundary feature row, 1:1 with its one ID. */
export const BOOLEAN_BOUNDARY_RUNTIME_FEATURES = Object.freeze(["js.boolean.box"] as const);

export const INTRINSIC_RUNTIME_FEATURES = Object.freeze([
  ...NUMERIC_COERCION_RUNTIME_FEATURES,
  ...NUMBER_BOUNDARY_RUNTIME_FEATURES,
  ...BOOLEAN_BOUNDARY_RUNTIME_FEATURES,
  ...PURE_MATH_RUNTIME_FEATURES,
] as const);

export type PureMathRuntimeFeature = (typeof PURE_MATH_RUNTIME_FEATURES)[number];
export type NumericCoercionRuntimeFeature = (typeof NUMERIC_COERCION_RUNTIME_FEATURES)[number];
export type NumberBoundaryRuntimeFeature = (typeof NUMBER_BOUNDARY_RUNTIME_FEATURES)[number];
export type BooleanBoundaryRuntimeFeature = (typeof BOOLEAN_BOUNDARY_RUNTIME_FEATURES)[number];
export type RuntimeFeature = (typeof INTRINSIC_RUNTIME_FEATURES)[number];

/**
 * The certified deterministic Math slice is host-free by construction.
 * Its exhaustive host-capability vocabulary is therefore empty. A later R6
 * family must widen this union before it can request an external capability;
 * `Math.random` cannot accidentally enter through a stringly import name.
 */
export const PURE_MATH_HOST_CAPABILITIES = Object.freeze([] as const);
export type HostCapability = (typeof PURE_MATH_HOST_CAPABILITIES)[number];

export const INTRINSIC_SIGNATURE_VERSION = 1 as const;
export type IntrinsicSignatureVersion = typeof INTRINSIC_SIGNATURE_VERSION;

export interface IntrinsicSignature {
  readonly version: IntrinsicSignatureVersion;
  readonly params: readonly IrType[];
  readonly result: IrType;
}

export interface IntrinsicSourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface IntrinsicUse {
  readonly id: IntrinsicId;
  readonly version: IntrinsicSignatureVersion;
  readonly argumentTypes: readonly IrType[];
  readonly resultType: IrType;
  readonly location: IntrinsicSourceLocation;
}

export interface IntrinsicDefinition {
  readonly id: IntrinsicId;
  readonly signature: IntrinsicSignature;
  readonly feature: RuntimeFeature;
}

export type IntrinsicVerificationCode =
  | "unknown-intrinsic"
  | "invalid-intrinsic-location"
  | "intrinsic-version-mismatch"
  | "intrinsic-signature-mismatch"
  | "intrinsic-effect-mismatch";

export interface IntrinsicVerificationFailure {
  readonly code: IntrinsicVerificationCode;
  readonly detail: string;
}

const F64_TYPE = Object.freeze({
  kind: "val" as const,
  val: Object.freeze({ kind: "f64" as const }),
});

/**
 * (#3526 F1-S2) The boolean carrier's PARAMETER type. `valTypeEquals` compares
 * only the ValType `kind`, so the `boolean` brand (#4503) is erasable here: the
 * signature accepts the branded carrier the from-ast arm passes without the
 * brand having to appear in the ABI. The brand stays the arm's own TYPE GATE.
 */
const I32_TYPE = Object.freeze({
  kind: "val" as const,
  val: Object.freeze({ kind: "i32" as const }),
});

const U32_TYPE = Object.freeze({
  kind: "val" as const,
  val: Object.freeze({ kind: "i32" as const }),
  signed: false as const,
});

const EXTERNREF_TYPE = Object.freeze({
  kind: "val" as const,
  val: Object.freeze({ kind: "externref" as const }),
});

/** `(f64) -> externref` — the exact ABI of the `__box_number` carrier. */
export const F64_TO_EXTERNREF_INTRINSIC_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: INTRINSIC_SIGNATURE_VERSION,
  params: Object.freeze([F64_TYPE]),
  result: EXTERNREF_TYPE,
});

/** `(externref) -> f64` — the exact ABI of the `__unbox_number` carrier. */
export const EXTERNREF_TO_F64_INTRINSIC_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: INTRINSIC_SIGNATURE_VERSION,
  params: Object.freeze([EXTERNREF_TYPE]),
  result: F64_TYPE,
});

/** `(i32) -> externref` — the exact ABI of the `__box_boolean` carrier. */
export const I32_TO_EXTERNREF_INTRINSIC_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: INTRINSIC_SIGNATURE_VERSION,
  params: Object.freeze([I32_TYPE]),
  result: EXTERNREF_TYPE,
});

export const F64_TO_U32_INTRINSIC_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: INTRINSIC_SIGNATURE_VERSION,
  params: Object.freeze([F64_TYPE]),
  result: U32_TYPE,
});

export const F64_UNARY_INTRINSIC_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: INTRINSIC_SIGNATURE_VERSION,
  params: Object.freeze([F64_TYPE]),
  result: F64_TYPE,
});

export const F64_BINARY_INTRINSIC_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: INTRINSIC_SIGNATURE_VERSION,
  params: Object.freeze([F64_TYPE, F64_TYPE]),
  result: F64_TYPE,
});

function definition(id: IntrinsicId, signature: IntrinsicSignature, feature: RuntimeFeature = id): IntrinsicDefinition {
  return Object.freeze({ id, signature, feature });
}

/** Exhaustive entry contract. Record typing makes an added ID fail closed. */
export const INTRINSIC_DEFINITIONS: Readonly<Record<IntrinsicId, IntrinsicDefinition>> = Object.freeze({
  "js.to_uint32": definition("js.to_uint32", F64_TO_U32_INTRINSIC_SIGNATURE),
  "js.number.box": definition("js.number.box", F64_TO_EXTERNREF_INTRINSIC_SIGNATURE),
  "js.number.unbox": definition("js.number.unbox", EXTERNREF_TO_F64_INTRINSIC_SIGNATURE),
  "js.boolean.box": definition("js.boolean.box", I32_TO_EXTERNREF_INTRINSIC_SIGNATURE),
  "math.abs": definition("math.abs", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.acos": definition("math.acos", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.acosh": definition("math.acosh", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.asin": definition("math.asin", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.asinh": definition("math.asinh", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.atan": definition("math.atan", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.atan2": definition("math.atan2", F64_BINARY_INTRINSIC_SIGNATURE),
  "math.atanh": definition("math.atanh", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.cbrt": definition("math.cbrt", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.ceil": definition("math.ceil", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.clz32": definition("math.clz32", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.cos": definition("math.cos", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.cosh": definition("math.cosh", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.exp": definition("math.exp", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.expm1": definition("math.expm1", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.floor": definition("math.floor", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.fround": definition("math.fround", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.imul": definition("math.imul", F64_BINARY_INTRINSIC_SIGNATURE),
  "math.log": definition("math.log", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.log10": definition("math.log10", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.log1p": definition("math.log1p", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.log2": definition("math.log2", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.max": definition("math.max", F64_BINARY_INTRINSIC_SIGNATURE),
  "math.min": definition("math.min", F64_BINARY_INTRINSIC_SIGNATURE),
  "math.pow": definition("math.pow", F64_BINARY_INTRINSIC_SIGNATURE),
  "math.round": definition("math.round", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.sign": definition("math.sign", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.sin": definition("math.sin", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.sinh": definition("math.sinh", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.sqrt": definition("math.sqrt", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.tan": definition("math.tan", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.tanh": definition("math.tanh", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.trunc": definition("math.trunc", F64_UNARY_INTRINSIC_SIGNATURE),
});

const INTRINSIC_ID_SET: ReadonlySet<string> = new Set(INTRINSIC_IDS);

export function isIntrinsicId(value: string): value is IntrinsicId {
  return INTRINSIC_ID_SET.has(value);
}

/**
 * Opaque proof that effect classification came from the existing `effectsOf`
 * authority. R6 does not grow a second throw/allocate/suspend table beside it.
 * The future intrinsic IR node can use this seam once M1 owns nodes/effects.
 */
export class IntrinsicEffectEvidence {
  readonly #pure: boolean;

  private constructor(instruction: IrInstr) {
    this.#pure = effectsArePure(effectsOf(instruction));
    Object.freeze(this);
  }

  static fromInstruction(instruction: IrInstr): IntrinsicEffectEvidence {
    return new IntrinsicEffectEvidence(instruction);
  }

  isPure(): boolean {
    return this.#pure;
  }
}

export function intrinsicEffectEvidence(instruction: IrInstr): IntrinsicEffectEvidence {
  return IntrinsicEffectEvidence.fromInstruction(instruction);
}

function signatureMismatch(use: IntrinsicUse, signature: IntrinsicSignature): string | undefined {
  if (use.argumentTypes.length !== signature.params.length) {
    return `${use.id} expects ${signature.params.length} argument(s), received ${use.argumentTypes.length}`;
  }
  for (let index = 0; index < signature.params.length; index++) {
    if (!irTypeEquals(use.argumentTypes[index]!, signature.params[index]!)) {
      return `${use.id} argument ${index} does not match its v${signature.version} signature`;
    }
  }
  if (!irTypeEquals(use.resultType, signature.result)) {
    return `${use.id} result does not match its v${signature.version} signature`;
  }
  return undefined;
}

/** Verify one semantic use before it is admitted to the manifest builder. */
export function verifyIntrinsicUse(
  use: IntrinsicUse,
  effects: IntrinsicEffectEvidence,
): IntrinsicVerificationFailure | undefined {
  if (!isIntrinsicId(use.id)) {
    return { code: "unknown-intrinsic", detail: `unknown intrinsic ${String(use.id)}` };
  }
  if (
    use.location.file.length === 0 ||
    !Number.isInteger(use.location.line) ||
    use.location.line < 1 ||
    !Number.isInteger(use.location.column) ||
    use.location.column < 0
  ) {
    return { code: "invalid-intrinsic-location", detail: `${use.id} has an invalid source location` };
  }
  const definition = INTRINSIC_DEFINITIONS[use.id];
  if (use.version !== definition.signature.version) {
    return {
      code: "intrinsic-version-mismatch",
      detail: `${use.id} uses signature v${use.version}; expected v${definition.signature.version}`,
    };
  }
  const mismatch = signatureMismatch(use, definition.signature);
  if (mismatch) return { code: "intrinsic-signature-mismatch", detail: mismatch };
  if (!(effects instanceof IntrinsicEffectEvidence) || !effects.isPure()) {
    return {
      code: "intrinsic-effect-mismatch",
      detail: `${use.id} is certified pure but its IR effect authority reports observable effects`,
    };
  }
  return undefined;
}
