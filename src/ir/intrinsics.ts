// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Closed semantic vocabulary for the first R6 runtime-contract slice.
 *
 * These identifiers name meaning, never a concrete helper, import, or module
 * index. The initial vocabulary deliberately matches the exact deterministic,
 * exact-arity f64 Math surface certified by `IR_MATH_METHOD_TABLE`. Widening
 * any of these unions is therefore a reviewed runtime-contract change.
 */
import { effectsArePure, effectsOf } from "./effects.js";
import { irTypeEquals, type IrInstr, type IrType } from "./nodes.js";

export const PURE_MATH_INTRINSIC_IDS = Object.freeze([
  "math.abs",
  "math.atan2",
  "math.ceil",
  "math.cos",
  "math.exp",
  "math.floor",
  "math.log",
  "math.log2",
  "math.pow",
  "math.sin",
  "math.sqrt",
  "math.trunc",
] as const);

export type IntrinsicId = (typeof PURE_MATH_INTRINSIC_IDS)[number];

/**
 * Provider requirements reachable from the twelve intrinsic entry points.
 * `math.atan` and `math.reduce-trig` are provider-only dependencies and are
 * intentionally not source-level intrinsic IDs in this slice.
 */
export const PURE_MATH_RUNTIME_FEATURES = Object.freeze([
  "math.abs",
  "math.atan",
  "math.atan2",
  "math.ceil",
  "math.cos",
  "math.exp",
  "math.floor",
  "math.log",
  "math.log2",
  "math.pow",
  "math.reduce-trig",
  "math.sin",
  "math.sqrt",
  "math.trunc",
] as const);

export type RuntimeFeature = (typeof PURE_MATH_RUNTIME_FEATURES)[number];

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
  "math.abs": definition("math.abs", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.atan2": definition("math.atan2", F64_BINARY_INTRINSIC_SIGNATURE),
  "math.ceil": definition("math.ceil", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.cos": definition("math.cos", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.exp": definition("math.exp", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.floor": definition("math.floor", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.log": definition("math.log", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.log2": definition("math.log2", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.pow": definition("math.pow", F64_BINARY_INTRINSIC_SIGNATURE),
  "math.sin": definition("math.sin", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.sqrt": definition("math.sqrt", F64_UNARY_INTRINSIC_SIGNATURE),
  "math.trunc": definition("math.trunc", F64_UNARY_INTRINSIC_SIGNATURE),
});

const INTRINSIC_ID_SET: ReadonlySet<string> = new Set(PURE_MATH_INTRINSIC_IDS);

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
