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
  isRuntimeHostCapabilityExportId,
  isRuntimeHostCapabilityFuncFamilyId,
  isRuntimeHostCapabilityFuncId,
  isRuntimeHostCapabilityGlobalId,
  resolveRuntimeHostCapabilityFuncFamilyRecord,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_IDS,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityFuncFamilyId,
  type RuntimeHostCapabilityFuncId,
  type RuntimeHostCapabilityGlobalId,
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

export type RuntimeTarget = "host" | "strict-no-host" | "standalone" | "wasi";
export type RuntimeBackend = "wasmgc" | "linear";
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
  | FunctionPrototypeCallRuntimeFeature;
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

/**
 * (#3526 F2-S4) The exact, already-resolved policy for the STRING LENGTH seam
 * (`s.length`) — family 2's third sibling, beside {@link StringComparePolicy}
 * and {@link StringEqPolicy}.
 *
 * Same one-flag truth table as both (`nativeStrings ? native : host`, because
 * `standalone` and `wasi` each imply `nativeStrings`), but the physical pair is
 * a THIRD shape again and the first that is not a callable pair at all: the
 * host arm is the `wasm:js-string.length` builtin import, while the native arm
 * is a plain field read on the Program-ABI string carrier. That is why this
 * seam needs the `carrier-field` implementation kind — the manifest's first
 * non-callable native arm — and why it could not ride along with the eq.
 */
export interface StringLenPolicy {
  /**
   * `host` selects the `wasm:js-string.length` builtin import through the
   * central `string.len` capability; `native` selects field 0 of the
   * Program-ABI string carrier (the UTF-16 code-unit count).
   */
  readonly len: "host" | "native" | "unsupported";
}

/** Adapters that expose no string length seam resolve the arm to this. */
export const STRING_LEN_POLICY_DISABLED: StringLenPolicy = Object.freeze({
  len: "unsupported",
});

/**
 * (#3526 F2-S5) The exact, already-resolved policy for the STRING
 * CONCATENATION seam (`a + b` on two strings, and the `+=` builder append) —
 * family 2's fourth sibling, beside {@link StringComparePolicy},
 * {@link StringEqPolicy} and {@link StringLenPolicy}.
 *
 * Same one-flag truth table as all three (`nativeStrings ? native : host`), but
 * this is the first seam in the catalogue where ONE policy answers TWO
 * features. The manifest decides WHICH authority answers; the concat MODE —
 * immutable `a + b` versus the `owned-append` builder-loop license (#3744) —
 * decides WHICH helper on that authority. The host lane has no owned import at
 * all and collapses both modes onto the same `wasm:js-string.concat` builtin;
 * that collapse is a provider-ROW fact, not a policy fact, which is why it is
 * modelled as two features under one policy rather than a second policy field.
 * A module with no builder loop then requests no owned provider at all, and its
 * frozen manifest says so.
 */
export interface StringConcatPolicy {
  /**
   * `host` selects the `wasm:js-string.concat` builtin import through the
   * central `string.concat` capability, for BOTH modes; `native` selects the
   * `__str_concat` / `__str_concat_owned` Wasm helpers
   * `ensureNativeStringHelpers` registers as one pair.
   */
  readonly concat: "host" | "native" | "unsupported";
}

/** Adapters that expose no string concatenation seam resolve the arm to this. */
export const STRING_CONCAT_POLICY_DISABLED: StringConcatPolicy = Object.freeze({
  concat: "unsupported",
});

/**
 * (#3526 F2-S7) The exact, already-resolved policy for the guarded
 * `s.charCodeAt(i)` READ — family 2's fifth sibling, beside
 * {@link StringComparePolicy}, {@link StringEqPolicy}, {@link StringLenPolicy}
 * and {@link StringConcatPolicy}.
 *
 * Same one-flag truth table as all four (`nativeStrings ? native : host`), and
 * it governs exactly ONE feature: the GUARDED read, `(string, i32) -> f64` with
 * `NaN` out of range. The proof-licensed arms the census also found — the
 * trusted host read and the native `__str_flatten` + `__str_flat_charCodeAt`
 * preheader PAIR — are a different feature whose decision is taken at PLAN
 * time, and are deliberately NOT folded in here: a policy field that could not
 * be honoured at resolve would be a lie about where the authority lives.
 */
export interface StringCharCodeAtPolicy {
  /**
   * `host` selects `__jsstr_charCodeAt`, the defined helper that closes over
   * the `string.char_code_at` and `string.len` builtin capabilities; `native`
   * selects `__str_charCodeAt`, the host-free helper over the Program-ABI
   * string carrier. Both answer the same guarded f64.
   */
  readonly charCodeAt: "host" | "native" | "unsupported";
}

/** Adapters that expose no charCodeAt seam resolve the arm to this. */
export const STRING_CHAR_CODE_AT_POLICY_DISABLED: StringCharCodeAtPolicy = Object.freeze({
  charCodeAt: "unsupported",
});

/**
 * (#3526 F2-S6) The exact, already-resolved policy for the BATCHED many-arity
 * concatenation seam — the `batchStringConcat` pass and the two resolve arms
 * that lower what it fuses.
 *
 * A policy of its own, distinct from {@link StringConcatPolicy}, because the
 * truth tables differ by lane and the census measured the difference: the
 * NATIVE helpers exist on `gc-native-strings` and on `wasi` (the legacy twin
 * mints `__str_concat_N` there) yet the IR pass never batches on either, and
 * `gc-strict` has no authority at all. `batch` therefore answers "does the
 * pass run, and against which arity ceiling", which is a strictly narrower
 * question than "which authority answers a concatenation".
 *
 * The projection keeps the wasi term because it is LIVE, not redundant:
 * `nativeStrings: false` is an accepted override on target wasi, and such a
 * module compiles on the host string backend — only the wasi term keeps the
 * pass off there (measured: CAT3 wasi/host-strings, 1000 bytes, pairwise
 * `wasm:js-string.concat`, no `__concat_`).
 *
 * It describes the IR PIPELINE, not the module. `batch: "off"` on wasi is true
 * of the pass and says nothing about the legacy twins, which still mint
 * `__concat_N` / `__str_concat_N` on demoted functions.
 */
export interface StringConcatManyPolicy {
  /**
   * `host` runs the pass with no arity ceiling and lowers each fused root to
   * `env.__concat_<arity>`; `native` runs it against the native helper family's
   * ceiling and lowers to `__str_concat_<arity>`; `off` does not run it.
   */
  readonly batch: "host" | "native" | "off";
}

/** Adapters that run no batching pass resolve the arm to this. */
export const STRING_CONCAT_MANY_POLICY_DISABLED: StringConcatManyPolicy = Object.freeze({
  batch: "off",
});

/**
 * (#3526 F2-S8) The exact, already-resolved policy for the STRING LITERAL
 * STORAGE seam (`string.const`) — family 2's last policy, and the only one in
 * the catalogue whose arms are VALUES rather than callables.
 *
 * Same one-flag truth table as its five siblings (`nativeStrings ? native :
 * host`), and the same reason: `standalone` and `wasi` both imply
 * `nativeStrings`. What differs is what the decision buys.
 *
 * **It governs the LABEL, not the mint.** On the host lane the physical global
 * a literal binds to is minted by the legacy import collector's finalize pass,
 * not by the IR seam — measured at the census grounding, 38 of 39 host
 * `string_constants` mints came from there and the IR pre-registration was a
 * no-op on every required fixture. What the frozen row decides is which
 * `IrGlobalRef` the instruction CARRIES: an imported `string_constants` /
 * `string_constants16` global named by the host capability record, or the
 * interned `__strlit_N` Program-ABI global the native lanes materialize. It
 * decides neither mint time nor import order, and this slice moves neither.
 */
export interface StringConstPolicy {
  /**
   * `host` binds each literal to its imported global through the
   * `string.const` / `string.const.utf16` capability records; `native` binds it
   * to the interned Program-ABI `native-string-literal` global (or, for a
   * literal past the array-new-fixed ceiling, leaves the oversized
   * materializer to answer).
   */
  readonly storage: "host" | "native" | "unsupported";
}

/** Adapters that expose no string literal storage seam resolve the arm to this. */
export const STRING_CONST_POLICY_DISABLED: StringConstPolicy = Object.freeze({
  storage: "unsupported",
});

/**
 * (#3526 F3-S1) The exact, already-resolved HOST CALLBACK MAKER policy of one
 * preparation caller — family 3's first policy, and the first in the issue
 * whose two live arms are not two spellings of the same crossing but a
 * crossing and its ABSENCE.
 *
 * The seam is the maker for a checker-certified void host callback. On a
 * JS-host lane the packed closure crosses through the `env.__make_callback`
 * import named by the `async.callback.wrap` capability record, with the
 * compiler-owned one-shot sentinel in front of it. On the EXACT standalone-DOM
 * lane there is no maker at all: the reserved standalone DOM dispatcher owns
 * the crossing, and the packed closure is passed straight to the DOM import.
 * Everywhere else the selection gate (`calendar-selection-support.ts`) never
 * certifies the arrow, so no callback reaches the boundary and the seam is
 * `unsupported`.
 *
 * The policy therefore decides WHICH AUTHORITY answers the crossing, never how
 * it is spelled: the `-2` sentinel stays a from-ast fact, the closure
 * environment shape stays a plan-time fact, and this slice moves neither.
 */
export interface HostCallbackWrapPolicy {
  /**
   * `host` wraps the packed closure through the `async.callback.wrap`
   * capability record's import; `native-dispatch` admits the exact
   * standalone-DOM dispatcher, which wraps nothing and imports nothing.
   */
  readonly wrap: "host" | "native-dispatch" | "unsupported";
}

/** Adapters that expose no host callback boundary resolve the arm to this. */
export const HOST_CALLBACK_WRAP_POLICY_DISABLED: HostCallbackWrapPolicy = Object.freeze({
  wrap: "unsupported",
});

/**
 * (#3526 F3-S3) The exact, already-resolved `%Function.prototype%.[[Call]]`
 * policy of one preparation caller — family 3's second policy, and the first in
 * the whole issue with exactly ONE admitting arm.
 *
 * `%Function.prototype%` is a callable intrinsic object whose `[[Call]]`
 * discards every argument and returns `undefined` (ES5 §15.3.4). On a JS-host
 * lane the host object is real and answers the call itself, so there is no seam
 * to govern and no host arm to name: `call: "native"` — the compiler-owned
 * zero-parameter `__function_prototype_call` helper — is the only value that
 * admits anything. Everywhere else the seam is `unsupported`, and that is not a
 * refusal of live traffic: the selector's `standalone-function-prototype-call`
 * backend capability already declines the whole call shape on those lanes
 * (measured: `call-resolution-unsupported`@select on gc and wasi), so no
 * front-end arm ever asks.
 *
 * The policy therefore decides WHETHER the compiler owns the crossing, never
 * how the helper is spelled or emitted: `ensureFunctionPrototypeCallHelper`
 * stays the sole minter and `src/codegen/function-prototype-callable.ts` is
 * untouched, which is why the migration moves no bytes.
 */
export interface FunctionPrototypeCallPolicy {
  /**
   * `native` admits the compiler-owned `__function_prototype_call` helper as
   * the entry point. There is deliberately no `host` arm — see above.
   */
  readonly call: "native" | "unsupported";
}

/** Adapters that do not own the `%Function.prototype%` entry point resolve the arm to this. */
export const FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED: FunctionPrototypeCallPolicy = Object.freeze({
  call: "unsupported",
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
  /**
   * Omission resolves to {@link STRING_LEN_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly stringLen?: StringLenPolicy;
  /**
   * Omission resolves to {@link STRING_CONCAT_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly stringConcat?: StringConcatPolicy;
  /**
   * Omission resolves to {@link STRING_CHAR_CODE_AT_POLICY_DISABLED}; the
   * frozen manifest always publishes the explicit resolved value.
   */
  readonly stringCharCodeAt?: StringCharCodeAtPolicy;
  /**
   * Omission resolves to {@link STRING_CONCAT_MANY_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly stringConcatMany?: StringConcatManyPolicy;
  /**
   * Omission resolves to {@link STRING_CONST_POLICY_DISABLED}; the frozen
   * manifest always publishes the explicit resolved value.
   */
  readonly stringConst?: StringConstPolicy;
  /**
   * (#3526 F3-S1) Omission resolves to {@link HOST_CALLBACK_WRAP_POLICY_DISABLED};
   * the frozen twin below always carries a concrete arm.
   */
  readonly hostCallbackWrap?: HostCallbackWrapPolicy;
  /**
   * (#3526 F3-S3) Omission resolves to {@link FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED};
   * the frozen twin below always carries a concrete arm.
   */
  readonly functionPrototypeCall?: FunctionPrototypeCallPolicy;
}

/** The frozen manifest's policy always carries an explicit resolved decision. */
export type FrozenRuntimeManifestPolicy = RuntimeManifestPolicy & {
  readonly numberBoundary: NumberBoundaryPolicy;
  readonly booleanBoundary: BooleanBoundaryPolicy;
  readonly externIsUndefined: ExternIsUndefinedPolicy;
  readonly generatorNumberBox: GeneratorNumberBoxPolicy;
  readonly stringCompare: StringComparePolicy;
  readonly stringEq: StringEqPolicy;
  readonly stringLen: StringLenPolicy;
  readonly stringConcat: StringConcatPolicy;
  readonly stringCharCodeAt: StringCharCodeAtPolicy;
  readonly stringConcatMany: StringConcatManyPolicy;
  readonly stringConst: StringConstPolicy;
  readonly hostCallbackWrap: HostCallbackWrapPolicy;
  readonly functionPrototypeCall: FunctionPrototypeCallPolicy;
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
 * (#3526 F3-S3) Family 3's second feature. Like its F3-S1 sibling it carries no
 * intrinsic instruction: the crossing is a plain `call` to a compiler-owned
 * helper, so the demand arrives through `requestFeature` off the emitted-call
 * population rather than off an instruction the manifest could resolve.
 */
export const FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES = Object.freeze(["js.function.prototype.call"] as const);
export type FunctionPrototypeCallRuntimeFeature = (typeof FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES)[number];

/**
 * (#3526 F3-S3) ONE provider — the only admitting arm the seam has. A JS-host
 * lane needs no row because the real host `%Function.prototype%` answers there.
 */
export const FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS = Object.freeze([
  "native.js.function.prototype.call",
] as const);
export type FunctionPrototypeCallRuntimeProviderId = (typeof FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS)[number];

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
  // (#3526 F3-S3) `%Function.prototype%.[[Call]]` ignores every argument, so
  // the helper is zero-parameter and returns the `undefined` externref.
  "js.function.prototype.call": EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
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
 * (#3526 F3-S3) The `%Function.prototype%.[[Call]]` entry point's single arm.
 *
 * The symbol is spelled here rather than imported from
 * `src/codegen/function-prototype-callable.ts` because `src/ir/` may not import
 * `src/codegen/` (the `check:ir-layering` gate) — the same reason
 * `GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS` spells `__box_number`. The helper
 * itself is still minted by exactly one function
 * (`ensureFunctionPrototypeCallHelper`), so the row NAMES the entry point and
 * introduces no second registration path, no import and no new spelling — which
 * is why the migration is byte-neutral on every lane.
 */
export const FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  numberBoundaryProvider(
    "native.js.function.prototype.call",
    "js.function.prototype.call",
    EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
    { kind: "runtime-callable", symbol: "__function_prototype_call" },
    [],
  ),
]);

/** The exact provider the admitted `%Function.prototype%` arm selects, or
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
                              // first in the issue with exactly ONE admitting
                              // arm: `native` names the compiler-owned
                              // `%Function.prototype%` entry point, and there is
                              // no host arm because a JS-host lane's real
                              // `Function.prototype` answers the call itself.
                              // The refusal names `function-prototype-call` so
                              // an operator can tell WHICH callable seam a
                              // disabled adapter refused.
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
