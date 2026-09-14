// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#3526 F2-S2) The two id tuples are the CLOSED source of truth for which
 * kind a capability is. `RuntimeHostCapabilityId` is their union, so a
 * `host-callable` provider row can be typed on the func half alone and a
 * global id in that position is a compile error rather than a runtime
 * surprise.
 */
export const RUNTIME_HOST_CAPABILITY_FUNC_IDS = Object.freeze([
  "async.callback.wrap",
  "async.exception.caught",
  "async.promise.capability.create",
  "async.promise.react",
  "async.promise.resolve",
  "async.promise.settle.fulfill",
  "async.promise.settle.reject",
  "async.value.undefined",
  "boolean.box",
  "callable.host_call.array",
  "callback.wrap.ctor",
  "callback.wrap.getter",
  "error.reference.construct",
  "extern.is_undefined",
  "number.box",
  "number.unbox",
  "string.char_code_at",
  "string.compare",
  "string.concat",
  "string.eq",
  "string.len",
] as const);

/**
 * (#3526 F2-S6) The FAMILY half of the func side: one id standing for an
 * unbounded SET of physical imports that differ only in arity.
 *
 * `env.__concat_3` … `env.__concat_9` (and, on the host lane, any N — the JS
 * provider matches by prefix) are one semantic crossing whose field name is
 * DERIVED from the operand count, so a closed catalogue cannot enumerate them
 * any more than it could enumerate `string_constants.<literal>`. The record
 * therefore fixes the derivation rule, not a name.
 *
 * This is a THIRD list rather than a member of
 * {@link RUNTIME_HOST_CAPABILITY_FUNC_IDS}, and that separation is the whole
 * point: a family id in the func list would make `RuntimeHostCapabilityFuncId`
 * admit it, so a plain `host-callable { capability: "string.concat.many" }`
 * would type-check and be caught only by the runtime throw in
 * {@link asCallableRuntimeHostCapabilityRecord} at module init — exactly the
 * typed-half hole F2-S2 closed for globals. With the third list the family id
 * is spellable only where a family is expected.
 */
export const RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS = Object.freeze([
  "callable.boundary_callback.call",
  "callable.host_call.fixed",
  "string.concat.many",
] as const);

export const RUNTIME_HOST_CAPABILITY_GLOBAL_IDS = Object.freeze(["string.const", "string.const.utf16"] as const);

/**
 * (#3526 F3-S2) The EXPORT half — the first ids whose direction is host→module.
 *
 * Every id above names something this module CALLS or READS. These name what
 * the module PUBLISHES for the host to call: the direct closure dispatchers
 * `__call_fn_0..4` and the arity probe `__closure_arity`. Direction is carried
 * by the kind, which is why an export record has no `module` key at all — an
 * export has no import namespace, and giving it one would invite a lane to
 * resolve it as an import.
 *
 * ENUMERATED rather than schematised, unlike the family half. The F2-S2/F2-S6
 * criterion is closedness: string-literal fields and `__concat_N` are unbounded
 * so they got schemes, but the direct dispatchers are bounded at 0..4
 * (`directClosureHostBridgeOrdinal`, `closure-exports.ts:352-353`, and the
 * `/^__call_fn_([0-4])$/` alias regex at `:101`), so they can be spelled.
 */
export const RUNTIME_HOST_CAPABILITY_EXPORT_IDS = Object.freeze([
  "callable.export.arity",
  "callable.export.call_fn.0",
  "callable.export.call_fn.1",
  "callable.export.call_fn.2",
  "callable.export.call_fn.3",
  "callable.export.call_fn.4",
] as const);

export type RuntimeHostCapabilityFuncId = (typeof RUNTIME_HOST_CAPABILITY_FUNC_IDS)[number];

export type RuntimeHostCapabilityFuncFamilyId = (typeof RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS)[number];

export type RuntimeHostCapabilityGlobalId = (typeof RUNTIME_HOST_CAPABILITY_GLOBAL_IDS)[number];

export type RuntimeHostCapabilityExportId = (typeof RUNTIME_HOST_CAPABILITY_EXPORT_IDS)[number];

export type RuntimeHostCapabilityId =
  | RuntimeHostCapabilityFuncId
  | RuntimeHostCapabilityFuncFamilyId
  | RuntimeHostCapabilityGlobalId
  | RuntimeHostCapabilityExportId;

/** Every id, sorted — the completeness axis the catalogue is checked against. */
export const RUNTIME_HOST_CAPABILITY_IDS: readonly RuntimeHostCapabilityId[] = Object.freeze(
  [
    ...RUNTIME_HOST_CAPABILITY_FUNC_IDS,
    ...RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS,
    ...RUNTIME_HOST_CAPABILITY_GLOBAL_IDS,
    ...RUNTIME_HOST_CAPABILITY_EXPORT_IDS,
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
);

/**
 * Value types an R6 host capability may carry. `f64` was added by F1-S1 for
 * the number boundary; `ref_extern` by F2-S2, because `wasm:js-string.concat`
 * returns `(ref extern)` and not `externref` (`registry/imports.ts`
 * `addStringImports`). The async projection stays on `externref | i32`.
 */
export type RuntimeHostCapabilityValueType = "externref" | "i32" | "f64" | "ref_extern";

/**
 * (#3526 F2-S2) Closed module namespaces, per kind. Keeping them on the kind
 * arm is what makes `env.<global>` and `wasm:js-string.<global>` — and
 * `string_constants.<func>` — unrepresentable rather than merely unused.
 */
export const RUNTIME_HOST_CAPABILITY_FUNC_MODULES = Object.freeze(["env", "wasm:js-string"] as const);

export const RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES = Object.freeze([
  "string_constants",
  "string_constants16",
] as const);

export type RuntimeHostCapabilityFuncModule = (typeof RUNTIME_HOST_CAPABILITY_FUNC_MODULES)[number];

export type RuntimeHostCapabilityGlobalModule = (typeof RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES)[number];

export const RUNTIME_HOST_CAPABILITY_KINDS = Object.freeze(["export", "func", "func-family", "global"] as const);

export type RuntimeHostCapabilityKind = (typeof RUNTIME_HOST_CAPABILITY_KINDS)[number];

/**
 * (#3526 F2-S2) How a global capability's import FIELD is derived from the
 * literal it carries — not a field name, because the field IS the literal.
 *
 *  * `literal` — the surrogate-free case: `string_constants."f"`, `""`, `"ab"`.
 *  * `literal-utf16-hex` — the lone-surrogate case (#2880): a literal that is
 *    not valid UTF-8 cannot be its own field name, so `string_constants16` is
 *    keyed by `hexCodeUnits(value)` (ASCII).
 */
export const RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES = Object.freeze(["literal", "literal-utf16-hex"] as const);

export type RuntimeHostCapabilityFieldScheme = (typeof RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES)[number];

export interface RuntimeHostCapabilityGlobalField {
  readonly scheme: RuntimeHostCapabilityFieldScheme;
}

/**
 * (#3526 F2-S6) How a func FAMILY's import field is derived from the arity.
 *
 * `arity-suffix` — the field is `prefix + arity`: `env.__concat_3`,
 * `env.__concat_9`. Deliberately its OWN list rather than a member of
 * {@link RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES}: a global's schemes derive a
 * field from a string LITERAL, a family's from a NUMBER, and nothing may read
 * one where the other is meant.
 */
export const RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEMES = Object.freeze(["arity-suffix"] as const);

export type RuntimeHostCapabilityFuncFamilyFieldScheme =
  (typeof RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEMES)[number];

/**
 * (#3526 F3-S2) Why an export NAME may be absent from a module that otherwise
 * contains the capability.
 *
 * `host-bridge-gated` — the whole closure host bridge is published only when
 * `ctx.emitHostBridge` is true (`create-context.ts:189`,
 * `emitHostBridge: targetProfile.hostValueInterop !== "off"`), and
 * `stripHostBridgeExports` (`host-bridge-exports.ts:118`) removes the set
 * otherwise. Measured (P2, `.tmp/f3s2-plan/p2-strip.md`): on `standalone` and
 * `wasi` all six names and all six `$c*` aliases are absent, on gc-host and
 * gc-strict-no-host they are present. ONE member because the measurement found
 * exactly one gate; a second arm must be declared from a measurement, not
 * anticipated.
 */
export const RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATIONS = Object.freeze(["host-bridge-gated"] as const);

export type RuntimeHostCapabilityExportPublication = (typeof RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATIONS)[number];

/**
 * (#3526 F3-S2) The one environment variable that picks between two sibling
 * spellings of the same crossing, DECLARED rather than read.
 *
 * No record ever reads `process.env`. This axis only records WHICH condition
 * selects a row, so the `__call_function_N` / `__call_function` pair is a
 * declared sibling choice instead of a fact hidden inside `planHostCallFallback`.
 */
export const RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VARS = Object.freeze([
  "JS2WASM_FIXED_ARITY_HOST_CALLS",
] as const);

export type RuntimeHostCapabilityHostSelectionEnvVar = (typeof RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VARS)[number];

/**
 * The two conditions, mirroring `host-call-fallback.ts:20` EXACTLY:
 *
 * ```ts
 * nativeBoundary || (process.env.JS2WASM_FIXED_ARITY_HOST_CALLS !== "0" && arity <= 4)
 * ```
 *
 * so the array ABI is selected when the knob is `"0"` **OR** the arity exceeds
 * the family's `max` — not on the knob alone. A two-member `"zero" | "not-zero"`
 * axis would therefore be a FALSE contract: measured (P3,
 * `.tmp/f3s2-plan/p3-family-abi.json`) the gc-host cell for CB7/12 imports
 * `env.__call_function` ALONGSIDE `__call_function_0..4` with the knob unset.
 */
export const RUNTIME_HOST_CAPABILITY_HOST_SELECTIONS = Object.freeze([
  "knob-not-zero-within-arity",
  "knob-zero-or-arity-above-max",
] as const);

export type RuntimeHostCapabilityHostSelectionCondition = (typeof RUNTIME_HOST_CAPABILITY_HOST_SELECTIONS)[number];

/** A declared selection axis: which env var, and which of its conditions picks this spelling. */
export interface RuntimeHostCapabilityHostSelection {
  readonly envVar: RuntimeHostCapabilityHostSelectionEnvVar;
  readonly selectsWhen: RuntimeHostCapabilityHostSelectionCondition;
}

export interface RuntimeHostCapabilityFuncFamilyField {
  readonly scheme: RuntimeHostCapabilityFuncFamilyFieldScheme;
  /** Literal prefix the arity is appended to; `__concat_` for the concat family. */
  readonly prefix: string;
}

/**
 * A family's parameter list as a SCHEME: `repeat` × arity, bounded by
 * `[min, max]`. `max: null` is unbounded — the measured host fact (the JS
 * provider matches `__concat_` by prefix and answers any N; the census
 * observed `__concat_9`).
 */
export interface RuntimeHostCapabilityFuncFamilyParams<
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> {
  readonly repeat: Value;
  readonly min: number;
  readonly max: number | null;
  /**
   * (#3526 F3-S2) The FIXED prefix ahead of the repeated tail, when the family
   * has one. `env.__call_function_3` takes five params — callee, this, and
   * three arguments — so `repeat × arity` alone cannot describe it.
   *
   * OPTIONAL, on the `exceptionPolicy?` precedent, so `string.concat.many`'s
   * frozen shape and its whole-shape pins do not move: a row that declares no
   * `leading` is byte-identical to a pre-F3-S2 one.
   */
  readonly leading?: readonly Value[];
}

/**
 * Exception policy at the host reaction boundary. A compiled throw crosses
 * that boundary as a WebAssembly.Exception carrying the original JS value in
 * this module's exception tag. The host Promise must observe that value, not
 * the Wasm carrier. Foreign tags and runtime traps are deliberately excluded.
 */
export const HOST_CALLBACK_EXCEPTION_POLICY = "module-tag-payload" as const;

export type HostCallbackExceptionPolicy = typeof HOST_CALLBACK_EXCEPTION_POLICY;

/** Exact concrete FUNC capability record selected by the frozen manifest. */
export interface RuntimeHostCapabilityFuncRecord<
  Id extends RuntimeHostCapabilityFuncId = RuntimeHostCapabilityFuncId,
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> {
  readonly capability: Id;
  readonly module: RuntimeHostCapabilityFuncModule;
  readonly field: string;
  readonly kind: "func";
  readonly params: readonly Value[];
  readonly results: readonly Value[];
  readonly exceptionPolicy?: HostCallbackExceptionPolicy;
  readonly hostSelection?: RuntimeHostCapabilityHostSelection;
}

/** Exact concrete GLOBAL capability record selected by the frozen manifest. */
export interface RuntimeHostCapabilityGlobalRecord<
  Id extends RuntimeHostCapabilityGlobalId = RuntimeHostCapabilityGlobalId,
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> {
  readonly capability: Id;
  readonly module: RuntimeHostCapabilityGlobalModule;
  readonly field: RuntimeHostCapabilityGlobalField;
  readonly kind: "global";
  readonly valueType: Value;
  readonly mutable: boolean;
}

/**
 * (#3526 F2-S6) Exact FAMILY capability record — a rule for deriving an
 * unbounded set of concrete func rows, not a concrete row itself.
 *
 * Deliberately a separate kind rather than a widening of
 * {@link RuntimeHostCapabilityFuncRecord}'s `field: string` /
 * `params: readonly Value[]`: widening those would make every existing
 * `resolveRuntimeHostCapabilityFuncRecord` consumer handle a scheme it can
 * never receive. {@link resolveRuntimeHostCapabilityFuncFamilyRecord} is the
 * one place a concrete row is synthesized, and it takes the arity.
 */
export interface RuntimeHostCapabilityFuncFamilyRecord<
  Id extends RuntimeHostCapabilityFuncFamilyId = RuntimeHostCapabilityFuncFamilyId,
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> {
  readonly capability: Id;
  readonly module: RuntimeHostCapabilityFuncModule;
  readonly field: RuntimeHostCapabilityFuncFamilyField;
  readonly kind: "func-family";
  readonly params: RuntimeHostCapabilityFuncFamilyParams<Value>;
  readonly results: readonly Value[];
  readonly hostSelection?: RuntimeHostCapabilityHostSelection;
}

/**
 * (#3526 F3-S2) Exact concrete EXPORT capability record — a name this module
 * PUBLISHES for the host to call, not one it imports.
 *
 * Deliberately has **no `module` key**, and the exact-key check enforces its
 * absence: an export has no import namespace, so a `module` slot would only
 * invite a consumer to resolve the row as an import. Direction is carried by
 * `kind` alone, which is why `asCallableRuntimeHostCapabilityRecord` refuses an
 * export record exactly as it refuses a global one.
 *
 * An export publishes TWO names. `publishClosureHostBridge`
 * (`closure-exports.ts:162-166`) emits the logical label AND the reserved
 * compact base `$c<bit36>` (`:156-172`), so the row carries both. It does NOT
 * carry the `$`-suffix collision walk, which depends on user exports observed
 * at emit time and is F3-S5's.
 */
export interface RuntimeHostCapabilityExportRecord<
  Id extends RuntimeHostCapabilityExportId = RuntimeHostCapabilityExportId,
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> {
  readonly capability: Id;
  /** The logical export label, e.g. `__call_fn_2`. */
  readonly name: string;
  /** The reserved compact alias base, e.g. `$c2`. */
  readonly alias: string;
  readonly kind: "export";
  readonly params: readonly Value[];
  readonly results: readonly Value[];
  readonly publication: RuntimeHostCapabilityExportPublication;
}

export type RuntimeHostCapabilityRecord<
  Id extends RuntimeHostCapabilityId = RuntimeHostCapabilityId,
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> =
  | RuntimeHostCapabilityFuncRecord<Extract<Id, RuntimeHostCapabilityFuncId>, Value>
  | RuntimeHostCapabilityFuncFamilyRecord<Extract<Id, RuntimeHostCapabilityFuncFamilyId>, Value>
  | RuntimeHostCapabilityGlobalRecord<Extract<Id, RuntimeHostCapabilityGlobalId>, Value>
  | RuntimeHostCapabilityExportRecord<Extract<Id, RuntimeHostCapabilityExportId>, Value>;

/**
 * (#3526 F2-S6) One CONCRETE row synthesized from a family record and an arity.
 *
 * Structurally the `module` / `field` / `params` / `results` a caller would
 * have gotten from a plain func record — deliberately NOT a
 * {@link RuntimeHostCapabilityFuncRecord}, because it is not a catalogue
 * object: `assertCanonicalRuntimeHostCapabilityRecord` would (correctly)
 * refuse it, and nothing may pass a synthesized row where a canonical one is
 * required.
 */
export interface ResolvedRuntimeHostCapabilityFuncFamilyRow<
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> {
  readonly module: RuntimeHostCapabilityFuncModule;
  readonly field: string;
  readonly params: readonly Value[];
  readonly results: readonly Value[];
}
