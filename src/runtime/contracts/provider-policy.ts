// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export type RuntimeTarget = "host" | "strict-no-host" | "standalone" | "wasi";

export type RuntimeBackend = "wasmgc" | "linear";

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
 * (#3526 F3-S3) The exact, already-resolved policy for the ES5
 * `%Function.prototype%` CALL seam — family 3's second policy, and a sibling of
 * {@link HostCallbackWrapPolicy}, never a widening of it.
 *
 * The seam is `Function.prototype(...)` where `Function` is the ambient
 * intrinsic (ES5 §15.3.4): a callable intrinsic object whose `[[Call]]`
 * evaluates and discards its arguments and returns `undefined`. The front-end
 * lowers it to a plain zero-arg `call` through the `__function_prototype_call`
 * runtime helper.
 *
 * There is deliberately NO host arm. On a JS-host lane `%Function.prototype%`
 * is a real host object reached through ordinary member access, so the crossing
 * this policy governs does not exist there — `native` is the only admitting
 * value, and its absence is `unsupported` rather than a second spelling. That
 * asymmetry is the same shape `booleanBoundary` takes (one arm, no sibling to
 * select), not a narrowing of the maker policy above.
 *
 * The truth table is the resolver arm's own, unchanged: `native` exactly when
 * the lane is standalone and not WASI. It is deliberately NOT the wider
 * `ctx.standalone || ctx.wasi` table that `ensureFunctionPrototypeCallHelper`
 * uses to MINT the helper — minting is the legacy direct-AST path's business on
 * the WASI lane, and reading helper presence as support is the exact inference
 * F1-S1 refused. It is also not the selector's
 * `standalone-function-prototype-call` backend capability, which answers a
 * different question (may Phase 1 select this shape at all) one stage earlier.
 */
export interface FunctionPrototypeCallPolicy {
  /**
   * `native` selects the `__function_prototype_call` runtime helper; there is
   * no host arm, so every other lane resolves to `unsupported`.
   */
  readonly call: "native" | "unsupported";
}

/** Adapters on which `%Function.prototype%` is not a native callable. */
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
