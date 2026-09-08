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
  NUMBER_BOUNDARY_POLICY_DISABLED,
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  EXTERN_IS_UNDEFINED_POLICY_DISABLED,
  GENERATOR_NUMBER_BOX_POLICY_DISABLED,
  STRING_COMPARE_POLICY_DISABLED,
  STRING_EQ_POLICY_DISABLED,
  STRING_LEN_POLICY_DISABLED,
  STRING_CONCAT_POLICY_DISABLED,
  STRING_CHAR_CODE_AT_POLICY_DISABLED,
  STRING_CONCAT_MANY_POLICY_DISABLED,
  STRING_CONST_POLICY_DISABLED,
  HOST_CALLBACK_WRAP_POLICY_DISABLED,
  FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED,
} from "../runtime/contracts/provider-policy.js";
import type {
  RuntimeTarget,
  RuntimeBackend,
  NumberBoundaryPolicy,
  BooleanBoundaryPolicy,
  ExternIsUndefinedPolicy,
  GeneratorNumberBoxPolicy,
  StringComparePolicy,
  StringEqPolicy,
  StringLenPolicy,
  StringConcatPolicy,
  StringCharCodeAtPolicy,
  StringConcatManyPolicy,
  StringConstPolicy,
  HostCallbackWrapPolicy,
  FunctionPrototypeCallPolicy,
  RuntimeManifestPolicy,
  FrozenRuntimeManifestPolicy,
} from "../runtime/contracts/provider-policy.js";
export {
  NUMBER_BOUNDARY_POLICY_DISABLED,
  BOOLEAN_BOUNDARY_POLICY_DISABLED,
  EXTERN_IS_UNDEFINED_POLICY_DISABLED,
  GENERATOR_NUMBER_BOX_POLICY_DISABLED,
  STRING_COMPARE_POLICY_DISABLED,
  STRING_EQ_POLICY_DISABLED,
  STRING_LEN_POLICY_DISABLED,
  STRING_CONCAT_POLICY_DISABLED,
  STRING_CHAR_CODE_AT_POLICY_DISABLED,
  STRING_CONCAT_MANY_POLICY_DISABLED,
  STRING_CONST_POLICY_DISABLED,
  HOST_CALLBACK_WRAP_POLICY_DISABLED,
  FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED,
} from "../runtime/contracts/provider-policy.js";
export type {
  RuntimeTarget,
  RuntimeBackend,
  NumberBoundaryPolicy,
  BooleanBoundaryPolicy,
  ExternIsUndefinedPolicy,
  GeneratorNumberBoxPolicy,
  StringComparePolicy,
  StringEqPolicy,
  StringLenPolicy,
  StringConcatPolicy,
  StringCharCodeAtPolicy,
  StringConcatManyPolicy,
  StringConstPolicy,
  HostCallbackWrapPolicy,
  FunctionPrototypeCallPolicy,
  RuntimeManifestPolicy,
  FrozenRuntimeManifestPolicy,
} from "../runtime/contracts/provider-policy.js";
import {
  RUNTIME_BACKEND_REQUIREMENTS,
  PURE_MATH_RUNTIME_PROVIDER_IDS,
  NUMERIC_COERCION_RUNTIME_PROVIDER_IDS,
  NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS,
  BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS,
  EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS,
  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,
  GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS,
  STRING_COMPARE_RUNTIME_FEATURES,
  STRING_COMPARE_RUNTIME_PROVIDER_IDS,
  STRING_EQ_RUNTIME_FEATURES,
  STRING_EQ_RUNTIME_PROVIDER_IDS,
  STRING_LEN_RUNTIME_FEATURES,
  STRING_LEN_RUNTIME_PROVIDER_IDS,
  STRING_CONCAT_RUNTIME_FEATURES,
  STRING_CONCAT_RUNTIME_PROVIDER_IDS,
  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,
  STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS,
  STRING_CONCAT_MANY_RUNTIME_FEATURES,
  STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS,
  STRING_CONCAT_MANY_NATIVE_ARITY,
  STRING_CONST_RUNTIME_FEATURES,
  STRING_CONST_RUNTIME_PROVIDER_IDS,
  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,
  HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,
  REFERENCE_ERROR_RUNTIME_FEATURES,
  REFERENCE_ERROR_RUNTIME_PROVIDER_IDS,
} from "./runtime/contracts/manifest.js";
import type {
  RuntimeFeature,
  HostCapabilityId,
  RuntimeBackendRequirement,
  NumberBoundaryRuntimeProviderId,
  BooleanBoundaryRuntimeProviderId,
  ExternBoundaryRuntimeProviderId,
  GeneratorNumberBoxRuntimeFeature,
  GeneratorNumberBoxRuntimeProviderId,
  StringCompareRuntimeFeature,
  StringCompareRuntimeProviderId,
  StringEqRuntimeFeature,
  StringEqRuntimeProviderId,
  StringLenRuntimeFeature,
  StringLenRuntimeProviderId,
  StringConcatRuntimeFeature,
  StringConcatRuntimeProviderId,
  StringCharCodeAtRuntimeFeature,
  StringCharCodeAtRuntimeProviderId,
  StringConcatManyRuntimeFeature,
  StringConcatManyRuntimeProviderId,
  StringConstRuntimeFeature,
  StringConstRuntimeProviderId,
  HostCallbackWrapRuntimeFeature,
  HostCallbackWrapRuntimeProviderId,
  FunctionPrototypeCallRuntimeFeature,
  FunctionPrototypeCallRuntimeProviderId,
  ReferenceErrorRuntimeFeature,
  RuntimeProviderId,
  RuntimeProviderImplementation,
  RuntimeProviderDefinition,
  RuntimeProviderPlan,
  RuntimeProviderComponent,
  FrozenRuntimeManifest,
} from "./runtime/contracts/manifest.js";
export {
  RUNTIME_BACKEND_REQUIREMENTS,
  PURE_MATH_RUNTIME_PROVIDER_IDS,
  NUMERIC_COERCION_RUNTIME_PROVIDER_IDS,
  NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS,
  BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS,
  EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS,
  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,
  GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS,
  STRING_COMPARE_RUNTIME_FEATURES,
  STRING_COMPARE_RUNTIME_PROVIDER_IDS,
  STRING_EQ_RUNTIME_FEATURES,
  STRING_EQ_RUNTIME_PROVIDER_IDS,
  STRING_LEN_RUNTIME_FEATURES,
  STRING_LEN_RUNTIME_PROVIDER_IDS,
  STRING_CONCAT_RUNTIME_FEATURES,
  STRING_CONCAT_RUNTIME_PROVIDER_IDS,
  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,
  STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS,
  STRING_CONCAT_MANY_RUNTIME_FEATURES,
  STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS,
  STRING_CONCAT_MANY_NATIVE_ARITY,
  STRING_CONST_RUNTIME_FEATURES,
  STRING_CONST_RUNTIME_PROVIDER_IDS,
  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,
  HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,
  FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,
  REFERENCE_ERROR_RUNTIME_FEATURES,
  REFERENCE_ERROR_RUNTIME_PROVIDER_IDS,
} from "./runtime/contracts/manifest.js";
export type {
  RuntimeFeature,
  HostCapabilityId,
  RuntimeBackendRequirement,
  MathRuntimeProviderId,
  NumericCoercionRuntimeProviderId,
  NumberBoundaryRuntimeProviderId,
  BooleanBoundaryRuntimeProviderId,
  ExternBoundaryRuntimeProviderId,
  GeneratorNumberBoxRuntimeFeature,
  GeneratorNumberBoxRuntimeProviderId,
  StringCompareRuntimeFeature,
  StringCompareRuntimeProviderId,
  StringEqRuntimeFeature,
  StringEqRuntimeProviderId,
  StringLenRuntimeFeature,
  StringLenRuntimeProviderId,
  StringConcatRuntimeFeature,
  StringConcatRuntimeProviderId,
  StringCharCodeAtRuntimeFeature,
  StringCharCodeAtRuntimeProviderId,
  StringConcatManyRuntimeFeature,
  StringConcatManyRuntimeProviderId,
  StringConstRuntimeFeature,
  StringConstRuntimeProviderId,
  HostCallbackWrapRuntimeFeature,
  HostCallbackWrapRuntimeProviderId,
  FunctionPrototypeCallRuntimeFeature,
  FunctionPrototypeCallRuntimeProviderId,
  ReferenceErrorRuntimeFeature,
  ReferenceErrorRuntimeProviderId,
  RuntimeProviderId,
  RuntimeProviderImplementation,
  MathRuntimeProviderImplementation,
  IntrinsicRuntimeProviderImplementation,
  RuntimeProviderDefinition,
  RuntimeProviderPlan,
  RuntimeProviderComponent,
  FrozenRuntimeManifest,
} from "./runtime/contracts/manifest.js";

import { irTypeEquals } from "./nodes.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irRuntimeCallableDeclaration } from "./runtime-callable-declarations.js";
import {
  ASYNC_OPTIONAL_RUNTIME_FEATURES,
  ASYNC_RUNTIME_FEATURES,
  ASYNC_RUNTIME_PROVIDERS,
  ASYNC_RUNTIME_PROVIDER_IDS,
  type AsyncRuntimeFeature,
} from "./async-runtime-providers.js";
import {
  canonicalizeRuntimeHostCapabilityCatalog,
  isRuntimeHostCapabilityExportId,
  isRuntimeHostCapabilityFuncFamilyId,
  isRuntimeHostCapabilityFuncId,
  isRuntimeHostCapabilityGlobalId,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_IDS,
  RUNTIME_HOST_CAPABILITY_RECORDS,
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
  EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE,
  EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
  EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE,
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
    /** Failed graph node, plus the original semantic request that reached it. */
    readonly feature?: RuntimeFeature,
    readonly requestedFeature?: RuntimeFeature,
  ) {
    super(detail);
    this.name = "RuntimeManifestInvariantError";
  }
}

const ALL_TARGETS = Object.freeze<readonly RuntimeTarget[]>(["host", "standalone", "strict-no-host", "wasi"]);
const ALL_BACKENDS = Object.freeze<readonly RuntimeBackend[]>(["linear", "wasmgc"]);

const REFERENCE_ERROR_DECLARATION = irRuntimeCallableDeclaration(irRuntimeFuncRef("__new_ReferenceError"))!;
const REFERENCE_ERROR_SIGNATURE: IntrinsicSignature = Object.freeze({
  version: 1,
  params: REFERENCE_ERROR_DECLARATION.params,
  result: REFERENCE_ERROR_DECLARATION.results[0]!,
});

export const RUNTIME_FEATURE_SIGNATURES: Readonly<Partial<Record<RuntimeFeature, IntrinsicSignature>>> = Object.freeze({
  "error.reference.construct": REFERENCE_ERROR_SIGNATURE,
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
    | StringEqRuntimeProviderId
    | StringLenRuntimeProviderId
    | StringConcatRuntimeProviderId
    | StringCharCodeAtRuntimeProviderId
    | StringConcatManyRuntimeProviderId
    | StringConstRuntimeProviderId
    | HostCallbackWrapRuntimeProviderId
    | FunctionPrototypeCallRuntimeProviderId,
  feature:
    | NumberBoundaryRuntimeFeature
    | BooleanBoundaryRuntimeFeature
    | ExternBoundaryRuntimeFeature
    | GeneratorNumberBoxRuntimeFeature
    | StringCompareRuntimeFeature
    | StringEqRuntimeFeature
    | StringLenRuntimeFeature
    | StringConcatRuntimeFeature
    | StringCharCodeAtRuntimeFeature
    | StringConcatManyRuntimeFeature
    | StringConstRuntimeFeature
    | HostCallbackWrapRuntimeFeature
    | FunctionPrototypeCallRuntimeFeature,
  // (#3526 F2-S6) Optional: the batched many-arity family answers a free-form
  // intrinsic SYMBOL rather than a closed `IntrinsicId`, and `IntrinsicSignature`
  // is fixed-arity, so its two rows deliberately carry none.
  signature: IntrinsicSignature | undefined,
  implementation: RuntimeProviderImplementation,
  hostCapabilities: readonly HostCapabilityId[],
): RuntimeProviderDefinition {
  return Object.freeze({
    id,
    feature,
    // (#3526 F2-S6) Omitted, not `undefined`: `signature` is an OPTIONAL field
    // on the definition, and a row that carries none must not carry the key.
    ...(signature === undefined ? {} : { signature }),
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

/**
 * (#3526 F2-S4) The string length seam's two arms. Both answer the same UTF-16
 * code-unit count: on the host lane through the central `string.len` capability
 * record (`wasm:js-string.length`, one of the five builtins `addStringImports`
 * registers as a block before Phase 3), on the native-strings lanes by reading
 * field 0 of the Program-ABI string carrier.
 *
 * The native row is the catalogue's first `carrier-field` provider, and it
 * REUSES {@link EXTERNREF_TO_I32_INTRINSIC_SIGNATURE} nominally — exactly as
 * `native.js.string.eq` reuses the externref pair for `__str_equals`. The
 * signature states the seam's SEMANTIC shape (one string in, an i32 count out),
 * not the physical `struct.get`; introducing a second signature for the same
 * semantics would let the two arms drift.
 */
export const STRING_LEN_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.string.len",
    "js.string.len",
    EXTERNREF_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "string.len" },
    ["string.len"],
  ),
  numberBoundaryProvider(
    "native.js.string.len",
    "js.string.len",
    EXTERNREF_TO_I32_INTRINSIC_SIGNATURE,
    { kind: "carrier-field", carrier: "string", fieldIndex: 0 },
    [],
  ),
]);

/** The exact provider the admitted string-length arm selects, or `null` when
 * the caller resolved it to unsupported. */
function stringLenProviderId(policy: StringLenPolicy): StringLenRuntimeProviderId | null {
  if (policy.len === "host") return "host.js.string.len";
  return policy.len === "native" ? "native.js.string.len" : null;
}

const STRING_LEN_FEATURE_SET: ReadonlySet<string> = new Set(STRING_LEN_RUNTIME_FEATURES);

function isStringLenFeature(feature: RuntimeFeature): feature is StringLenRuntimeFeature {
  return STRING_LEN_FEATURE_SET.has(feature);
}

/**
 * (#3526 F2-S5) The string concatenation seam's four arms — two authorities
 * times two concat MODES.
 *
 * Both host rows name the SAME `string.concat` capability, and that is the
 * documented collapse rather than an oversight: `wasm:js-string` has no owned
 * append builtin, so on the host lane an `owned-append` concatenation is served
 * by the ordinary `concat` import. The catalogue keys providers by id and
 * projects host capabilities through a SET, so two rows naming one capability
 * freeze to a single `string.concat` record and a single import.
 *
 * All four rows carry {@link EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE}
 * — the seam's semantic shape, and the only signature in the catalogue whose
 * result is a non-null `ref extern`, matching the `string.concat` host record.
 */
export const STRING_CONCAT_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.string.concat",
    "js.string.concat",
    EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "string.concat" },
    ["string.concat"],
  ),
  numberBoundaryProvider(
    "host.js.string.concat.owned",
    "js.string.concat.owned",
    EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE,
    { kind: "host-callable", capability: "string.concat" },
    ["string.concat"],
  ),
  numberBoundaryProvider(
    "native.js.string.concat",
    "js.string.concat",
    EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__str_concat" },
    [],
  ),
  numberBoundaryProvider(
    "native.js.string.concat.owned",
    "js.string.concat.owned",
    EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__str_concat_owned" },
    [],
  ),
]);

/** The `owned-append` half of the concat feature pair; named once here. */
const STRING_CONCAT_OWNED_RUNTIME_FEATURE = STRING_CONCAT_RUNTIME_FEATURES[1];

/**
 * The exact provider the admitted string-concat arm selects for `feature`, or
 * `null` when the caller resolved it to unsupported.
 *
 * Takes the FEATURE as well as the policy — the only selector in the family
 * that does, because the policy picks the authority and the feature picks the
 * mode's helper on it.
 */
function stringConcatProviderId(
  feature: StringConcatRuntimeFeature,
  policy: StringConcatPolicy,
): StringConcatRuntimeProviderId | null {
  const owned = feature === STRING_CONCAT_OWNED_RUNTIME_FEATURE;
  if (policy.concat === "host") return owned ? "host.js.string.concat.owned" : "host.js.string.concat";
  if (policy.concat === "native") return owned ? "native.js.string.concat.owned" : "native.js.string.concat";
  return null;
}

const STRING_CONCAT_FEATURE_SET: ReadonlySet<string> = new Set(STRING_CONCAT_RUNTIME_FEATURES);

function isStringConcatFeature(feature: RuntimeFeature): feature is StringConcatRuntimeFeature {
  return STRING_CONCAT_FEATURE_SET.has(feature);
}

/**
 * (#3526 F2-S7) The guarded `charCodeAt` seam's two arms.
 *
 * Both rows are `runtime-callable` and name a DEFINED helper, not an import —
 * which is the fact that separates this seam from every family-2 predecessor.
 * The host helper `__jsstr_charCodeAt` is minted on demand by
 * `ensureHostCharCodeAtGuarded` and CLOSES OVER two builtin capability records
 * (`string.char_code_at` for the raw read, `string.len` for the bounds test it
 * needs to answer `NaN` instead of trapping); the row lists both because they
 * are what the helper needs REGISTERED, not what the helper is. Requesting
 * capabilities on a `runtime-callable` row is admitted by construction — the
 * validation triad forbids them only on `host-managed`, `native-managed` and
 * `carrier-field`, and requires them only on `host-capability`.
 *
 * `host-callable` would have been the wrong kind for the same reason: it names
 * an IMPORT the consumer binds by import-section position, and this provider is
 * a defined function. A dedicated `composed-callable` kind stating "a helper
 * over N records" was considered and rejected for this slice — it would be a
 * union arm plus a validation triad with no consumer reading the distinction;
 * if a later seam needs it, these two rows migrate in one edit.
 *
 * Both carry {@link EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE} — the seam's
 * semantic shape, NOT the `string.char_code_at` record's `(externref, i32) ->
 * i32` trapping ABI.
 */
export const STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.string.char_code_at",
    "js.string.char_code_at",
    EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__jsstr_charCodeAt" },
    ["string.char_code_at", "string.len"],
  ),
  numberBoundaryProvider(
    "native.js.string.char_code_at",
    "js.string.char_code_at",
    EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__str_charCodeAt" },
    [],
  ),
]);

/**
 * (#3526 F2-S6) The batched many-arity seam's two arms — one per authority.
 *
 * NEITHER row carries a `signature`, and there is no
 * `RUNTIME_FEATURE_SIGNATURES` entry: `IntrinsicSignature` is fixed-arity
 * while this family is not, and the symbols it answers
 * (`string.concat$arityN`, `async.string.concat$arity5`) are free-form
 * intrinsic symbols rather than closed `IntrinsicId`s. The host record's
 * params SCHEME plus the native row's arity range are the shape statement, and
 * because the host arm derives its import's params from the record, the record
 * IS the checked contract. A family signature would be checked by nothing
 * unless `RUNTIME_FEATURE_SIGNATURES` and `signatureEquals` were widened
 * manifest-wide for this one feature.
 */
export const STRING_CONCAT_MANY_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.string.concat.many",
    "js.string.concat.many",
    undefined,
    { kind: "host-callable-family", capability: "string.concat.many" },
    ["string.concat.many"],
  ),
  numberBoundaryProvider(
    "native.js.string.concat.many",
    "js.string.concat.many",
    undefined,
    {
      kind: "runtime-callable-family",
      symbolPrefix: "__str_concat_",
      arity: STRING_CONCAT_MANY_NATIVE_ARITY,
    },
    [],
  ),
]);

/** The exact provider the admitted charCodeAt arm selects, or `null` when the
 * caller resolved it to unsupported. */
function stringCharCodeAtProviderId(policy: StringCharCodeAtPolicy): StringCharCodeAtRuntimeProviderId | null {
  if (policy.charCodeAt === "host") return "host.js.string.char_code_at";
  return policy.charCodeAt === "native" ? "native.js.string.char_code_at" : null;
}

const STRING_CHAR_CODE_AT_FEATURE_SET: ReadonlySet<string> = new Set(STRING_CHAR_CODE_AT_RUNTIME_FEATURES);

function isStringCharCodeAtFeature(feature: RuntimeFeature): feature is StringCharCodeAtRuntimeFeature {
  return STRING_CHAR_CODE_AT_FEATURE_SET.has(feature);
}

/**
 * The exact provider the admitted batched many-arity arm selects, or `null`
 * when the caller resolved the CONCATENATION authority to unsupported.
 *
 * Keyed on {@link StringConcatPolicy}, not on {@link StringConcatManyPolicy}.
 * That is the measured shape of the seam, not a convenience: the two resolve
 * arms read `ctx.nativeStrings` alone today — exactly F2-S5's
 * `stringConcat.concat` — and they are reachable independently of whether the
 * pass ran. The `async.string.concat$arity5` producer is source-shape-driven
 * and consults no lane flag, so an arm firing while `batch === "off"` is not
 * structurally impossible; selecting the row by `batch` would throw there,
 * while selecting it by `concat` reproduces today's answer exactly.
 */
function stringConcatManyProviderId(policy: StringConcatPolicy): StringConcatManyRuntimeProviderId | null {
  if (policy.concat === "host") return "host.js.string.concat.many";
  if (policy.concat === "native") return "native.js.string.concat.many";
  return null;
}

/**
 * (#3526 F2-S8) The string literal storage seam's four arms — two authorities
 * times two import NAMESPACES.
 *
 * The two host rows name the two GLOBAL capability records, and that pairing is
 * the point of the split: `string.const` publishes module `string_constants`
 * with field scheme `literal`, `string.const.utf16` publishes
 * `string_constants16` with `literal-utf16-hex`. A module freezes whichever
 * rows its literals demand, so its `hostCapabilityRecords` names exactly the
 * namespaces it imports.
 *
 * The two NATIVE rows deliberately name the SAME Program-ABI role: natively a
 * lone surrogate is a plain u16 code unit in an interned literal, so there is
 * no second namespace to select. They differ only in which feature they answer,
 * which keeps the demand honest on both lanes with one policy.
 *
 * All four carry {@link EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE} — the catalogue's
 * only empty-parameter signature, and the one place a row states a VALUE shape
 * instead of a call.
 */
export const STRING_CONST_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.js.string.const",
    "js.string.const",
    EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
    { kind: "host-global", capability: "string.const" },
    ["string.const"],
  ),
  numberBoundaryProvider(
    "host.js.string.const.utf16",
    "js.string.const.utf16",
    EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
    { kind: "host-global", capability: "string.const.utf16" },
    ["string.const.utf16"],
  ),
  numberBoundaryProvider(
    "native.js.string.const",
    "js.string.const",
    EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
    { kind: "native-global", role: "native-string-literal" },
    [],
  ),
  numberBoundaryProvider(
    "native.js.string.const.utf16",
    "js.string.const.utf16",
    EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
    { kind: "native-global", role: "native-string-literal" },
    [],
  ),
]);

/** The exact provider the admitted storage arm selects for `feature`, or `null`
 * when the caller resolved the seam to unsupported. */
function stringConstProviderId(
  feature: StringConstRuntimeFeature,
  policy: StringConstPolicy,
): StringConstRuntimeProviderId | null {
  if (policy.storage === "unsupported") return null;
  const utf16 = feature === "js.string.const.utf16";
  if (policy.storage === "host") return utf16 ? "host.js.string.const.utf16" : "host.js.string.const";
  return utf16 ? "native.js.string.const.utf16" : "native.js.string.const";
}

const STRING_CONST_FEATURE_SET: ReadonlySet<string> = new Set(STRING_CONST_RUNTIME_FEATURES);

function isStringConstFeature(feature: RuntimeFeature): feature is StringConstRuntimeFeature {
  return STRING_CONST_FEATURE_SET.has(feature);
}

const STRING_CONCAT_MANY_FEATURE_SET: ReadonlySet<string> = new Set(STRING_CONCAT_MANY_RUNTIME_FEATURES);

function isStringConcatManyFeature(feature: RuntimeFeature): feature is StringConcatManyRuntimeFeature {
  return STRING_CONCAT_MANY_FEATURE_SET.has(feature);
}

/**
 * (#3526 F2-S6) The arity ceiling the `batchStringConcat` pass must respect
 * under `batch`, DERIVED from the static provider rows rather than copied.
 *
 * `host` reads the capability record's `params.max` — `null` there means the
 * JS provider answers any arity (it matches `__concat_` by prefix), which is
 * `Number.POSITIVE_INFINITY` to the pass. `native` reads the native row's
 * `arity.max`. `off` is not a value here by construction: the caller must not
 * run the pass at all, and the type says so.
 */
export function stringConcatManyArityCap(batch: Exclude<StringConcatManyPolicy["batch"], "off">): number {
  if (batch === "native") return STRING_CONCAT_MANY_NATIVE_ARITY.max;
  const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "string.concat.many");
  if (record.kind !== "func-family") {
    throw new RuntimeManifestInvariantError(
      "invalid-host-capability-catalog",
      "host capability string.concat.many is not a host capability family",
    );
  }
  return record.params.max ?? Number.POSITIVE_INFINITY;
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

/**
 * (#3526 F3-S1) The host callback MAKER seam's two arms. They do not answer the
 * same emission, and that asymmetry is the point: the host arm is a `call` on
 * the EXISTING `env.__make_callback` import the legacy pre-pass already minted
 * (`declarations/import-collector.ts`), reached through the central
 * `async.callback.wrap` record — the same record the async projection
 * `host.promise.react` cites, deliberately reused rather than renamed or
 * duplicated. The native arm emits nothing at all: the reserved standalone DOM
 * dispatcher owns the crossing, so the row is a licence, not a target.
 *
 * The manifest decides WHICH authority answers; it introduces no new spelling,
 * no second registration path and no new import, which is why the migration is
 * byte-neutral on every lane.
 */
export const HOST_CALLBACK_WRAP_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "host.callback.wrap",
    "js.callback.wrap",
    // No signature: the maker is a two-operand `(i32, externref) -> externref`
    // import whose ABI the capability record already states in full, and
    // `IntrinsicSignature` describes a closed `IntrinsicId` this seam has none of.
    undefined,
    { kind: "host-callable", capability: "async.callback.wrap" },
    ["async.callback.wrap"],
  ),
  numberBoundaryProvider(
    "native.callback.dispatch",
    "js.callback.wrap",
    undefined,
    { kind: "native-dispatch", service: "standalone-dom-callback-dispatch" },
    [],
  ),
]);

/** The exact provider the admitted host-callback-wrap arm selects, or `null`
 * when the caller resolved it to unsupported. */
function hostCallbackWrapProviderId(policy: HostCallbackWrapPolicy): HostCallbackWrapRuntimeProviderId | null {
  if (policy.wrap === "host") return "host.callback.wrap";
  return policy.wrap === "native-dispatch" ? "native.callback.dispatch" : null;
}

const HOST_CALLBACK_WRAP_FEATURE_SET: ReadonlySet<string> = new Set(HOST_CALLBACK_WRAP_RUNTIME_FEATURES);

function isHostCallbackWrapFeature(feature: RuntimeFeature): feature is HostCallbackWrapRuntimeFeature {
  return HOST_CALLBACK_WRAP_FEATURE_SET.has(feature);
}

/**
 * (#3526 F3-S3) The `%Function.prototype%` call seam's single arm.
 *
 * `__function_prototype_call` is a compiler-defined runtime func, minted by
 * `ensureFunctionPrototypeCallHelper` on the lane that emits it. The manifest
 * decides WHETHER this seam is answered natively and by which symbol; it mints
 * nothing, imports nothing and introduces no second spelling, which is why the
 * migration moves no bytes.
 */
export const FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "native.js.function.prototype.call",
    "js.function.prototype.call",
    // No signature, exactly like the F3-S1 maker rows above: `IntrinsicSignature`
    // describes a closed `IntrinsicId`, and this seam has none — from-ast emits a
    // plain `call`, not an `intrinsic`.
    //
    // Reusing `EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE` for its `() -> externref`
    // shape would ALSO have broken a deliberate F2-S8 invariant (measured, not
    // predicted): that signature means "a GLOBAL holding an externref VALUE", and
    // F2-S8 pins the string-const family as the catalogue's ONLY empty-parameter
    // rows precisely so an empty-params row can only ever be a storage row. A
    // nullary CALL is not a storage row, so it must not borrow that spelling.
    undefined,
    { kind: "runtime-callable", symbol: "__function_prototype_call" },
    [],
  ),
]);

/** The exact provider the admitted `%Function.prototype%` call arm selects, or
 * `null` when the caller resolved it to unsupported. */
function functionPrototypeCallProviderId(
  policy: FunctionPrototypeCallPolicy,
): FunctionPrototypeCallRuntimeProviderId | null {
  return policy.call === "native" ? "native.js.function.prototype.call" : null;
}

const FUNCTION_PROTOTYPE_CALL_FEATURE_SET: ReadonlySet<string> = new Set(FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES);

function isFunctionPrototypeCallFeature(feature: RuntimeFeature): feature is FunctionPrototypeCallRuntimeFeature {
  return FUNCTION_PROTOTYPE_CALL_FEATURE_SET.has(feature);
}

/** TDZ constructor providers use target policy and the shared callable signature. */
export const REFERENCE_ERROR_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "host.error.reference.construct",
    feature: REFERENCE_ERROR_DECLARATION.feature,
    signature: REFERENCE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze(["error.reference.construct"] as const),
    supportedTargets: Object.freeze(["host"] as const),
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({ kind: "host-callable", capability: "error.reference.construct" } as const),
  }),
  Object.freeze({
    id: "native.error.reference.construct",
    feature: REFERENCE_ERROR_DECLARATION.feature,
    signature: REFERENCE_ERROR_SIGNATURE,
    dependencies: Object.freeze([]),
    hostCapabilities: Object.freeze([]),
    supportedTargets: Object.freeze(["standalone", "wasi"] as const),
    // The existing native constructor builds a WasmGC Error struct and
    // converts it to externref. Its name does not establish a linear adapter.
    supportedBackends: Object.freeze(["wasmgc"] as const),
    implementation: Object.freeze({ kind: "runtime-callable", symbol: "__new_ReferenceError" } as const),
  }),
]);

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
    ...STRING_LEN_RUNTIME_PROVIDERS,
    ...STRING_CONCAT_RUNTIME_PROVIDERS,
    ...STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS,
    ...STRING_CONCAT_MANY_RUNTIME_PROVIDERS,
    ...STRING_CONST_RUNTIME_PROVIDERS,
    ...HOST_CALLBACK_WRAP_RUNTIME_PROVIDERS,
    ...FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS,
    ...REFERENCE_ERROR_RUNTIME_PROVIDERS,
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
  ...STRING_LEN_RUNTIME_FEATURES,
  ...STRING_CONCAT_RUNTIME_FEATURES,
  ...STRING_CHAR_CODE_AT_RUNTIME_FEATURES,
  ...STRING_CONCAT_MANY_RUNTIME_FEATURES,
  ...STRING_CONST_RUNTIME_FEATURES,
  ...HOST_CALLBACK_WRAP_RUNTIME_FEATURES,
  ...FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,
  ...REFERENCE_ERROR_RUNTIME_FEATURES,
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
  ...STRING_LEN_RUNTIME_PROVIDER_IDS,
  ...STRING_CONCAT_RUNTIME_PROVIDER_IDS,
  ...STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS,
  ...STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS,
  ...STRING_CONST_RUNTIME_PROVIDER_IDS,
  ...HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,
  ...FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,
  ...REFERENCE_ERROR_RUNTIME_PROVIDER_IDS,
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
    const stringLen = policy.stringLen ?? STRING_LEN_POLICY_DISABLED;
    const stringConcat = policy.stringConcat ?? STRING_CONCAT_POLICY_DISABLED;
    const stringCharCodeAt = policy.stringCharCodeAt ?? STRING_CHAR_CODE_AT_POLICY_DISABLED;
    const stringConcatMany = policy.stringConcatMany ?? STRING_CONCAT_MANY_POLICY_DISABLED;
    const stringConst = policy.stringConst ?? STRING_CONST_POLICY_DISABLED;
    const hostCallbackWrap = policy.hostCallbackWrap ?? HOST_CALLBACK_WRAP_POLICY_DISABLED;
    const functionPrototypeCall = policy.functionPrototypeCall ?? FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED;
    // (#3526 F2-S6) The two concat policies are not independent: whatever the
    // pass fuses is lowered through the CONCATENATION authority, so a running
    // pass whose batch authority disagrees with `stringConcat.concat` would
    // fuse trees the resolve arm then refuses. The integration projections
    // cannot produce that pair — `concat` is `nativeStrings ? native : host`
    // and `batch` is `native` only under `nativeStrings`, `host` only under
    // `!nativeStrings` — so this guards HAND-BUILT policies, which is exactly
    // where a wrong pair would otherwise reach lowering unchallenged.
    if (stringConcatMany.batch !== "off" && stringConcatMany.batch !== stringConcat.concat) {
      throw new RuntimeManifestInvariantError(
        "provider-target-unavailable",
        `string-concat-many policy batch=${stringConcatMany.batch} disagrees with string-concat policy ` +
          `concat=${stringConcat.concat}`,
      );
    }
    this.#policy = Object.freeze({
      ...policy,
      numberBoundary: Object.freeze({ box: numberBoundary.box, unbox: numberBoundary.unbox }),
      booleanBoundary: Object.freeze({ box: booleanBoundary.box }),
      externIsUndefined: Object.freeze({ probe: externIsUndefined.probe }),
      generatorNumberBox: Object.freeze({ box: generatorNumberBox.box }),
      stringCompare: Object.freeze({ compare: stringCompare.compare }),
      stringEq: Object.freeze({ eq: stringEq.eq }),
      stringLen: Object.freeze({ len: stringLen.len }),
      stringConcat: Object.freeze({ concat: stringConcat.concat }),
      stringCharCodeAt: Object.freeze({ charCodeAt: stringCharCodeAt.charCodeAt }),
      stringConcatMany: Object.freeze({ batch: stringConcatMany.batch }),
      stringConst: Object.freeze({ storage: stringConst.storage }),
      hostCallbackWrap: Object.freeze({ wrap: hostCallbackWrap.wrap }),
      functionPrototypeCall: Object.freeze({ call: functionPrototypeCall.call }),
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
  resolveProvider(feature: ReferenceErrorRuntimeFeature): RuntimeProviderDefinition;
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
    const pending = new Map<RuntimeFeature, RuntimeFeature>();
    for (const feature of this.#requestedFeatures) pending.set(feature, feature);
    for (const use of this.#uses) {
      const feature = INTRINSIC_DEFINITIONS[use.id].feature;
      pending.set(feature, feature);
    }

    while (pending.size > 0) {
      const feature = [...pending.keys()].sort(compareStrings)[0]!;
      const requestedFeature = pending.get(feature)!;
      pending.delete(feature);
      if (this.#providerPlans.has(feature)) continue;
      let selected: RuntimeProviderDefinition;
      try {
        selected = this.#selectProvider(feature, providersByFeature);
      } catch (error) {
        if (!(error instanceof RuntimeManifestInvariantError)) throw error;
        throw new RuntimeManifestInvariantError(error.code, error.message, feature, requestedFeature);
      }
      const expectedSignature = RUNTIME_FEATURE_SIGNATURES[feature];
      if (
        expectedSignature !== undefined &&
        (selected.signature === undefined || !signatureEquals(selected.signature, expectedSignature))
      ) {
        throw new RuntimeManifestInvariantError(
          "provider-signature-mismatch",
          `provider ${selected.id} does not implement the ${feature} signature`,
          feature,
          requestedFeature,
        );
      }
      const dependencies = new Set(selected.dependencies);
      for (const dependency of this.#addedDependencies.get(feature) ?? []) dependencies.add(dependency);
      const plan = Object.freeze({
        ...selected,
        dependencies: Object.freeze([...dependencies].sort(compareStrings)),
      });
      this.#providerPlans.set(feature, plan);
      for (const dependency of plan.dependencies) {
        if (!pending.has(dependency)) pending.set(dependency, requestedFeature);
      }
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
        // (#3526 F3-S2) No provider may REQUEST an export capability. Every
        // implementation kind names something the module calls or reads, and an
        // export is the opposite direction — the module publishes it for the
        // host. The refusal is load-bearing rather than defensive: `HostCapabilityId`
        // is the WHOLE id union, so without it an export id would type-check in
        // `hostCapabilities`, reach `freeze()`'s record map and be published as
        // though it were an import the module makes. Lifting it for a
        // `host-export` implementation kind is F3-S5's first step.
        if (isRuntimeHostCapabilityExportId(capability)) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `provider ${provider.id} cannot request export host capability ${capability}`,
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
      // (#3526 F3-S1) The dispatcher arm imports nothing, so a concrete host
      // capability on it would be a claim the frozen `hostCapabilityRecords`
      // then publishes and no emission ever honours.
      if (provider.implementation.kind === "native-dispatch" && provider.hostCapabilities.length > 0) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `native-dispatch provider ${provider.id} cannot request concrete host capabilities`,
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
      // (#3526 F2-S6) Runtime twin of the FAMILY capability narrowing, and its
      // mirror: a `host-callable-family` may name only a family id, and the
      // `host-callable` check above already refuses a family id there — so the
      // two kinds partition the capability space at runtime as well as in the
      // types.
      if (
        provider.implementation.kind === "host-callable-family" &&
        !isRuntimeHostCapabilityFuncFamilyId(provider.implementation.capability)
      ) {
        throw new RuntimeManifestInvariantError(
          "unknown-host-capability",
          `host-callable-family provider ${provider.id} names non-family host capability ${String(provider.implementation.capability)}`,
        );
      }
      // (#3526 F2-S6) A `runtime-callable-family` names a SET of native
      // symbols and imports nothing, so a host capability request would let a
      // native arm drag an import into a host-free lane — the `carrier-field`
      // rule below, for the same reason. The range is validated here because
      // the frozen manifest is the only place the consumer can learn it: a
      // provider table arriving through an `unknown`/`as` boundary would
      // otherwise reach the resolve arm with a bound that admits an arity no
      // helper exists for.
      if (provider.implementation.kind === "runtime-callable-family") {
        const { symbolPrefix, arity } = provider.implementation;
        if (provider.hostCapabilities.length > 0) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `runtime-callable-family provider ${provider.id} cannot request concrete host capabilities`,
          );
        }
        if (typeof symbolPrefix !== "string" || symbolPrefix.length === 0) {
          throw new RuntimeManifestInvariantError(
            "unknown-runtime-provider",
            `runtime-callable-family provider ${provider.id} has an empty symbol prefix`,
          );
        }
        if (!Number.isSafeInteger(arity.min) || arity.min < STRING_CONCAT_MANY_NATIVE_ARITY.min) {
          throw new RuntimeManifestInvariantError(
            "unknown-runtime-provider",
            `runtime-callable-family provider ${provider.id} has an invalid minimum arity ${String(arity.min)}`,
          );
        }
        if (!Number.isSafeInteger(arity.max) || arity.max < arity.min) {
          throw new RuntimeManifestInvariantError(
            "unknown-runtime-provider",
            `runtime-callable-family provider ${provider.id} has an invalid maximum arity ${String(arity.max)}`,
          );
        }
      }
      // (#3526 F2-S4) A `carrier-field` provider reads a Program-ABI carrier
      // field; it imports nothing, so requesting a host capability would let a
      // native arm silently drag a host import into a host-free lane. The
      // carrier role and field index are checked here too, because the frozen
      // manifest is the only place the consumer can learn them — a provider
      // table that arrived through an `unknown`/`as` boundary would otherwise
      // reach attachment with a nonsense field index and mislower.
      if (provider.implementation.kind === "carrier-field") {
        if (provider.hostCapabilities.length > 0) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `carrier-field provider ${provider.id} cannot request concrete host capabilities`,
          );
        }
        if (provider.implementation.carrier !== "string") {
          throw new RuntimeManifestInvariantError(
            "unknown-runtime-provider",
            `carrier-field provider ${provider.id} names unknown carrier ${String(provider.implementation.carrier)}`,
          );
        }
        if (!Number.isSafeInteger(provider.implementation.fieldIndex) || provider.implementation.fieldIndex < 0) {
          throw new RuntimeManifestInvariantError(
            "unknown-runtime-provider",
            `carrier-field provider ${provider.id} has an invalid field index ${String(provider.implementation.fieldIndex)}`,
          );
        }
      }
      // (#3526 F2-S8) A `host-global` provider names a GLOBAL capability and
      // imports one global per literal, so BOTH halves are checked: the kind
      // (the runtime twin of the type narrowing, for a table that arrived
      // through an `unknown`/`as` boundary) and the DECLARATION — the row must
      // also request that capability, or the freeze would resolve a record the
      // module never claimed and the published `hostCapabilityRecords` would
      // understate what the module imports.
      if (provider.implementation.kind === "host-global") {
        const capability = provider.implementation.capability;
        if (!isRuntimeHostCapabilityGlobalId(capability)) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `host-global provider ${provider.id} names non-global host capability ${String(capability)}`,
          );
        }
        if (!provider.hostCapabilities.includes(capability)) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `host-global provider ${provider.id} does not request its own host capability ${String(capability)}`,
          );
        }
      }
      // (#3526 F2-S8) The native twin names a Program-ABI global ROLE and
      // imports nothing, so a host capability request would let a native arm
      // drag an import into a host-free lane — the `carrier-field` and
      // `runtime-callable-family` rules above, for the same reason.
      if (provider.implementation.kind === "native-global") {
        if (provider.hostCapabilities.length > 0) {
          throw new RuntimeManifestInvariantError(
            "unknown-host-capability",
            `native-global provider ${provider.id} cannot request concrete host capabilities`,
          );
        }
        if (provider.implementation.role !== "native-string-literal") {
          throw new RuntimeManifestInvariantError(
            "unknown-runtime-provider",
            `native-global provider ${provider.id} names unknown ABI role ${String(provider.implementation.role)}`,
          );
        }
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
                : // (#3526 F2-S4) Family 2's third policy. Same lane flag as its
                  // two siblings, but the arms it chooses between are not a
                  // callable pair: the native one is a `carrier-field` read. The
                  // refusal names `string-len` so an operator can tell WHICH
                  // string seam a disabled adapter refused.
                  isStringLenFeature(feature)
                  ? ((): readonly RuntimeProviderDefinition[] => {
                      const selectedId = stringLenProviderId(this.#policy.stringLen);
                      if (selectedId === null) {
                        throw new RuntimeManifestInvariantError(
                          "provider-target-unavailable",
                          `runtime feature ${feature} is unavailable under string-len policy ` +
                            `len=${this.#policy.stringLen.len}`,
                        );
                      }
                      return candidates.filter((candidate) => candidate.id === selectedId);
                    })()
                  : // (#3526 F2-S5) Family 2's fourth policy, and the first in
                    // the catalogue where ONE policy answers TWO features: the
                    // policy picks the authority, the feature picks the concat
                    // MODE's helper on it. The refusal names `string-concat` so
                    // an operator can tell WHICH string seam a disabled adapter
                    // refused.
                    isStringConcatFeature(feature)
                    ? ((): readonly RuntimeProviderDefinition[] => {
                        const selectedId = stringConcatProviderId(feature, this.#policy.stringConcat);
                        if (selectedId === null) {
                          throw new RuntimeManifestInvariantError(
                            "provider-target-unavailable",
                            `runtime feature ${feature} is unavailable under string-concat policy ` +
                              `concat=${this.#policy.stringConcat.concat}`,
                          );
                        }
                        return candidates.filter((candidate) => candidate.id === selectedId);
                      })()
                    : // (#3526 F2-S7) Family 2's fifth policy, and the first
                      // whose BOTH arms are `runtime-callable`: the discriminator
                      // is the provider ID, not the implementation kind. The
                      // refusal names `string-char-code-at` so an operator can
                      // tell WHICH string seam a disabled adapter refused.
                      isStringCharCodeAtFeature(feature)
                      ? ((): readonly RuntimeProviderDefinition[] => {
                          const selectedId = stringCharCodeAtProviderId(this.#policy.stringCharCodeAt);
                          if (selectedId === null) {
                            throw new RuntimeManifestInvariantError(
                              "provider-target-unavailable",
                              `runtime feature ${feature} is unavailable under string-char-code-at policy ` +
                                `charCodeAt=${this.#policy.stringCharCodeAt.charCodeAt}`,
                            );
                          }
                          return candidates.filter((candidate) => candidate.id === selectedId);
                        })()
                      : // (#3526 F2-S6) The BATCHED many-arity family. It selects
                        // on the CONCATENATION policy, like the pair arm beside
                        // it — the pass policy decides whether a demand exists at
                        // all, never which authority answers one.
                        isStringConcatManyFeature(feature)
                        ? ((): readonly RuntimeProviderDefinition[] => {
                            const selectedId = stringConcatManyProviderId(this.#policy.stringConcat);
                            if (selectedId === null) {
                              throw new RuntimeManifestInvariantError(
                                "provider-target-unavailable",
                                `runtime feature ${feature} is unavailable under string-concat policy ` +
                                  `concat=${this.#policy.stringConcat.concat} (many-arity family)`,
                              );
                            }
                            return candidates.filter((candidate) => candidate.id === selectedId);
                          })()
                        : // (#3526 F2-S8) Family 2's last policy, and the only
                          // one whose arms are VALUES: the policy picks the
                          // authority, the FEATURE picks the import namespace on
                          // it (the lone-surrogate split is a per-literal
                          // derivation, never an arm). The refusal names
                          // `string-const` so an operator can tell WHICH string
                          // seam a disabled adapter refused.
                          isStringConstFeature(feature)
                          ? ((): readonly RuntimeProviderDefinition[] => {
                              const selectedId = stringConstProviderId(feature, this.#policy.stringConst);
                              if (selectedId === null) {
                                throw new RuntimeManifestInvariantError(
                                  "provider-target-unavailable",
                                  `runtime feature ${feature} is unavailable under string-const policy ` +
                                    `storage=${this.#policy.stringConst.storage}`,
                                );
                              }
                              return candidates.filter((candidate) => candidate.id === selectedId);
                            })()
                          : // (#3526 F3-S1) Family 3's first policy, and the
                            // first whose arms are not two spellings of one
                            // crossing: `host` names the maker import through
                            // the reused `async.callback.wrap` record,
                            // `native-dispatch` licenses the exact
                            // standalone-DOM dispatcher, which emits nothing.
                            // The refusal names `host-callback-wrap` so an
                            // operator can tell WHICH boundary a disabled
                            // adapter refused.
                            isHostCallbackWrapFeature(feature)
                            ? ((): readonly RuntimeProviderDefinition[] => {
                                const selectedId = hostCallbackWrapProviderId(this.#policy.hostCallbackWrap);
                                if (selectedId === null) {
                                  throw new RuntimeManifestInvariantError(
                                    "provider-target-unavailable",
                                    `runtime feature ${feature} is unavailable under host-callback-wrap policy ` +
                                      `wrap=${this.#policy.hostCallbackWrap.wrap}`,
                                  );
                                }
                                return candidates.filter((candidate) => candidate.id === selectedId);
                              })()
                            : // (#3526 F3-S3) Family 3's second policy, and the
                              // first in the issue with a SINGLE admitting arm:
                              // `%Function.prototype%.[[Call]]` has no host
                              // crossing to select against, so the refusal
                              // below is the whole "not this lane" answer
                              // rather than a choice between two spellings.
                              isFunctionPrototypeCallFeature(feature)
                              ? ((): readonly RuntimeProviderDefinition[] => {
                                  const selectedId = functionPrototypeCallProviderId(
                                    this.#policy.functionPrototypeCall,
                                  );
                                  if (selectedId === null) {
                                    throw new RuntimeManifestInvariantError(
                                      "provider-target-unavailable",
                                      `runtime feature ${feature} is unavailable under function-prototype-call policy ` +
                                        `call=${this.#policy.functionPrototypeCall.call}`,
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
