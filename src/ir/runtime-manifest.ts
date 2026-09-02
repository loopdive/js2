// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Deterministic R6 semantic-runtime manifest for the certified pure-Math slice.
 *
 * The builder is the preparation-time mutation boundary. `freeze()` verifies
 * intrinsic contracts, expands provider dependencies to a fixed point,
 * validates cycles and target/backend adapters, and publishes only deeply
 * frozen arrays/records. Lowering receives lookup-only `resolveProvider` calls;
 * a request absent from the frozen plan is a typed invariant.
 */
import {
  irTypeEquals,
  type IrIntrinsicBackendComposite,
  type IrIntrinsicBackendOp,
  type IrIntrinsicBackendSequence,
} from "./nodes.js";
import {
  ASYNC_OPTIONAL_RUNTIME_FEATURES,
  ASYNC_RUNTIME_FEATURES,
  ASYNC_RUNTIME_PROVIDERS,
  ASYNC_RUNTIME_PROVIDER_IDS,
  type AsyncRuntimeFeature,
  type AsyncRuntimeProviderId,
} from "./async-runtime-providers.js";
import {
  canonicalizeRuntimeHostCapabilityCatalog,
  isRuntimeHostCapabilityFuncId,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_IDS,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityFuncId,
  type RuntimeHostCapabilityId,
  type RuntimeHostCapabilityRecord,
} from "./runtime-host-capabilities.js";
import {
  EXTERN_BOUNDARY_RUNTIME_FEATURES,
  EXTERNREF_TO_F64_INTRINSIC_SIGNATURE,
  EXTERNREF_TO_I32_INTRINSIC_SIGNATURE,
  F64_BINARY_INTRINSIC_SIGNATURE,
  F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
  F64_TO_U32_INTRINSIC_SIGNATURE,
  F64_UNARY_INTRINSIC_SIGNATURE,
  EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE,
  INTRINSIC_DEFINITIONS,
  BOOLEAN_BOUNDARY_RUNTIME_FEATURES,
  I32_TO_EXTERNREF_INTRINSIC_SIGNATURE,
  NUMBER_BOUNDARY_RUNTIME_FEATURES,
  NUMERIC_COERCION_RUNTIME_FEATURES,
  PURE_MATH_HOST_CAPABILITIES,
  PURE_MATH_RUNTIME_FEATURES,
  type IntrinsicEffectEvidence,
  type IntrinsicId,
  type IntrinsicSignature,
  type IntrinsicUse,
  type IntrinsicVerificationCode,
  type BooleanBoundaryRuntimeFeature,
  type ExternBoundaryRuntimeFeature,
  type NumberBoundaryRuntimeFeature,
  type PureMathRuntimeFeature,
  type RuntimeFeature as IntrinsicRuntimeFeature,
  verifyIntrinsicUse,
} from "./intrinsics.js";

export type RuntimeTarget = "host" | "strict-no-host" | "standalone" | "wasi";
export type RuntimeBackend = "wasmgc" | "linear";
export type RuntimeFeature =
  | IntrinsicRuntimeFeature
  | AsyncRuntimeFeature
  | GeneratorNumberBoxRuntimeFeature
  | StringCompareRuntimeFeature
  | StringEqRuntimeFeature;
export type HostCapabilityId = RuntimeHostCapabilityId;

export const RUNTIME_BACKEND_REQUIREMENTS = Object.freeze([
  "async.native.drive",
  "async.native.number-boundary",
  "async.native.undefined",
] as const);
export type RuntimeBackendRequirement = (typeof RUNTIME_BACKEND_REQUIREMENTS)[number];

/**
 * (#3526 F1-S1) The exact, already-resolved number-boundary provider policy of
 * ONE preparation caller. `target` alone cannot answer this: ordinary
 * host-assisted GC, GC native-first, and host-assisted GC with explicit native
 * strings all map to `target: "host"` while the existing box/unbox decision
 * additionally depends on `nativeStrings` and `semanticProviders`. Callers
 * resolve their truth table BEFORE freeze; nothing below reads a live codegen
 * context.
 */
export interface NumberBoundaryPolicy {
  /** `host` selects `env.__box_number`. There is no native box arm in F1-S1. */
  readonly box: "host" | "unsupported";
  /** `host` selects `env.__unbox_number`; `native` the union-native function. */
  readonly unbox: "host" | "native" | "unsupported";
}

/** Adapters that expose no number boundary resolve both arms to this. */
export const NUMBER_BOUNDARY_POLICY_DISABLED: NumberBoundaryPolicy = Object.freeze({
  box: "unsupported",
  unbox: "unsupported",
});

/**
 * (#3526 F1-S2) The exact, already-resolved BOOLEAN-boundary provider policy of
 * one preparation caller — a sibling of {@link NumberBoundaryPolicy}, not a
 * widening of it. The family is one-armed: the box arm resolves through the
 * host `env.__box_boolean` import, and there is no native boolean boxer to
 * select, so the union has no `"native"` member.
 */
export interface BooleanBoundaryPolicy {
  /** `host` selects `env.__box_boolean`. There is no native box arm. */
  readonly box: "host" | "unsupported";
}

/** Adapters that expose no boolean boundary resolve the box arm to this. */
export const BOOLEAN_BOUNDARY_POLICY_DISABLED: BooleanBoundaryPolicy = Object.freeze({
  box: "unsupported",
});

/**
 * (#3526 F1-S4) The exact, already-resolved policy for the externref UNDEFINED
 * PROBE — a sibling of {@link NumberBoundaryPolicy}, never a widening of it.
 *
 * The seam's truth table is its own: the probe is answered by a real Wasm
 * function on every host-free lane (`ensureObjectRuntime` registers it, and
 * `undefined` there is the #2106 non-null singleton, so the predicate is
 * load-bearing rather than an alias for `ref.is_null`), and by the
 * `env.__extern_is_undefined` import otherwise. That is the exact truth table
 * the deleted `externIsUndefinedIsNative` resolver predicate carried:
 * `ctx.standalone || ctx.wasi || ctx.nativeStrings`.
 */
export interface ExternIsUndefinedPolicy {
  /**
   * `host` selects the `env.__extern_is_undefined` import through the central
   * `extern.is_undefined` capability; `native` selects the host-free Wasm
   * function of the same name.
   */
  readonly probe: "host" | "native" | "unsupported";
}

/** Adapters on which the externref undefined probe cannot be answered. */
export const EXTERN_IS_UNDEFINED_POLICY_DISABLED: ExternIsUndefinedPolicy = Object.freeze({
  probe: "unsupported",
});

/**
 * (#3526 F1-S3) The exact, already-resolved policy for the GENERATOR return
 * seam's numeric boxing — a sibling of {@link NumberBoundaryPolicy}, never a
 * widening of it.
 *
 * The seam's truth table is deliberately WIDER than `numberBoundary`: this
 * boxing is performed natively on the GC native-strings lane, whereas
 * `numberBoundary.box` has no `"native"` member by design (F1-S1 excluded one
 * so that native `__box_number` presence could not widen the from-ast arm's
 * host-only policy). The two must therefore stay separate policies even though
 * both name the same physical symbol.
 */
export interface GeneratorNumberBoxPolicy {
  /**
   * `host` selects the `env.__box_number` union import through the central
   * `number.box` capability; `native` selects the union-native `__box_number`
   * runtime function.
   */
  readonly box: "host" | "native" | "unsupported";
}

/** Adapters on which a generator `return <number>` cannot be boxed at all. */
export const GENERATOR_NUMBER_BOX_POLICY_DISABLED: GeneratorNumberBoxPolicy = Object.freeze({
  box: "unsupported",
});

/**
 * (#3526 F2-S1) The exact, already-resolved policy for the STRING RELATIONAL
 * COMPARE seam — family 2's first policy, and a sibling of
 * {@link ExternIsUndefinedPolicy}, never a widening of it.
 *
 * The seam's truth table is `nativeStrings ? native : host`, which is the exact
 * decision the resolve-time provider table made by reading `ctx.nativeStrings`
 * directly. It differs from every family-1 table: `numberBoundary` calls the
 * native-strings lane unsupported, `booleanBoundary` has no native arm at all,
 * and `externIsUndefined` also goes native on standalone/WASI — which for this
 * seam are subsumed, because `standalone` and `wasi` both imply `nativeStrings`.
 */
export interface StringComparePolicy {
  /**
   * `host` selects the `env.string_compare` base import through the central
   * `string.compare` capability; `native` selects the `__str_compare` Wasm
   * helper `ensureNativeStringHelpers` registers.
   */
  readonly compare: "host" | "native" | "unsupported";
}

/** Adapters that expose no string relational compare resolve the arm to this. */
export const STRING_COMPARE_POLICY_DISABLED: StringComparePolicy = Object.freeze({
  compare: "unsupported",
});

/**
 * (#3526 F2-S3) The exact, already-resolved policy for the STRING EQUALITY
 * seam (`a === b` / `a !== b` on two strings) — family 2's second policy, and a
 * SIBLING of {@link StringComparePolicy}, never a widening of it.
 *
 * The truth table is the same one (`nativeStrings ? native : host`) because both
 * seams answer to the same lane flag, but the physical pair is different: this
 * arm's host provider is the `wasm:js-string.equals` BUILTIN import, not an
 * `env` one. That namespace only became expressible as a capability record in
 * F2-S2, which is why this seam could not move with the compare. Keeping the two
 * policies separate means either seam can later be re-pointed — to a self-hosted
 * helper, say — without dragging the other with it.
 */
export interface StringEqPolicy {
  /**
   * `host` selects the `wasm:js-string.equals` builtin import through the
   * central `string.eq` capability; `native` selects the `__str_equals` Wasm
   * helper `ensureNativeStringHelpers` registers.
   */
  readonly eq: "host" | "native" | "unsupported";
}

/** Adapters that expose no string equality seam resolve the arm to this. */
export const STRING_EQ_POLICY_DISABLED: StringEqPolicy = Object.freeze({
  eq: "unsupported",
});

export interface RuntimeManifestPolicy {
  readonly target: RuntimeTarget;
  readonly backend: RuntimeBackend;
  /**
   * Omission resolves to {@link NUMBER_BOUNDARY_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly numberBoundary?: NumberBoundaryPolicy;
  /**
   * Omission resolves to {@link BOOLEAN_BOUNDARY_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly booleanBoundary?: BooleanBoundaryPolicy;
  /**
   * Omission resolves to {@link EXTERN_IS_UNDEFINED_POLICY_DISABLED}; the
   * frozen manifest always publishes the explicit resolved value.
   */
  readonly externIsUndefined?: ExternIsUndefinedPolicy;
  /**
   * Omission resolves to {@link GENERATOR_NUMBER_BOX_POLICY_DISABLED}; the
   * frozen manifest always publishes the explicit resolved value.
   */
  readonly generatorNumberBox?: GeneratorNumberBoxPolicy;
  /**
   * Omission resolves to {@link STRING_COMPARE_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly stringCompare?: StringComparePolicy;
  /**
   * Omission resolves to {@link STRING_EQ_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly stringEq?: StringEqPolicy;
}

/** The frozen manifest's policy always carries an explicit resolved decision. */
export type FrozenRuntimeManifestPolicy = RuntimeManifestPolicy & {
  readonly numberBoundary: NumberBoundaryPolicy;
  readonly booleanBoundary: BooleanBoundaryPolicy;
  readonly externIsUndefined: ExternIsUndefinedPolicy;
  readonly generatorNumberBox: GeneratorNumberBoxPolicy;
  readonly stringCompare: StringComparePolicy;
  readonly stringEq: StringEqPolicy;
};

export const PURE_MATH_RUNTIME_PROVIDER_IDS = Object.freeze([
  "backend.f64.abs",
  "backend.f64.ceil",
  "backend.f64.floor",
  "backend.f64.fround",
  "backend.f64.sqrt",
  "backend.f64.trunc",
  "backend.math.clz32",
  "backend.math.imul",
  "backend.math.max",
  "backend.math.min",
  "selfhost.math.acos",
  "selfhost.math.acosh",
  "selfhost.math.asin",
  "selfhost.math.asinh",
  "selfhost.math.atan",
  "selfhost.math.atan2",
  "selfhost.math.atanh",
  "selfhost.math.cbrt",
  "selfhost.math.cos",
  "selfhost.math.cosh",
  "selfhost.math.exp",
  "selfhost.math.expm1",
  "selfhost.math.log",
  "selfhost.math.log10",
  "selfhost.math.log1p",
  "selfhost.math.log2",
  "selfhost.math.pow",
  "selfhost.math.reduce-trig",
  "selfhost.math.round",
  "selfhost.math.sign",
  "selfhost.math.sin",
  "selfhost.math.sinh",
  "selfhost.math.tan",
  "selfhost.math.tanh",
] as const);

export type MathRuntimeProviderId = (typeof PURE_MATH_RUNTIME_PROVIDER_IDS)[number];
export const NUMERIC_COERCION_RUNTIME_PROVIDER_IDS = Object.freeze(["backend.js.to_uint32"] as const);
export type NumericCoercionRuntimeProviderId = (typeof NUMERIC_COERCION_RUNTIME_PROVIDER_IDS)[number];

/** (#3526 F1-S1) One provider per admitted number-boundary policy arm. */
export const NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.number.box",
  "host.js.number.unbox",
  "native.js.number.unbox",
] as const);
export type NumberBoundaryRuntimeProviderId = (typeof NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS)[number];

/** (#3526 F1-S2) The one admitted boolean-boundary policy arm. */
export const BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS = Object.freeze(["host.js.boolean.box"] as const);
export type BooleanBoundaryRuntimeProviderId = (typeof BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS)[number];

/** (#3526 F1-S4) One provider per admitted externref undefined-probe arm. */
export const EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.extern.is_undefined",
  "native.js.extern.is_undefined",
] as const);
export type ExternBoundaryRuntimeProviderId = (typeof EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F1-S3) The generator return seam's boxing requirement.
 *
 * This family has NO intrinsic instruction: the demand is carried by a
 * `gen.setReturn` whose stashed value is numeric, and it is requested at
 * manifest freeze the way an async plan requests its runtime intents. The
 * feature exists so the frozen manifest — not a hardcoded runtime symbol at
 * the attachment site — is the authority for which boxer answers the seam.
 */
export const GENERATOR_NUMBER_BOX_RUNTIME_FEATURES = Object.freeze(["js.generator.number-box"] as const);
export type GeneratorNumberBoxRuntimeFeature = (typeof GENERATOR_NUMBER_BOX_RUNTIME_FEATURES)[number];

/** (#3526 F1-S3) One provider per admitted generator-number-box policy arm. */
export const GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.generator.number-box",
  "native.js.generator.number-box",
] as const);
export type GeneratorNumberBoxRuntimeProviderId = (typeof GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F2-S1) The string relational compare seam's requirement.
 *
 * Like the generator boxing feature this family has NO intrinsic instruction:
 * from-ast emits a plain `call` through the `__ir_str_compare` sentinel func-ref
 * (`IR_STRING_COMPARE_FN`), so the demand is requested at manifest freeze rather
 * than collected from an `intrinsic` use. The feature exists so the frozen
 * manifest — not a `ctx.nativeStrings` read inside the resolve-time provider
 * table — is the authority for which helper answers the seam.
 */
export const STRING_COMPARE_RUNTIME_FEATURES = Object.freeze(["js.string.compare"] as const);
export type StringCompareRuntimeFeature = (typeof STRING_COMPARE_RUNTIME_FEATURES)[number];

/** (#3526 F2-S1) One provider per admitted string-compare policy arm. */
export const STRING_COMPARE_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.string.compare",
  "native.js.string.compare",
] as const);
export type StringCompareRuntimeProviderId = (typeof STRING_COMPARE_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F2-S3) The string equality seam's requirement.
 *
 * `string.eq` IS an IR instruction, unlike the compare — but the CALLABLE it
 * resolves through is still a plain `call` on the `__ir_string_equals` sentinel
 * func-ref, and the `intrinsic` walk that collects uses sees no `intrinsic`
 * here. So the demand is requested at freeze from a `string.eq` instruction
 * scan, exactly as the compare's is from a `call` scan.
 */
export const STRING_EQ_RUNTIME_FEATURES = Object.freeze(["js.string.eq"] as const);
export type StringEqRuntimeFeature = (typeof STRING_EQ_RUNTIME_FEATURES)[number];

/** (#3526 F2-S3) One provider per admitted string-equality policy arm. */
export const STRING_EQ_RUNTIME_PROVIDER_IDS = Object.freeze(["host.js.string.eq", "native.js.string.eq"] as const);
export type StringEqRuntimeProviderId = (typeof STRING_EQ_RUNTIME_PROVIDER_IDS)[number];

export type RuntimeProviderId =
  | MathRuntimeProviderId
  | NumericCoercionRuntimeProviderId
  | NumberBoundaryRuntimeProviderId
  | BooleanBoundaryRuntimeProviderId
  | ExternBoundaryRuntimeProviderId
  | GeneratorNumberBoxRuntimeProviderId
  | StringCompareRuntimeProviderId
  | StringEqRuntimeProviderId
  | AsyncRuntimeProviderId;

export type RuntimeProviderImplementation =
  | {
      readonly kind: "backend-op";
      readonly opcode: IrIntrinsicBackendOp;
    }
  | {
      readonly kind: "backend-sequence";
      readonly sequence: IrIntrinsicBackendSequence;
    }
  | {
      readonly kind: "backend-composite";
      readonly operation: IrIntrinsicBackendComposite;
    }
  | {
      readonly kind: "self-hosted";
      /** Concrete ABI spelling, deliberately below the semantic feature. */
      readonly symbol: string;
    }
  | {
      /** The provider closes over one or more declared host capabilities. */
      readonly kind: "host-capability";
    }
  | {
      /**
       * (#3526 F1-S1) A synchronous callable answered by one exact central
       * host capability. Lowering derives the canonical physical
       * `irImportFuncRef` from that record — the semantic identity stays the
       * versioned `IntrinsicId`, the physical target stays the existing import
       * so legacy consumers and import order do not drift.
       *
       * (#3526 F2-S2) Typed on the FUNC half of the capability id union: a
       * global capability (`string.const`) has no callable spelling, so
       * naming one here is a compile error, not a lowering-time surprise.
       * `#indexProviders` carries the runtime twin of this narrowing.
       */
      readonly kind: "host-callable";
      readonly capability: RuntimeHostCapabilityFuncId;
    }
  | {
      /**
       * (#3526 F1-S1) A synchronous callable answered by one exact runtime
       * symbol, lowered through the canonical `irRuntimeFuncRef`.
       */
      readonly kind: "runtime-callable";
      readonly symbol: string;
    }
  | {
      /** Scheduling is supplied by the host Promise job queue, with no import. */
      readonly kind: "host-managed";
      readonly service: "promise-job-queue";
    }
  | {
      /** Promise allocation, reactions, settlement, and queueing stay in WasmGC. */
      readonly kind: "native-managed";
      readonly service: "native-promise-runtime";
    };

export type MathRuntimeProviderImplementation = Extract<
  RuntimeProviderImplementation,
  { readonly kind: "backend-op" | "backend-sequence" | "backend-composite" | "self-hosted" }
>;

export type IntrinsicRuntimeProviderImplementation = Extract<
  RuntimeProviderImplementation,
  {
    readonly kind:
      | "backend-op"
      | "backend-sequence"
      | "backend-composite"
      | "self-hosted"
      | "host-callable"
      | "runtime-callable";
  }
>;

export interface RuntimeProviderDefinition {
  readonly id: RuntimeProviderId;
  readonly feature: RuntimeFeature;
  /** Present for source intrinsics; semantic runtime requirements need no call ABI. */
  readonly signature?: IntrinsicSignature;
  readonly dependencies: readonly RuntimeFeature[];
  readonly hostCapabilities: readonly HostCapabilityId[];
  readonly supportedTargets: readonly RuntimeTarget[];
  readonly supportedBackends: readonly RuntimeBackend[];
  readonly implementation: RuntimeProviderImplementation;
}

/**
 * Project concrete backend reservations from already selected providers.
 * This is the only semantic-to-backend requirement projection: consumers
 * receive the resulting closed vector and never rediscover it from features.
 */
export function projectRuntimeBackendRequirements(
  providers: readonly RuntimeProviderDefinition[],
): readonly RuntimeBackendRequirement[] {
  const requirements = new Set<RuntimeBackendRequirement>();
  let family: "host" | "native" | null = null;
  for (const provider of providers) {
    const kind = provider.implementation.kind;
    if (kind === "host-capability" || kind === "host-managed") {
      if (family === "native") {
        throw new RuntimeManifestInvariantError(
          "invalid-backend-requirement-projection",
          "runtime provider projection mixes host and native async providers",
        );
      }
      family = "host";
      continue;
    }
    if (kind !== "native-managed") continue;
    if (family === "host") {
      throw new RuntimeManifestInvariantError(
        "invalid-backend-requirement-projection",
        "runtime provider projection mixes host and native async providers",
      );
    }
    family = "native";
    requirements.add("async.native.drive");
    requirements.add("async.native.number-boundary");
    if (provider.feature === "value.undefined") requirements.add("async.native.undefined");
  }
  return Object.freeze(RUNTIME_BACKEND_REQUIREMENTS.filter((requirement) => requirements.has(requirement)));
}

/** Semantic-intrinsic lowering view; async providers are consumed by later adapters. */
export type RuntimeProviderPlan = RuntimeProviderDefinition & {
  readonly implementation: IntrinsicRuntimeProviderImplementation;
};

export interface RuntimeProviderComponent {
  readonly features: readonly RuntimeFeature[];
  readonly providers: readonly RuntimeProviderId[];
  readonly cyclic: boolean;
}

export interface FrozenRuntimeManifest {
  readonly policy: FrozenRuntimeManifestPolicy;
  readonly intrinsicUses: readonly IntrinsicUse[];
  readonly features: readonly RuntimeFeature[];
  readonly providers: readonly RuntimeProviderDefinition[];
  readonly providerComponents: readonly RuntimeProviderComponent[];
  readonly hostCapabilities: readonly HostCapabilityId[];
  /** Exact selected ABI records, in the same canonical capability-ID order. */
  readonly hostCapabilityRecords: readonly RuntimeHostCapabilityRecord[];
  /** Canonical union of concrete backend reservations selected before lowering. */
  readonly backendRequirements: readonly RuntimeBackendRequirement[];
}

export type RuntimeManifestInvariantCode =
  | IntrinsicVerificationCode
  | "manifest-frozen"
  | "manifest-build-failed"
  | "manifest-not-frozen"
  | "unknown-runtime-feature"
  | "unknown-runtime-provider"
  | "unknown-host-capability"
  | "invalid-host-capability-catalog"
  | "duplicate-runtime-provider"
  | "duplicate-cycle-declaration"
  | "invalid-cycle-declaration"
  | "missing-runtime-provider"
  | "ambiguous-runtime-provider"
  | "provider-target-unavailable"
  | "missing-backend-adapter"
  | "invalid-backend-requirement-projection"
  | "provider-signature-mismatch"
  | "undeclared-provider-cycle"
  | "declared-cycle-mismatch"
  | "late-unplanned-intrinsic"
  | "late-unplanned-feature"
  | "late-unplanned-provider"
  | "late-unplanned-host-capability";

export class RuntimeManifestInvariantError extends Error {
  readonly kind = "invariant" as const;
  readonly stage = "verify" as const;

  constructor(
    readonly code: RuntimeManifestInvariantCode,
    detail: string,
  ) {
    super(detail);
    this.name = "RuntimeManifestInvariantError";
  }
}

const ALL_TARGETS = Object.freeze<readonly RuntimeTarget[]>(["host", "standalone", "strict-no-host", "wasi"]);
const ALL_BACKENDS = Object.freeze<readonly RuntimeBackend[]>(["linear", "wasmgc"]);

export const RUNTIME_FEATURE_SIGNATURES: Readonly<Partial<Record<RuntimeFeature, IntrinsicSignature>>> = Object.freeze({
  "js.to_uint32": F64_TO_U32_INTRINSIC_SIGNATURE,
  "js.number.box": F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
  "js.number.unbox": EXTERNREF_TO_F64_INTRINSIC_SIGNATURE,
  "js.generator.number-box": F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
  "math.abs": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.acos": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.acosh": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.asin": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.asinh": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.atan": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.atan2": F64_BINARY_INTRINSIC_SIGNATURE,
  "math.atanh": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.cbrt": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.ceil": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.clz32": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.cos": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.cosh": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.exp": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.expm1": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.floor": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.fround": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.imul": F64_BINARY_INTRINSIC_SIGNATURE,
  "math.log": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.log10": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.log1p": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.log2": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.max": F64_BINARY_INTRINSIC_SIGNATURE,
  "math.min": F64_BINARY_INTRINSIC_SIGNATURE,
  "math.pow": F64_BINARY_INTRINSIC_SIGNATURE,
  "math.reduce-trig": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.round": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.sign": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.sin": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.sinh": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.sqrt": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.tan": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.tanh": F64_UNARY_INTRINSIC_SIGNATURE,
  "math.trunc": F64_UNARY_INTRINSIC_SIGNATURE,
});

function provider(
  id: RuntimeProviderId,
  feature: RuntimeFeature,
  signature: IntrinsicSignature,
  implementation: RuntimeProviderImplementation,
  dependencies: readonly RuntimeFeature[] = [],
): RuntimeProviderDefinition {
  return Object.freeze({
    id,
    feature,
    signature,
    dependencies: Object.freeze([...dependencies].sort()),
    hostCapabilities: PURE_MATH_HOST_CAPABILITIES,
    supportedTargets: ALL_TARGETS,
    supportedBackends: ALL_BACKENDS,
    implementation: Object.freeze({ ...implementation }),
  });
}

export const NUMERIC_COERCION_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  provider("backend.js.to_uint32", "js.to_uint32", F64_TO_U32_INTRINSIC_SIGNATURE, {
    kind: "backend-composite",
    operation: "to-uint32",
  }),
]);

function numberBoundaryProvider(
  id:
    | NumberBoundaryRuntimeProviderId
    | BooleanBoundaryRuntimeProviderId
    | ExternBoundaryRuntimeProviderId
    | GeneratorNumberBoxRuntimeProviderId
    | StringCompareRuntimeProviderId
    | StringEqRuntimeProviderId,
  feature:
    | NumberBoundaryRuntimeFeature
    | BooleanBoundaryRuntimeFeature
    | ExternBoundaryRuntimeFeature
    | GeneratorNumberBoxRuntimeFeature
    | StringCompareRuntimeFeature
    | StringEqRuntimeFeature,
  signature: IntrinsicSignature,
  implementation: RuntimeProviderImplementation,
  hostCapabilities: readonly HostCapabilityId[],
): RuntimeProviderDefinition {
  return Object.freeze({
    id,
    feature,
    signature,
    dependencies: Object.freeze([] as readonly RuntimeFeature[]),
    hostCapabilities: Object.freeze([...hostCapabilities]),
    // Target/backend admission stays wide; the exact arm is chosen by the
    // caller-resolved `numberBoundary` policy, which is the only fact that can
    // separate the three GC combinations that share `target: "host"`.
    supportedTargets: ALL_TARGETS,
    supportedBackends: ALL_BACKENDS,
    implementation: Object.freeze({ ...implementation }),
  });
}

/**
 * (#3526 F1-S1) The synchronous number boundary. `js.number.box` is HOST-ONLY
 * by policy in this slice: standalone does define a native `__box_number`
 * through the union-native family, but the current front-end arm is gated on
 * `!nativeStrings`, and support may not be inferred from helper presence. The
 * `$AnyValue` standalone boxing family is explicitly not this intrinsic.
 */
export const NUMBER_BOUNDARY_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.number.box",
    "js.number.box",
    F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "number.box" },
    ["number.box"],
  ),
  numberBoundaryProvider(
    "host.js.number.unbox",
    "js.number.unbox",
    EXTERNREF_TO_F64_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "number.unbox" },
    ["number.unbox"],
  ),
  numberBoundaryProvider(
    "native.js.number.unbox",
    "js.number.unbox",
    EXTERNREF_TO_F64_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__unbox_number" },
    [],
  ),
]);

/**
 * (#3526 F1-S2) The synchronous boolean boundary. Host-only by policy: no
 * native boolean boxer exists, so there is no `runtime-callable` sibling to
 * select. The physical target stays the exact `env.__box_boolean` union import
 * the direct call used, so raw consumers and import order are untouched.
 */
export const BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.boolean.box",
    "js.boolean.box",
    I32_TO_EXTERNREF_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "boolean.box" },
    ["boolean.box"],
  ),
]);

/**
 * (#3526 F1-S4) The externref undefined probe's two arms. Both name the SAME
 * physical spelling `__extern_is_undefined` — on the host lane through the
 * central `extern.is_undefined` capability record (`env.__extern_is_undefined`,
 * registered by `ensureLateImport`), on the host-free lanes through the real
 * Wasm function `ensureObjectRuntime` registers. As with the number boundary,
 * the manifest decides WHICH authority answers; it introduces no new spelling
 * and no second registration path.
 */
export const EXTERN_BOUNDARY_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.extern.is_undefined",
    "js.extern.is_undefined",
    EXTERNREF_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "extern.is_undefined" },
    ["extern.is_undefined"],
  ),
  numberBoundaryProvider(
    "native.js.extern.is_undefined",
    "js.extern.is_undefined",
    EXTERNREF_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__extern_is_undefined" },
    [],
  ),
]);

/**
 * (#3526 F1-S3) The generator return seam's two boxing arms. Both name the
 * SAME physical symbol `__box_number` — on the host lane through the central
 * `number.box` capability record (`env.__box_number`), on the native-strings
 * lane through the union-native runtime function. The manifest's job here is
 * to decide WHICH authority answers and whether the seam is permitted at all,
 * not to introduce a second spelling.
 */
export const GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.generator.number-box",
    "js.generator.number-box",
    F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "number.box" },
    ["number.box"],
  ),
  numberBoundaryProvider(
    "native.js.generator.number-box",
    "js.generator.number-box",
    F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__box_number" },
    [],
  ),
]);

/**
 * (#3526 F2-S1) The string relational compare seam's two arms. Both answer the
 * same -1/0/1 lexicographic sign: on the host lane through the central
 * `string.compare` capability record (`env.string_compare`, a BASE import the
 * legacy import collector mints before any IR preparation runs), on the
 * native-strings lanes through the `__str_compare` Wasm helper. The manifest
 * decides WHICH authority answers; it introduces no new spelling and no second
 * registration path, which is why the migration is byte-neutral.
 */
export const STRING_COMPARE_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.string.compare",
    "js.string.compare",
    EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "string.compare" },
    ["string.compare"],
  ),
  numberBoundaryProvider(
    "native.js.string.compare",
    "js.string.compare",
    EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__str_compare" },
    [],
  ),
]);

/** The exact provider the admitted string-compare arm selects, or `null` when
 * the caller resolved it to unsupported. */
function stringCompareProviderId(policy: StringComparePolicy): StringCompareRuntimeProviderId | null {
  if (policy.compare === "host") return "host.js.string.compare";
  return policy.compare === "native" ? "native.js.string.compare" : null;
}

const STRING_COMPARE_FEATURE_SET: ReadonlySet<string> = new Set(STRING_COMPARE_RUNTIME_FEATURES);

function isStringCompareFeature(feature: RuntimeFeature): feature is StringCompareRuntimeFeature {
  return STRING_COMPARE_FEATURE_SET.has(feature);
}

/**
 * (#3526 F2-S3) The string equality seam's two arms. Both answer the same
 * 0/1 code-unit equality: on the host lane through the central `string.eq`
 * capability record (`wasm:js-string.equals`, one of the five builtins
 * `addStringImports` registers as a block before Phase 3), on the native-strings
 * lanes through the `__str_equals` Wasm helper. As with the compare, the
 * manifest decides WHICH authority answers; it introduces no new spelling and no
 * second registration path, which is why the migration is byte-neutral.
 */
export const STRING_EQ_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.string.eq",
    "js.string.eq",
    EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "string.eq" },
    ["string.eq"],
  ),
  numberBoundaryProvider(
    "native.js.string.eq",
    "js.string.eq",
    EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__str_equals" },
    [],
  ),
]);

/** The exact provider the admitted string-equality arm selects, or `null` when
 * the caller resolved it to unsupported. */
function stringEqProviderId(policy: StringEqPolicy): StringEqRuntimeProviderId | null {
  if (policy.eq === "host") return "host.js.string.eq";
  return policy.eq === "native" ? "native.js.string.eq" : null;
}

const STRING_EQ_FEATURE_SET: ReadonlySet<string> = new Set(STRING_EQ_RUNTIME_FEATURES);

function isStringEqFeature(feature: RuntimeFeature): feature is StringEqRuntimeFeature {
  return STRING_EQ_FEATURE_SET.has(feature);
}

/** The exact provider the admitted generator-box arm selects, or `null` when
 * the caller resolved it to unsupported. */
function generatorNumberBoxProviderId(policy: GeneratorNumberBoxPolicy): GeneratorNumberBoxRuntimeProviderId | null {
  if (policy.box === "host") return "host.js.generator.number-box";
  return policy.box === "native" ? "native.js.generator.number-box" : null;
}

const GENERATOR_NUMBER_BOX_FEATURE_SET: ReadonlySet<string> = new Set(GENERATOR_NUMBER_BOX_RUNTIME_FEATURES);

function isGeneratorNumberBoxFeature(feature: RuntimeFeature): feature is GeneratorNumberBoxRuntimeFeature {
  return GENERATOR_NUMBER_BOX_FEATURE_SET.has(feature);
}

/** The exact provider the admitted boolean arm selects, or `null` when the
 * caller resolved it to unsupported. */
function booleanBoundaryProviderId(policy: BooleanBoundaryPolicy): BooleanBoundaryRuntimeProviderId | null {
  return policy.box === "host" ? "host.js.boolean.box" : null;
}

const BOOLEAN_BOUNDARY_FEATURE_SET: ReadonlySet<string> = new Set(BOOLEAN_BOUNDARY_RUNTIME_FEATURES);

function isBooleanBoundaryFeature(feature: RuntimeFeature): feature is BooleanBoundaryRuntimeFeature {
  return BOOLEAN_BOUNDARY_FEATURE_SET.has(feature);
}

/** The exact provider the admitted probe arm selects, or `null` when the
 * caller resolved it to unsupported. */
function externIsUndefinedProviderId(policy: ExternIsUndefinedPolicy): ExternBoundaryRuntimeProviderId | null {
  if (policy.probe === "host") return "host.js.extern.is_undefined";
  return policy.probe === "native" ? "native.js.extern.is_undefined" : null;
}

const EXTERN_BOUNDARY_FEATURE_SET: ReadonlySet<string> = new Set(EXTERN_BOUNDARY_RUNTIME_FEATURES);

function isExternBoundaryFeature(feature: RuntimeFeature): feature is ExternBoundaryRuntimeFeature {
  return EXTERN_BOUNDARY_FEATURE_SET.has(feature);
}

/** The exact provider each admitted policy arm selects, or `null` when the
 * caller resolved the arm to unsupported. */
function numberBoundaryProviderId(
  feature: NumberBoundaryRuntimeFeature,
  policy: NumberBoundaryPolicy,
): NumberBoundaryRuntimeProviderId | null {
  if (feature === "js.number.box") return policy.box === "host" ? "host.js.number.box" : null;
  if (policy.unbox === "host") return "host.js.number.unbox";
  return policy.unbox === "native" ? "native.js.number.unbox" : null;
}

const NUMBER_BOUNDARY_FEATURE_SET: ReadonlySet<string> = new Set(NUMBER_BOUNDARY_RUNTIME_FEATURES);

function isNumberBoundaryFeature(feature: RuntimeFeature): feature is NumberBoundaryRuntimeFeature {
  return NUMBER_BOUNDARY_FEATURE_SET.has(feature);
}

const PROVIDERS_BY_FEATURE: Readonly<Record<PureMathRuntimeFeature, RuntimeProviderDefinition>> = Object.freeze({
  "math.abs": provider("backend.f64.abs", "math.abs", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.abs",
  }),
  "math.acos": provider(
    "selfhost.math.acos",
    "math.acos",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_acos" },
    ["math.atan"],
  ),
  "math.acosh": provider(
    "selfhost.math.acosh",
    "math.acosh",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_acosh" },
    ["math.log"],
  ),
  "math.asin": provider(
    "selfhost.math.asin",
    "math.asin",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_asin" },
    ["math.atan"],
  ),
  "math.asinh": provider(
    "selfhost.math.asinh",
    "math.asinh",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_asinh" },
    ["math.log"],
  ),
  "math.atan": provider("selfhost.math.atan", "math.atan", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_atan",
  }),
  "math.atan2": provider(
    "selfhost.math.atan2",
    "math.atan2",
    F64_BINARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_atan2" },
    ["math.atan"],
  ),
  "math.atanh": provider(
    "selfhost.math.atanh",
    "math.atanh",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_atanh" },
    ["math.log"],
  ),
  "math.cbrt": provider("selfhost.math.cbrt", "math.cbrt", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_cbrt",
  }),
  "math.ceil": provider("backend.f64.ceil", "math.ceil", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.ceil",
  }),
  "math.clz32": provider("backend.math.clz32", "math.clz32", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-composite",
    operation: "math.clz32",
  }),
  "math.cos": provider(
    "selfhost.math.cos",
    "math.cos",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_cos" },
    ["math.reduce-trig"],
  ),
  "math.cosh": provider(
    "selfhost.math.cosh",
    "math.cosh",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_cosh" },
    ["math.exp"],
  ),
  "math.exp": provider("selfhost.math.exp", "math.exp", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_exp",
  }),
  "math.expm1": provider(
    "selfhost.math.expm1",
    "math.expm1",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_expm1" },
    ["math.exp"],
  ),
  "math.floor": provider("backend.f64.floor", "math.floor", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.floor",
  }),
  "math.fround": provider("backend.f64.fround", "math.fround", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-sequence",
    sequence: "f64.fround",
  }),
  "math.imul": provider("backend.math.imul", "math.imul", F64_BINARY_INTRINSIC_SIGNATURE, {
    kind: "backend-composite",
    operation: "math.imul",
  }),
  "math.log": provider("selfhost.math.log", "math.log", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_log",
  }),
  "math.log10": provider(
    "selfhost.math.log10",
    "math.log10",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_log10" },
    ["math.log"],
  ),
  "math.log1p": provider(
    "selfhost.math.log1p",
    "math.log1p",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_log1p" },
    ["math.log"],
  ),
  "math.log2": provider("selfhost.math.log2", "math.log2", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_log2",
  }),
  "math.max": provider("backend.math.max", "math.max", F64_BINARY_INTRINSIC_SIGNATURE, {
    kind: "backend-composite",
    operation: "math.max",
  }),
  "math.min": provider("backend.math.min", "math.min", F64_BINARY_INTRINSIC_SIGNATURE, {
    kind: "backend-composite",
    operation: "math.min",
  }),
  "math.pow": provider(
    "selfhost.math.pow",
    "math.pow",
    F64_BINARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_pow" },
    ["math.exp", "math.log"],
  ),
  "math.reduce-trig": provider("selfhost.math.reduce-trig", "math.reduce-trig", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "__math_reduce_trig",
  }),
  "math.round": provider("selfhost.math.round", "math.round", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_round",
  }),
  "math.sign": provider("selfhost.math.sign", "math.sign", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "self-hosted",
    symbol: "Math_sign",
  }),
  "math.sin": provider(
    "selfhost.math.sin",
    "math.sin",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_sin" },
    ["math.reduce-trig"],
  ),
  "math.sinh": provider(
    "selfhost.math.sinh",
    "math.sinh",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_sinh" },
    ["math.exp"],
  ),
  "math.sqrt": provider("backend.f64.sqrt", "math.sqrt", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.sqrt",
  }),
  "math.tan": provider(
    "selfhost.math.tan",
    "math.tan",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_tan" },
    ["math.cos", "math.sin"],
  ),
  "math.tanh": provider(
    "selfhost.math.tanh",
    "math.tanh",
    F64_UNARY_INTRINSIC_SIGNATURE,
    { kind: "self-hosted", symbol: "Math_tanh" },
    ["math.exp"],
  ),
  "math.trunc": provider("backend.f64.trunc", "math.trunc", F64_UNARY_INTRINSIC_SIGNATURE, {
    kind: "backend-op",
    opcode: "f64.trunc",
  }),
});

/** Canonically ordered default provider catalogue for the 33-method slice. */
export const PURE_MATH_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  PURE_MATH_RUNTIME_FEATURES.map((feature) => PROVIDERS_BY_FEATURE[feature]).sort((left, right) =>
    left.id.localeCompare(right.id),
  ),
);

/** Closed, canonically ordered catalogue used by production manifest builders. */
export const RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze(
  [
    ...PURE_MATH_RUNTIME_PROVIDERS,
    ...NUMERIC_COERCION_RUNTIME_PROVIDERS,
    ...NUMBER_BOUNDARY_RUNTIME_PROVIDERS,
    ...BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS,
    ...EXTERN_BOUNDARY_RUNTIME_PROVIDERS,
    ...GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS,
    ...STRING_COMPARE_RUNTIME_PROVIDERS,
    ...STRING_EQ_RUNTIME_PROVIDERS,
    ...ASYNC_RUNTIME_PROVIDERS,
  ].sort((left, right) => left.id.localeCompare(right.id)),
);

const FEATURE_SET: ReadonlySet<string> = new Set([
  ...NUMERIC_COERCION_RUNTIME_FEATURES,
  ...NUMBER_BOUNDARY_RUNTIME_FEATURES,
  ...BOOLEAN_BOUNDARY_RUNTIME_FEATURES,
  ...EXTERN_BOUNDARY_RUNTIME_FEATURES,
  ...GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,
  ...STRING_COMPARE_RUNTIME_FEATURES,
  ...STRING_EQ_RUNTIME_FEATURES,
  ...PURE_MATH_RUNTIME_FEATURES,
  ...ASYNC_RUNTIME_FEATURES,
  ...ASYNC_OPTIONAL_RUNTIME_FEATURES,
]);
const PROVIDER_ID_SET: ReadonlySet<string> = new Set([
  ...NUMERIC_COERCION_RUNTIME_PROVIDER_IDS,
  ...NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS,
  ...BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS,
  ...EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS,
  ...GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS,
  ...STRING_COMPARE_RUNTIME_PROVIDER_IDS,
  ...STRING_EQ_RUNTIME_PROVIDER_IDS,
  ...PURE_MATH_RUNTIME_PROVIDER_IDS,
  ...ASYNC_RUNTIME_PROVIDER_IDS,
]);
const HOST_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_IDS);
const TARGET_SET: ReadonlySet<string> = new Set(ALL_TARGETS);
const BACKEND_SET: ReadonlySet<string> = new Set(ALL_BACKENDS);

function isRuntimeFeature(value: string): value is RuntimeFeature {
  return FEATURE_SET.has(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function signatureEquals(left: IntrinsicSignature, right: IntrinsicSignature): boolean {
  if (left.version !== right.version || left.params.length !== right.params.length) return false;
  for (let index = 0; index < left.params.length; index++) {
    if (!irTypeEquals(left.params[index]!, right.params[index]!)) return false;
  }
  return irTypeEquals(left.result, right.result);
}

function cloneProvider(value: RuntimeProviderDefinition): RuntimeProviderDefinition {
  const signature =
    value.signature === undefined
      ? undefined
      : signatureEquals(value.signature, F64_UNARY_INTRINSIC_SIGNATURE)
        ? F64_UNARY_INTRINSIC_SIGNATURE
        : signatureEquals(value.signature, F64_BINARY_INTRINSIC_SIGNATURE)
          ? F64_BINARY_INTRINSIC_SIGNATURE
          : value.signature;
  return Object.freeze({
    ...value,
    ...(signature === undefined ? {} : { signature }),
    dependencies: Object.freeze([...new Set(value.dependencies)].sort(compareStrings)),
    hostCapabilities: Object.freeze([...new Set(value.hostCapabilities)].sort(compareStrings)),
    supportedTargets: Object.freeze([...new Set(value.supportedTargets)].sort(compareStrings)),
    supportedBackends: Object.freeze([...new Set(value.supportedBackends)].sort(compareStrings)),
    implementation: Object.freeze({ ...value.implementation }),
  });
}

function cycleKey(features: readonly RuntimeFeature[]): string {
  return [...features].sort(compareStrings).join("\u0000");
}

function useOrder(left: IntrinsicUse, right: IntrinsicUse): number {
  return (
    compareStrings(left.id, right.id) ||
    compareStrings(left.location.file, right.location.file) ||
    left.location.line - right.location.line ||
    left.location.column - right.location.column
  );
}

function stronglyConnectedComponents(
  features: readonly RuntimeFeature[],
  dependencies: ReadonlyMap<RuntimeFeature, readonly RuntimeFeature[]>,
): RuntimeFeature[][] {
  let nextIndex = 0;
  const indices = new Map<RuntimeFeature, number>();
  const lowLinks = new Map<RuntimeFeature, number>();
  const stack: RuntimeFeature[] = [];
  const onStack = new Set<RuntimeFeature>();
  const components: RuntimeFeature[][] = [];

  const visit = (feature: RuntimeFeature): void => {
    const index = nextIndex++;
    indices.set(feature, index);
    lowLinks.set(feature, index);
    stack.push(feature);
    onStack.add(feature);

    for (const dependency of dependencies.get(feature) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(feature, Math.min(lowLinks.get(feature)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(feature, Math.min(lowLinks.get(feature)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(feature) !== indices.get(feature)) return;
    const component: RuntimeFeature[] = [];
    let member: RuntimeFeature;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== feature);
    components.push(component.sort(compareStrings));
  };

  for (const feature of features) if (!indices.has(feature)) visit(feature);
  return components.sort((left, right) => compareStrings(cycleKey(left), cycleKey(right)));
}

function buildProviderComponents(
  features: readonly RuntimeFeature[],
  providers: ReadonlyMap<RuntimeFeature, RuntimeProviderDefinition>,
  declaredCycles: ReadonlyMap<string, readonly RuntimeFeature[]>,
): readonly RuntimeProviderComponent[] {
  const dependencies = new Map<RuntimeFeature, readonly RuntimeFeature[]>();
  for (const feature of features) dependencies.set(feature, providers.get(feature)!.dependencies);
  const components = stronglyConnectedComponents(features, dependencies);
  const actualCycleKeys = new Set<string>();

  for (const component of components) {
    const selfCycle = component.length === 1 && dependencies.get(component[0]!)!.includes(component[0]!);
    if (component.length === 1 && !selfCycle) continue;
    const key = cycleKey(component);
    actualCycleKeys.add(key);
    if (!declaredCycles.has(key)) {
      throw new RuntimeManifestInvariantError(
        "undeclared-provider-cycle",
        `runtime provider cycle ${component.join(" -> ")} was not declared`,
      );
    }
  }

  const selected = new Set(features);
  for (const [key, declaration] of declaredCycles) {
    if (declaration.every((feature) => selected.has(feature)) && !actualCycleKeys.has(key)) {
      throw new RuntimeManifestInvariantError(
        "declared-cycle-mismatch",
        `declared runtime provider cycle ${declaration.join(", ")} is not one canonical component`,
      );
    }
  }

  const componentOf = new Map<RuntimeFeature, number>();
  components.forEach((component, index) => component.forEach((feature) => componentOf.set(feature, index)));
  const orderedIndices: number[] = [];
  const visited = new Set<number>();
  const order = [...components.keys()].sort((left, right) =>
    compareStrings(cycleKey(components[left]!), cycleKey(components[right]!)),
  );
  const visitComponent = (index: number): void => {
    if (visited.has(index)) return;
    visited.add(index);
    const dependenciesOfComponent = new Set<number>();
    for (const feature of components[index]!) {
      for (const dependency of dependencies.get(feature) ?? []) {
        const dependencyIndex = componentOf.get(dependency)!;
        if (dependencyIndex !== index) dependenciesOfComponent.add(dependencyIndex);
      }
    }
    for (const dependencyIndex of [...dependenciesOfComponent].sort((left, right) =>
      compareStrings(cycleKey(components[left]!), cycleKey(components[right]!)),
    )) {
      visitComponent(dependencyIndex);
    }
    orderedIndices.push(index);
  };
  for (const index of order) visitComponent(index);

  return Object.freeze(
    orderedIndices.map((index) => {
      const componentFeatures = Object.freeze([...components[index]!]);
      return Object.freeze({
        features: componentFeatures,
        providers: Object.freeze(componentFeatures.map((feature) => providers.get(feature)!.id).sort(compareStrings)),
        cyclic:
          componentFeatures.length > 1 || dependencies.get(componentFeatures[0]!)!.includes(componentFeatures[0]!),
      });
    }),
  );
}

export interface RuntimeManifestBuilderOptions {
  /** Test/integration seam; omission uses the exhaustive production catalogue. */
  readonly providers?: readonly RuntimeProviderDefinition[];
  /** Test-only traversal/mutation seam; production uses the one central catalog. */
  readonly hostCapabilityRecords?: readonly RuntimeHostCapabilityRecord[];
}

type BuilderState = "open" | "building" | "frozen" | "failed";

export class RuntimeManifestBuilder {
  readonly #policy: FrozenRuntimeManifestPolicy;
  readonly #uses: IntrinsicUse[] = [];
  readonly #requestedFeatures = new Set<RuntimeFeature>();
  readonly #providers: RuntimeProviderDefinition[];
  readonly #hostCapabilityRecords: readonly RuntimeHostCapabilityRecord[];
  readonly #addedDependencies = new Map<RuntimeFeature, Set<RuntimeFeature>>();
  readonly #declaredCycles = new Map<string, readonly RuntimeFeature[]>();
  readonly #plannedIntrinsicIds = new Set<IntrinsicId>();
  readonly #plannedProviderIds = new Set<RuntimeProviderId>();
  readonly #plannedHostCapabilityIds = new Set<HostCapabilityId>();
  readonly #providerPlans = new Map<RuntimeFeature, RuntimeProviderDefinition>();
  #state: BuilderState = "open";
  #manifest?: FrozenRuntimeManifest;

  constructor(policy: RuntimeManifestPolicy, options: RuntimeManifestBuilderOptions = {}) {
    if (!TARGET_SET.has(policy.target) || !BACKEND_SET.has(policy.backend)) {
      throw new RuntimeManifestInvariantError(
        "provider-target-unavailable",
        `invalid runtime manifest policy ${String(policy.target)}/${String(policy.backend)}`,
      );
    }
    const numberBoundary = policy.numberBoundary ?? NUMBER_BOUNDARY_POLICY_DISABLED;
    const booleanBoundary = policy.booleanBoundary ?? BOOLEAN_BOUNDARY_POLICY_DISABLED;
    const externIsUndefined = policy.externIsUndefined ?? EXTERN_IS_UNDEFINED_POLICY_DISABLED;
    const generatorNumberBox = policy.generatorNumberBox ?? GENERATOR_NUMBER_BOX_POLICY_DISABLED;
    const stringCompare = policy.stringCompare ?? STRING_COMPARE_POLICY_DISABLED;
    const stringEq = policy.stringEq ?? STRING_EQ_POLICY_DISABLED;
    this.#policy = Object.freeze({
      ...policy,
      numberBoundary: Object.freeze({ box: numberBoundary.box, unbox: numberBoundary.unbox }),
      booleanBoundary: Object.freeze({ box: booleanBoundary.box }),
      externIsUndefined: Object.freeze({ probe: externIsUndefined.probe }),
      generatorNumberBox: Object.freeze({ box: generatorNumberBox.box }),
      stringCompare: Object.freeze({ compare: stringCompare.compare }),
      stringEq: Object.freeze({ eq: stringEq.eq }),
    });
    this.#providers = (options.providers ?? RUNTIME_PROVIDERS).map(cloneProvider);
    this.#hostCapabilityRecords = options.hostCapabilityRecords ?? RUNTIME_HOST_CAPABILITY_RECORDS;
  }

  addIntrinsicUse(use: IntrinsicUse, effects: IntrinsicEffectEvidence): void {
    this.#assertMutable();
    const failure = verifyIntrinsicUse(use, effects);
    if (failure) throw new RuntimeManifestInvariantError(failure.code, failure.detail);
    const canonical = INTRINSIC_DEFINITIONS[use.id];
    this.#uses.push(
      Object.freeze({
        id: use.id,
        version: canonical.signature.version,
        argumentTypes: canonical.signature.params,
        resultType: canonical.signature.result,
        location: Object.freeze({ ...use.location }),
      }),
    );
  }

  /** Register a semantic runtime requirement discovered during preparation. */
  requestFeature(feature: RuntimeFeature): void {
    this.#assertMutable();
    this.#assertKnownFeature(feature);
    this.#requestedFeatures.add(feature);
  }

  registerProvider(value: RuntimeProviderDefinition): void {
    this.#assertMutable();
    if (this.#providers.some((candidate) => candidate.id === value.id)) {
      throw new RuntimeManifestInvariantError(
        "duplicate-runtime-provider",
        `provider ${value.id} is already registered`,
      );
    }
    this.#providers.push(cloneProvider(value));
  }

  addProviderDependency(feature: RuntimeFeature, dependency: RuntimeFeature): void {
    this.#assertMutable();
    this.#assertKnownFeature(feature);
    this.#assertKnownFeature(dependency);
    let additions = this.#addedDependencies.get(feature);
    if (!additions) {
      additions = new Set();
      this.#addedDependencies.set(feature, additions);
    }
    additions.add(dependency);
  }

  declareProviderCycle(features: readonly RuntimeFeature[]): void {
    this.#assertMutable();
    const canonical = [...new Set(features)].sort(compareStrings);
    if (canonical.length === 0 || canonical.length !== features.length) {
      throw new RuntimeManifestInvariantError(
        "invalid-cycle-declaration",
        "provider cycle declarations must contain one or more unique features",
      );
    }
    canonical.forEach((feature) => this.#assertKnownFeature(feature));
    const key = cycleKey(canonical);
    if (this.#declaredCycles.has(key)) {
      throw new RuntimeManifestInvariantError(
        "duplicate-cycle-declaration",
        `provider cycle ${canonical.join(", ")} was declared more than once`,
      );
    }
    this.#declaredCycles.set(key, Object.freeze(canonical));
  }

  freeze(): FrozenRuntimeManifest {
    this.#assertMutable();
    this.#state = "building";
    try {
      this.#manifest = this.#buildManifest();
      this.#state = "frozen";
      return this.#manifest;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  get manifest(): FrozenRuntimeManifest {
    if (this.#state !== "frozen" || !this.#manifest) {
      throw new RuntimeManifestInvariantError("manifest-not-frozen", "runtime manifest is not frozen");
    }
    return this.#manifest;
  }

  resolveProvider(feature: IntrinsicRuntimeFeature): RuntimeProviderPlan;
  resolveProvider(feature: AsyncRuntimeFeature): RuntimeProviderDefinition;
  resolveProvider(feature: GeneratorNumberBoxRuntimeFeature): RuntimeProviderDefinition;
  resolveProvider(feature: RuntimeFeature): RuntimeProviderDefinition {
    this.#assertFrozen();
    const provider = this.#providerPlans.get(feature);
    if (!provider) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-feature",
        `runtime feature ${String(feature)} was not present at manifest freeze`,
      );
    }
    return provider;
  }

  assertIntrinsicPlanned(id: IntrinsicId): void {
    this.#assertFrozen();
    if (!this.#plannedIntrinsicIds.has(id)) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-intrinsic",
        `intrinsic ${String(id)} was not present at manifest freeze`,
      );
    }
  }

  assertProviderPlanned(id: RuntimeProviderId): void {
    this.#assertFrozen();
    if (!this.#plannedProviderIds.has(id)) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-provider",
        `runtime provider ${String(id)} was not present at manifest freeze`,
      );
    }
  }

  assertHostCapabilityPlanned(capability: string): void {
    this.#assertFrozen();
    if (!this.#plannedHostCapabilityIds.has(capability as HostCapabilityId)) {
      throw new RuntimeManifestInvariantError(
        "late-unplanned-host-capability",
        `host capability ${capability} was not present at manifest freeze`,
      );
    }
  }

  #buildManifest(): FrozenRuntimeManifest {
    const providersByFeature = this.#indexProviders();
    const pending = new Set<RuntimeFeature>(this.#requestedFeatures);
    for (const use of this.#uses) pending.add(INTRINSIC_DEFINITIONS[use.id].feature);

    while (pending.size > 0) {
      const feature = [...pending].sort(compareStrings)[0]!;
      pending.delete(feature);
      if (this.#providerPlans.has(feature)) continue;
      const selected = this.#selectProvider(feature, providersByFeature);
      const expectedSignature = RUNTIME_FEATURE_SIGNATURES[feature];
      if (
        expectedSignature !== undefined &&
        (selected.signature === undefined || !signatureEquals(selected.signature, expectedSignature))
      ) {
        throw new RuntimeManifestInvariantError(
          "provider-signature-mismatch",
          `provider ${selected.id} does not implement the ${feature} signature`,
        );
      }
      const dependencies = new Set(selected.dependencies);
      for (const dependency of this.#addedDependencies.get(feature) ?? []) dependencies.add(dependency);
      const plan = Object.freeze({
        ...selected,
        dependencies: Object.freeze([...dependencies].sort(compareStrings)),
      });
      this.#providerPlans.set(feature, plan);
      for (const dependency of plan.dependencies) pending.add(dependency);
    }

    const features = Object.freeze([...this.#providerPlans.keys()].sort(compareStrings));
    const providerComponents = buildProviderComponents(features, this.#providerPlans, this.#declaredCycles);
    const providers = Object.freeze(
      [...this.#providerPlans.values()].sort((left, right) => compareStrings(left.id, right.id)),
    );
    const intrinsicUses = Object.freeze([...this.#uses].sort(useOrder));
    const hostCapabilityIds = new Set<HostCapabilityId>();
    for (const provider of providers) {
      for (const capability of provider.hostCapabilities) hostCapabilityIds.add(capability);
    }
    const hostCapabilities = Object.freeze([...hostCapabilityIds].sort(compareStrings));
    let capabilityCatalog: readonly RuntimeHostCapabilityRecord[];
    try {
      capabilityCatalog = canonicalizeRuntimeHostCapabilityCatalog(this.#hostCapabilityRecords);
    } catch (error) {
      throw new RuntimeManifestInvariantError(
        "invalid-host-capability-catalog",
        error instanceof Error ? error.message : String(error),
      );
    }
    const hostCapabilityRecords = Object.freeze(
      hostCapabilities.map((capability) => resolveRuntimeHostCapabilityRecord(capabilityCatalog, capability)),
    );
    const backendRequirements = projectRuntimeBackendRequirements(providers);

    for (const use of intrinsicUses) this.#plannedIntrinsicIds.add(use.id);
    for (const value of providers) this.#plannedProviderIds.add(value.id);
    for (const capability of hostCapabilities) this.#plannedHostCapabilityIds.add(capability);

    return Object.freeze({
      policy: this.#policy,
      intrinsicUses,
      features,
      providers,
      providerComponents,
      hostCapabilities,
      hostCapabilityRecords,
      backendRequirements,
    });
  }

  #indexProviders(): ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]> {
    const ids = new Set<RuntimeProviderId>();
    const byFeature = new Map<RuntimeFeature, RuntimeProviderDefinition[]>();
    for (const provider of this.#providers) {
      if (!PROVIDER_ID_SET.has(provider.id)) {
        throw new RuntimeManifestInvariantError(
          "unknown-runtime-provider",
          `unknown runtime provider ${String(provider.id)}`,
        );
      }
      this.#assertKnownFeature(provider.feature);
      if (ids.has(provider.id)) {
        throw new RuntimeManifestInvariantError(
          "duplicate-runtime-provider",
          `runtime provider ${provider.id} was registered more than once`,
        );
      }
      ids.add(provider.id);
      for (const dependency of provider.dependencies) this.#assertKnownFeature(dependency);
      for (const capability of provider.hostCapabilities) {
        if (!HOST_CAPABILITY_ID_SET.has(capability)) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `provider ${provider.id} requests unknown host capability ${String(capability)}`,
          );
        }
      }
      if (provider.implementation.kind === "host-managed" && provider.hostCapabilities.length > 0) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `host-managed provider ${provider.id} cannot request concrete host capabilities`,
        );
      }
      if (provider.implementation.kind === "native-managed" && provider.hostCapabilities.length > 0) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `native-managed provider ${provider.id} cannot request concrete host capabilities`,
        );
      }
      if (provider.implementation.kind === "host-capability" && provider.hostCapabilities.length === 0) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `host-capability provider ${provider.id} must request at least one host capability`,
        );
      }
      // (#3526 F2-S2) Runtime twin of the `host-callable` capability type
      // narrowing. The static type already rejects a global id; this catches a
      // provider table that arrived through an `unknown`/`as` boundary, where
      // lowering would otherwise build a callable target out of a global.
      if (
        provider.implementation.kind === "host-callable" &&
        !isRuntimeHostCapabilityFuncId(provider.implementation.capability)
      ) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `host-callable provider ${provider.id} names non-callable host capability ${String(provider.implementation.capability)}`,
        );
      }
      if (!provider.supportedTargets.every((target) => TARGET_SET.has(target))) {
        throw new RuntimeManifestInvariantError(
          "provider-target-unavailable",
          `provider ${provider.id} has an unknown target`,
        );
      }
      if (!provider.supportedBackends.every((backend) => BACKEND_SET.has(backend))) {
        throw new RuntimeManifestInvariantError(
          "missing-backend-adapter",
          `provider ${provider.id} has an unknown backend`,
        );
      }
      const candidates = byFeature.get(provider.feature) ?? [];
      candidates.push(provider);
      byFeature.set(provider.feature, candidates);
    }
    return byFeature;
  }

  #selectProvider(
    feature: RuntimeFeature,
    providers: ReadonlyMap<RuntimeFeature, readonly RuntimeProviderDefinition[]>,
  ): RuntimeProviderDefinition {
    const candidates = providers.get(feature) ?? [];
    if (candidates.length === 0) {
      throw new RuntimeManifestInvariantError("missing-runtime-provider", `runtime feature ${feature} has no provider`);
    }
    // (#3526 F1-S1) The number boundary is decided by the caller-resolved
    // policy, not by target: three GC combinations share `target: "host"` and
    // disagree about both arms. An unsupported arm is a typed
    // `provider-target-unavailable` naming the exact intrinsic and policy, so
    // the owner-local preparation partition can classify it without guessing.
    const policyCandidates = isNumberBoundaryFeature(feature)
      ? ((): readonly RuntimeProviderDefinition[] => {
          const selectedId = numberBoundaryProviderId(feature, this.#policy.numberBoundary);
          if (selectedId === null) {
            throw new RuntimeManifestInvariantError(
              "provider-target-unavailable",
              `semantic intrinsic ${feature} is unavailable under number-boundary policy ` +
                `box=${this.#policy.numberBoundary.box}/unbox=${this.#policy.numberBoundary.unbox}`,
            );
          }
          return candidates.filter((candidate) => candidate.id === selectedId);
        })()
      : // (#3526 F1-S2) The boolean boundary answers to its OWN resolved
        // policy, on the same argument: `!nativeStrings` is a lane fact that
        // `target` cannot express.
        isBooleanBoundaryFeature(feature)
        ? ((): readonly RuntimeProviderDefinition[] => {
            const selectedId = booleanBoundaryProviderId(this.#policy.booleanBoundary);
            if (selectedId === null) {
              throw new RuntimeManifestInvariantError(
                "provider-target-unavailable",
                `semantic intrinsic ${feature} is unavailable under boolean-boundary policy ` +
                  `box=${this.#policy.booleanBoundary.box}`,
              );
            }
            return candidates.filter((candidate) => candidate.id === selectedId);
          })()
        : // (#3526 F1-S4) The externref undefined probe answers to its own
          // resolved policy on the same argument, and its truth table is a
          // THIRD one again: it is answered natively on every host-free lane,
          // including GC native-strings, where `numberBoundary` is unsupported
          // and `booleanBoundary` has no native arm at all.
          isExternBoundaryFeature(feature)
          ? ((): readonly RuntimeProviderDefinition[] => {
              const selectedId = externIsUndefinedProviderId(this.#policy.externIsUndefined);
              if (selectedId === null) {
                throw new RuntimeManifestInvariantError(
                  "provider-target-unavailable",
                  `semantic intrinsic ${feature} is unavailable under extern-is-undefined policy ` +
                    `probe=${this.#policy.externIsUndefined.probe}`,
                );
              }
              return candidates.filter((candidate) => candidate.id === selectedId);
            })()
          : // (#3526 F1-S3) The generator return seam answers to its own policy
            // too, and its truth table is wider than the number boundary's: this
            // one boxes natively on the GC native-strings lane.
            isGeneratorNumberBoxFeature(feature)
            ? ((): readonly RuntimeProviderDefinition[] => {
                const selectedId = generatorNumberBoxProviderId(this.#policy.generatorNumberBox);
                if (selectedId === null) {
                  throw new RuntimeManifestInvariantError(
                    "provider-target-unavailable",
                    `runtime feature ${feature} is unavailable under generator-number-box policy ` +
                      `box=${this.#policy.generatorNumberBox.box}`,
                  );
                }
                return candidates.filter((candidate) => candidate.id === selectedId);
              })()
            : // (#3526 F2-S1) Family 2's first policy. Like the generator seam it
              // carries no intrinsic instruction, so the demand arrives through
              // `requestFeature`; unlike every family-1 table, its native arm is
              // selected by `nativeStrings` alone (standalone and WASI imply it).
              isStringCompareFeature(feature)
              ? ((): readonly RuntimeProviderDefinition[] => {
                  const selectedId = stringCompareProviderId(this.#policy.stringCompare);
                  if (selectedId === null) {
                    throw new RuntimeManifestInvariantError(
                      "provider-target-unavailable",
                      `runtime feature ${feature} is unavailable under string-compare policy ` +
                        `compare=${this.#policy.stringCompare.compare}`,
                    );
                  }
                  return candidates.filter((candidate) => candidate.id === selectedId);
                })()
              : // (#3526 F2-S3) Family 2's second policy, and the compare's exact
                // sibling: same lane flag, different physical pair. The refusal
                // names `stringEq` so an operator can tell WHICH string seam a
                // disabled adapter refused.
                isStringEqFeature(feature)
                ? ((): readonly RuntimeProviderDefinition[] => {
                    const selectedId = stringEqProviderId(this.#policy.stringEq);
                    if (selectedId === null) {
                      throw new RuntimeManifestInvariantError(
                        "provider-target-unavailable",
                        `runtime feature ${feature} is unavailable under string-eq policy ` +
                          `eq=${this.#policy.stringEq.eq}`,
                      );
                    }
                    return candidates.filter((candidate) => candidate.id === selectedId);
                  })()
                : candidates;
    if (policyCandidates.length === 0) {
      throw new RuntimeManifestInvariantError(
        "missing-runtime-provider",
        `runtime feature ${feature} has no provider for its resolved policy`,
      );
    }
    const targetCandidates = policyCandidates.filter((candidate) =>
      candidate.supportedTargets.includes(this.#policy.target),
    );
    if (targetCandidates.length === 0) {
      throw new RuntimeManifestInvariantError(
        "provider-target-unavailable",
        `runtime feature ${feature} is unavailable for target ${this.#policy.target}`,
      );
    }
    const backendCandidates = targetCandidates.filter((candidate) =>
      candidate.supportedBackends.includes(this.#policy.backend),
    );
    if (backendCandidates.length === 0) {
      throw new RuntimeManifestInvariantError(
        "missing-backend-adapter",
        `runtime feature ${feature} has no ${this.#policy.backend} adapter`,
      );
    }
    if (backendCandidates.length !== 1) {
      throw new RuntimeManifestInvariantError(
        "ambiguous-runtime-provider",
        `runtime feature ${feature} has ${backendCandidates.length} matching providers`,
      );
    }
    return backendCandidates[0]!;
  }

  #assertKnownFeature(feature: RuntimeFeature): void {
    if (!isRuntimeFeature(feature)) {
      throw new RuntimeManifestInvariantError("unknown-runtime-feature", `unknown runtime feature ${String(feature)}`);
    }
  }

  #assertMutable(): void {
    if (this.#state === "open") return;
    throw new RuntimeManifestInvariantError(
      this.#state === "failed" ? "manifest-build-failed" : "manifest-frozen",
      `runtime manifest builder is ${this.#state}`,
    );
  }

  #assertFrozen(): void {
    if (this.#state !== "frozen") {
      throw new RuntimeManifestInvariantError("manifest-not-frozen", `runtime manifest builder is ${this.#state}`);
    }
  }
}
