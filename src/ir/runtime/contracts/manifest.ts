// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  RuntimeBackend,
  RuntimeTarget,
  FrozenRuntimeManifestPolicy,
} from "../../../runtime/contracts/provider-policy.js";
import type { AsyncRuntimeProviderId } from "../../../runtime/contracts/async-provider-schema.js";
import type {
  RuntimeHostCapabilityFuncFamilyId,
  RuntimeHostCapabilityFuncId,
  RuntimeHostCapabilityGlobalId,
  RuntimeHostCapabilityId,
  RuntimeHostCapabilityRecord,
} from "../../../runtime/contracts/host-capability-schema.js";
import type { AsyncRuntimeFeature } from "../../core/async-intents.js";
import type {
  IrIntrinsicBackendComposite,
  IrIntrinsicBackendOp,
  IrIntrinsicBackendSequence,
} from "../../core/nodes.js";
import type { IntrinsicSignature, IntrinsicUse, RuntimeFeature as IntrinsicRuntimeFeature } from "./intrinsics.js";

export type RuntimeFeature =
  | IntrinsicRuntimeFeature
  | AsyncRuntimeFeature
  | GeneratorNumberBoxRuntimeFeature
  | StringCompareRuntimeFeature
  | StringEqRuntimeFeature
  | StringLenRuntimeFeature
  | StringConcatRuntimeFeature
  | StringCharCodeAtRuntimeFeature
  | StringConcatManyRuntimeFeature
  | StringConstRuntimeFeature
  | HostCallbackWrapRuntimeFeature
  | FunctionPrototypeCallRuntimeFeature
  | ReferenceErrorRuntimeFeature;

export type HostCapabilityId = RuntimeHostCapabilityId;

export const RUNTIME_BACKEND_REQUIREMENTS = Object.freeze([
  "async.native.drive",
  "async.native.number-boundary",
  "async.native.undefined",
] as const);

export type RuntimeBackendRequirement = (typeof RUNTIME_BACKEND_REQUIREMENTS)[number];

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

/**
 * (#3526 F2-S4) The string length seam's requirement.
 *
 * `string.len` is an IR instruction like `string.eq`, and like it resolves
 * through no `intrinsic`, so the demand is requested at freeze from a
 * `string.len` instruction scan. Unlike either family-2 predecessor it is not a
 * callable symbol at all on the native side — nothing in the resolve table
 * names it — so the physical choice lives entirely on the instruction's
 * attached provider. The feature exists so the frozen manifest, not a
 * `ctx.nativeStrings` read inside the attachment pass, is the authority.
 */
export const STRING_LEN_RUNTIME_FEATURES = Object.freeze(["js.string.len"] as const);

export type StringLenRuntimeFeature = (typeof STRING_LEN_RUNTIME_FEATURES)[number];

/** (#3526 F2-S4) One provider per admitted string-length policy arm. */
export const STRING_LEN_RUNTIME_PROVIDER_IDS = Object.freeze(["host.js.string.len", "native.js.string.len"] as const);

export type StringLenRuntimeProviderId = (typeof STRING_LEN_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F2-S5) The string concatenation seam's requirements — the first seam
 * in the catalogue with TWO features, one per concat MODE.
 *
 * `string.concat` is an IR instruction like `string.eq` and `string.len`, and
 * like them it resolves through no `intrinsic`, so the demand is requested at
 * freeze from a `string.concat` instruction scan. What is new is that the
 * instruction carries a `concatMode`, and the producer already maps that mode
 * onto one of two callable symbols (`__ir_string_concat` /
 * `__ir_string_concat_owned`). The two features mirror that mapping exactly, so
 * the frozen manifest can say which of the two helpers a module actually needs
 * instead of pretending every concatenating module needs both.
 */
export const STRING_CONCAT_RUNTIME_FEATURES = Object.freeze(["js.string.concat", "js.string.concat.owned"] as const);

export type StringConcatRuntimeFeature = (typeof STRING_CONCAT_RUNTIME_FEATURES)[number];

/** (#3526 F2-S5) One provider per admitted arm — two authorities × two modes. */
export const STRING_CONCAT_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.string.concat",
  "host.js.string.concat.owned",
  "native.js.string.concat",
  "native.js.string.concat.owned",
] as const);

export type StringConcatRuntimeProviderId = (typeof STRING_CONCAT_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F2-S7) The guarded `charCodeAt` seam's requirement — ONE feature.
 *
 * Unlike its four family-2 predecessors this seam has TWO producers: an
 * `intrinsic` `call` whose plan-time symbol already names the lane
 * (`__jsstr_charCodeAt` / `__str_charCodeAt`) and a `string.char_code_at`
 * instruction minted only with receiver-encoding evidence. Neither is an
 * `intrinsic` INSTRUCTION, so the demand is requested at freeze from a scan
 * that counts both — an instr-only scan would freeze a row for the handful of
 * instruction cells and leave every plan-path cell with nothing to verify
 * against.
 */
export const STRING_CHAR_CODE_AT_RUNTIME_FEATURES = Object.freeze(["js.string.char_code_at"] as const);

export type StringCharCodeAtRuntimeFeature = (typeof STRING_CHAR_CODE_AT_RUNTIME_FEATURES)[number];

/** (#3526 F2-S7) One provider per admitted charCodeAt policy arm. */
export const STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.string.char_code_at",
  "native.js.string.char_code_at",
] as const);

export type StringCharCodeAtRuntimeProviderId = (typeof STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F2-S6) The BATCHED many-arity seam's requirement — ONE feature for an
 * unbounded family of arities.
 *
 * One feature and not one per arity, because the arity is a property of the
 * individual CALL, not of the crossing: the host record derives its field from
 * the arity and the native row's range bounds it, so a module that fuses a
 * 3-leaf and a 7-leaf tree needs the same authority twice, not two authorities.
 * The frozen manifest still records WHICH arities were demanded, through the
 * demand scan that requests this feature.
 */
export const STRING_CONCAT_MANY_RUNTIME_FEATURES = Object.freeze(["js.string.concat.many"] as const);

export type StringConcatManyRuntimeFeature = (typeof STRING_CONCAT_MANY_RUNTIME_FEATURES)[number];

/** (#3526 F2-S6) One provider per admitted authority; the arity is not a row axis. */
export const STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.string.concat.many",
  "native.js.string.concat.many",
] as const);

export type StringConcatManyRuntimeProviderId = (typeof STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS)[number];

/**
 * The native helper family's inclusive arity range — the ONE place it is
 * written. `src/codegen/native-batched-concat.ts` imports it (that file mints
 * `__str_concat_<arity>` and used to own the bound), and the pass's ceiling is
 * derived from it by {@link stringConcatManyArityCap}. The `joinNine` fence in
 * `tests/issue-4566-standalone-algorithms-module-init.test.ts` is what pins the
 * upper bound behaviourally.
 */
export const STRING_CONCAT_MANY_NATIVE_ARITY = Object.freeze({ min: 3, max: 8 } as const);

/**
 * (#3526 F2-S8) The string LITERAL STORAGE seam's requirements — TWO features,
 * one per import NAMESPACE, not one per authority.
 *
 * `js.string.const` is the surrogate-free literal (`string_constants."hello"`,
 * field = the literal text); `js.string.const.utf16` is the lone-surrogate
 * literal (#2880), which cannot be its own import field name and is keyed by
 * the hex of its UTF-16 code units in `string_constants16`.
 *
 * Two features rather than one host row requesting both capabilities, because
 * the frozen manifest's `hostCapabilityRecords` is a claim about what the
 * module imports: a surrogate-free module freezes only `js.string.const` and
 * names exactly the one namespace it needs. One row asking for both would make
 * every host module claim `string_constants16`. The utf16 split stays a
 * per-literal DERIVATION inside the host arm — requested as a feature, never
 * offered as an ARM — exactly as F2-S5 keeps `owned-append` a row fact.
 */
export const STRING_CONST_RUNTIME_FEATURES = Object.freeze(["js.string.const", "js.string.const.utf16"] as const);

export type StringConstRuntimeFeature = (typeof STRING_CONST_RUNTIME_FEATURES)[number];

/** (#3526 F2-S8) One provider per admitted arm — two authorities × two namespaces. */
export const STRING_CONST_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.js.string.const",
  "host.js.string.const.utf16",
  "native.js.string.const",
  "native.js.string.const.utf16",
] as const);

export type StringConstRuntimeProviderId = (typeof STRING_CONST_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F3-S1) Family 3's first feature. Like every family-2 sibling it
 * carries no intrinsic instruction — the crossing is a `call` on the host lane
 * and NOTHING at all on the exact standalone-DOM one — so the demand arrives
 * through `requestFeature` off the `closure.new` population rather than off an
 * instruction the manifest could resolve a provider for.
 */
export const HOST_CALLBACK_WRAP_RUNTIME_FEATURES = Object.freeze(["js.callback.wrap"] as const);

export type HostCallbackWrapRuntimeFeature = (typeof HOST_CALLBACK_WRAP_RUNTIME_FEATURES)[number];

/** (#3526 F3-S1) One provider per admitted host-callback-wrap policy arm. */
export const HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.callback.wrap",
  "native.callback.dispatch",
] as const);

export type HostCallbackWrapRuntimeProviderId = (typeof HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS)[number];

/**
 * (#3526 F3-S3) The `%Function.prototype%` call seam's requirement.
 *
 * Like the generator boxing and callback-maker features this family carries NO
 * intrinsic instruction — from-ast emits a plain zero-arg `call` through the
 * `__function_prototype_call` runtime symbol — so the demand is requested at
 * manifest freeze from a scan of the built functions rather than arriving as an
 * `IntrinsicUse`.
 */
export const FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES = Object.freeze(["js.function.prototype.call"] as const);

export type FunctionPrototypeCallRuntimeFeature = (typeof FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES)[number];

/**
 * (#3526 F3-S3) ONE provider id: the seam has a single admitting arm, so there
 * is no host sibling to select between.
 */
export const FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS = Object.freeze([
  "native.js.function.prototype.call",
] as const);

export type FunctionPrototypeCallRuntimeProviderId = (typeof FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS)[number];

export const REFERENCE_ERROR_RUNTIME_FEATURES = Object.freeze(["error.reference.construct"] as const);

export type ReferenceErrorRuntimeFeature = (typeof REFERENCE_ERROR_RUNTIME_FEATURES)[number];

export const REFERENCE_ERROR_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.error.reference.construct",
  "native.error.reference.construct",
] as const);

export type ReferenceErrorRuntimeProviderId = (typeof REFERENCE_ERROR_RUNTIME_PROVIDER_IDS)[number];

export type RuntimeProviderId =
  | MathRuntimeProviderId
  | NumericCoercionRuntimeProviderId
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
  | FunctionPrototypeCallRuntimeProviderId
  | ReferenceErrorRuntimeProviderId
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
      /**
       * (#3526 F2-S6) A synchronous callable answered by one host capability
       * FAMILY — a set of imports differing only in arity, whose physical
       * field the capability record derives from the operand count.
       *
       * Typed on the FAMILY half of the capability id union, so a plain func
       * id here is a compile error and a family id in `host-callable` is one
       * too. Deliberately NOT admitted into
       * {@link IntrinsicRuntimeProviderImplementation}: a family row answers a
       * free-form intrinsic SYMBOL, never a closed `IntrinsicId`, so nothing
       * may map it to a concrete import through the attachment path.
       */
      readonly kind: "host-callable-family";
      readonly capability: RuntimeHostCapabilityFuncFamilyId;
    }
  | {
      /**
       * (#3526 F2-S6) The native twin of the family arm: a set of runtime
       * symbols `symbolPrefix + arity`, bounded by an inclusive arity range.
       *
       * The range is the SINGLE authority for the native helper family's
       * bound — `src/codegen/native-batched-concat.ts` reads it from here
       * rather than keeping its own copy, and the pass's arity ceiling is
       * derived from it rather than being a third copy of the literal.
       */
      readonly kind: "runtime-callable-family";
      readonly symbolPrefix: string;
      readonly arity: { readonly min: number; readonly max: number };
    }
  | {
      /**
       * (#3526 F2-S4) A field read on a Program-ABI support carrier — the
       * first native arm in the catalogue that is not a callable at all.
       *
       * Deliberately SYMBOLIC: the manifest names the ABI *role* (`"string"`)
       * and the field index, and the consumer resolves the role to the
       * registry's carrier type ref at attachment time. It never carries a raw
       * physical type index, because the manifest is frozen BEFORE the carrier's
       * physical layout is planned — a type index in a frozen manifest would be
       * a lie the next lane has to discover.
       */
      readonly kind: "carrier-field";
      readonly carrier: "string";
      readonly fieldIndex: number;
    }
  | {
      /**
       * (#3526 F2-S8) A VALUE answered by one exact central host capability of
       * GLOBAL kind — the catalogue's first non-callable host arm.
       *
       * Typed on the GLOBAL half of the capability id union, the mirror of
       * `host-callable`'s func narrowing: naming a callable capability here is
       * a compile error, and `#indexProviders` carries the runtime twin. The
       * record names the import MODULE and the field SCHEME that derives each
       * literal's field; it can never name a field, because there is one field
       * per literal and the manifest freezes before the literals are known.
       */
      readonly kind: "host-global";
      readonly capability: RuntimeHostCapabilityGlobalId;
    }
  | {
      /**
       * (#3526 F2-S8) The native twin: a VALUE answered by a Program-ABI global
       * ROLE, with no import at all.
       *
       * Symbolic in the same way {@link RuntimeProviderImplementation}'s
       * `carrier-field` arm is: the manifest names the ABI role, and the
       * consumer resolves it to the concrete global at attachment time. It can
       * never carry an index — the manifest is frozen BEFORE
       * `internNativeStringLiteral` allocates one.
       */
      readonly kind: "native-global";
      readonly role: "native-string-literal";
    }
  | {
      /**
       * (#3526 F3-S1) A boundary crossing answered by a module-owned DISPATCHER
       * with no import and no call — the catalogue's first arm that is neither
       * a value nor a callable, but the licence for an emission that does not
       * happen.
       *
       * Deliberately its OWN kind rather than a new `native-managed.service`
       * value, and the reason is measured, not stylistic:
       * `projectRuntimeBackendRequirements` treats EVERY `native-managed` row
       * as a member of the native ASYNC family — it adds `async.native.drive`
       * and `async.native.number-boundary` to the frozen
       * `backendRequirements`, and it throws
       * `invalid-backend-requirement-projection` the moment such a row shares a
       * manifest with a host async provider. A callback row is neither, so
       * riding on that kind would have changed the frozen vector (and thus the
       * async adapter materialization) on exactly the lane this slice must keep
       * byte-identical. This kind is invisible to that projection, the way
       * F2-S8's `native-global` is.
       *
       * Symbolic like `native-global`: it names the dispatcher's ROLE, never a
       * function index — the manifest freezes before
       * `reserveStandaloneDomCallbackDispatch` allocates one.
       */
      readonly kind: "native-dispatch";
      readonly service: "standalone-dom-callback-dispatch";
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
