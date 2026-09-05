// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * The single closed authority for every R6 host-capability ABI record.
 *
 * Before #3526 F1-S1 the only capability records were async ones, so the
 * catalogue lived inside `async-runtime-providers.ts`. The number-boundary
 * family (`env.__box_number` / `env.__unbox_number`) is the first non-async
 * consumer, and R6 admits exactly ONE record table: a second table would let
 * two families disagree about the same import's ABI, which is the failure the
 * typed contract exists to prevent.
 *
 * `async-runtime-providers.ts` now derives its async-only projection from this
 * table and deliberately keeps its own NARROWED value-type union
 * (`externref | i32`). The async adapter materializer treats every non-`i32`
 * row as externref, so widening the async-facing union to include `f64` would
 * silently mislower a number record. The narrowing is load-bearing.
 *
 * (#3526 F1-S2) The boolean row is why that narrowing is not, on its own,
 * sufficient: `boolean.box` is `(i32) -> externref`, so every one of its value
 * types IS admissible under `AsyncHostAdapterValueType`. What keeps it out of
 * the async projection is the ID filter — `ASYNC_HOST_CAPABILITY_ID_SET`, the
 * seven `async.*` names — not the value union. Never replace that filter with
 * a value-type test.
 *
 * (#3526 F2-S2) The schema is now KIND-DISCRIMINATED. Family 2's remaining
 * host crossings do not all live in `env`, and two of them are not functions
 * at all:
 *
 *  * `wasm:js-string.{concat,equals,length,charCodeAt}` are func imports in a
 *    NON-`env` module namespace, which the pre-F2-S2 record type could not
 *    spell (`module` was the literal `"env"`).
 *  * string literals reach the host lane as GLOBAL imports whose import FIELD
 *    is the literal itself (`string_constants."f"`), or the hex of its UTF-16
 *    code units when it contains a lone surrogate
 *    (`string_constants16."d800"`). A closed catalogue cannot enumerate
 *    per-literal field names, so a global row carries a field SCHEME rather
 *    than a field name.
 *
 * This slice moves NO boundary: it only makes those crossings expressible.
 * No provider references the six new rows, so `freeze()` never selects them
 * and every frozen manifest, import and emitted body is byte-identical.
 */

/**
 * (#3526 F2-S2) The two id tuples are the CLOSED source of truth for which
 * kind a capability is. `RuntimeHostCapabilityId` is their union, so a
 * `host-callable` provider row can be typed on the func half alone and a
 * global id in that position is a compile error rather than a runtime
 * surprise.
 */
export const RUNTIME_HOST_CAPABILITY_FUNC_IDS = Object.freeze([
  "async.callback.wrap",
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

const RUNTIME_HOST_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_IDS);
const RUNTIME_HOST_CAPABILITY_FUNC_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_FUNC_IDS);
const RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_ID_SET: ReadonlySet<string> = new Set(
  RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS,
);
const RUNTIME_HOST_CAPABILITY_GLOBAL_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_GLOBAL_IDS);
const RUNTIME_HOST_CAPABILITY_EXPORT_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_EXPORT_IDS);

export function isRuntimeHostCapabilityId(value: string): value is RuntimeHostCapabilityId {
  return RUNTIME_HOST_CAPABILITY_ID_SET.has(value);
}

/** Runtime twin of the func half of the id union (the `host-callable` domain). */
export function isRuntimeHostCapabilityFuncId(value: string): value is RuntimeHostCapabilityFuncId {
  return RUNTIME_HOST_CAPABILITY_FUNC_ID_SET.has(value);
}

/** Runtime twin of the FAMILY half of the id union (the `host-callable-family` domain). */
export function isRuntimeHostCapabilityFuncFamilyId(value: string): value is RuntimeHostCapabilityFuncFamilyId {
  return RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_ID_SET.has(value);
}

/** Runtime twin of the global half of the id union. */
export function isRuntimeHostCapabilityGlobalId(value: string): value is RuntimeHostCapabilityGlobalId {
  return RUNTIME_HOST_CAPABILITY_GLOBAL_ID_SET.has(value);
}

/**
 * (#3526 F3-S2) Runtime twin of the EXPORT half. No provider domain answers to
 * it: {@link RuntimeManifestBuilder} refuses an export id in any provider's
 * `hostCapabilities`, so this predicate exists for catalogues arriving through
 * an `unknown` boundary, not for a `host-export` provider row (F3-S5's).
 */
export function isRuntimeHostCapabilityExportId(value: string): value is RuntimeHostCapabilityExportId {
  return RUNTIME_HOST_CAPABILITY_EXPORT_ID_SET.has(value);
}

/**
 * Value types an R6 host capability may carry. `f64` was added by F1-S1 for
 * the number boundary; `ref_extern` by F2-S2, because `wasm:js-string.concat`
 * returns `(ref extern)` and not `externref` (`registry/imports.ts`
 * `addStringImports`). The async projection stays on `externref | i32`.
 */
export type RuntimeHostCapabilityValueType = "externref" | "i32" | "f64" | "ref_extern";

const RUNTIME_HOST_CAPABILITY_VALUE_TYPES: ReadonlySet<string> = new Set<RuntimeHostCapabilityValueType>([
  "externref",
  "i32",
  "f64",
  "ref_extern",
]);

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

const RUNTIME_HOST_CAPABILITY_FUNC_MODULE_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_FUNC_MODULES);
const RUNTIME_HOST_CAPABILITY_GLOBAL_MODULE_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES);

export const RUNTIME_HOST_CAPABILITY_KINDS = Object.freeze(["export", "func", "func-family", "global"] as const);
export type RuntimeHostCapabilityKind = (typeof RUNTIME_HOST_CAPABILITY_KINDS)[number];
const RUNTIME_HOST_CAPABILITY_KIND_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_KINDS);

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
const RUNTIME_HOST_CAPABILITY_FIELD_SCHEME_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES);

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
const RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEME_SET: ReadonlySet<string> = new Set(
  RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEMES,
);

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
const RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATION_SET: ReadonlySet<string> = new Set(
  RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATIONS,
);

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
const RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VAR_SET: ReadonlySet<string> = new Set(
  RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VARS,
);

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
const RUNTIME_HOST_CAPABILITY_HOST_SELECTION_SET: ReadonlySet<string> = new Set(
  RUNTIME_HOST_CAPABILITY_HOST_SELECTIONS,
);

/** A declared selection axis: which env var, and which of its conditions picks this spelling. */
export interface RuntimeHostCapabilityHostSelection {
  readonly envVar: RuntimeHostCapabilityHostSelectionEnvVar;
  readonly selectsWhen: RuntimeHostCapabilityHostSelectionCondition;
}

/**
 * The smallest arity ANY capability family may admit.
 *
 * (#3526 F3-S2) This was `3` until family 3 arrived — the batched-concat
 * producer never fuses fewer than three leaves, so a row below three described
 * an import no lane could request. That reasoning was always about ONE
 * producer, and `__call_function_0` / `__boundary_callback_call_0` are real
 * imports at arity zero (measured, `.tmp/f3s2-plan/p3-family-abi.json` and
 * `p3d.json`), so a shared floor of three would make them unrepresentable.
 *
 * The guard did not disappear, it moved: each row DECLARES its own floor, and
 * `assertFuncFamilyCapabilityRecord` still refuses any row whose `min` drifts
 * from its canonical value (the `params range` compare below). So
 * `string.concat.many` still refuses arity 2 — through its own `min: 3` and
 * its row comment's rationale — and a hand-built family row that claims a
 * range no lane can request is still rejected. What this constant keeps
 * refusing on its own is the absolute nonsense: a negative or non-integer
 * arity, which no derivation rule can ever mean.
 */
const RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_MIN_ARITY = 0;

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
 * (#3526 F3-S2) Optional trailing options, deliberately an OBJECT rather than a
 * fifth positional argument: that slot in {@link record} is `exceptionPolicy`.
 */
interface RuntimeHostCapabilityFuncOptions {
  readonly hostSelection?: RuntimeHostCapabilityHostSelection;
}

function funcRecord(
  capability: RuntimeHostCapabilityFuncId,
  module: RuntimeHostCapabilityFuncModule,
  field: string,
  params: readonly RuntimeHostCapabilityValueType[],
  results: readonly RuntimeHostCapabilityValueType[],
  exceptionPolicy?: HostCallbackExceptionPolicy,
  options?: RuntimeHostCapabilityFuncOptions,
): RuntimeHostCapabilityFuncRecord {
  return Object.freeze({
    capability,
    module,
    field,
    kind: "func" as const,
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
    ...(exceptionPolicy === undefined ? {} : { exceptionPolicy }),
    ...(options?.hostSelection === undefined ? {} : { hostSelection: freezeHostSelection(options.hostSelection) }),
  });
}

/** Retain the axis as a frozen plain object so the structural compare has a stable shape. */
function freezeHostSelection(selection: RuntimeHostCapabilityHostSelection): RuntimeHostCapabilityHostSelection {
  return Object.freeze({ envVar: selection.envVar, selectsWhen: selection.selectsWhen });
}

/**
 * The `env`-defaulting alias every pre-F2-S2 row was written against. Kept so
 * the twelve existing rows — and the tests that pin their exact shape — are
 * untouched by the schema widening.
 */
function record(
  capability: RuntimeHostCapabilityFuncId,
  field: string,
  params: readonly RuntimeHostCapabilityValueType[],
  results: readonly RuntimeHostCapabilityValueType[],
  exceptionPolicy?: HostCallbackExceptionPolicy,
  options?: RuntimeHostCapabilityFuncOptions,
): RuntimeHostCapabilityFuncRecord {
  return funcRecord(capability, "env", field, params, results, exceptionPolicy, options);
}

function funcFamilyRecord(
  capability: RuntimeHostCapabilityFuncFamilyId,
  module: RuntimeHostCapabilityFuncModule,
  field: RuntimeHostCapabilityFuncFamilyField,
  params: RuntimeHostCapabilityFuncFamilyParams,
  results: readonly RuntimeHostCapabilityValueType[],
  options?: RuntimeHostCapabilityFuncOptions,
): RuntimeHostCapabilityFuncFamilyRecord {
  return Object.freeze({
    capability,
    module,
    field: Object.freeze({ scheme: field.scheme, prefix: field.prefix }),
    kind: "func-family" as const,
    params: Object.freeze({
      repeat: params.repeat,
      min: params.min,
      max: params.max,
      ...(params.leading === undefined ? {} : { leading: Object.freeze([...params.leading]) }),
    }),
    results: Object.freeze([...results]),
    ...(options?.hostSelection === undefined ? {} : { hostSelection: freezeHostSelection(options.hostSelection) }),
  });
}

/** (#3526 F3-S2) Build one EXPORT row — the twin of {@link globalRecord}. */
function exportRecord(
  capability: RuntimeHostCapabilityExportId,
  name: string,
  alias: string,
  params: readonly RuntimeHostCapabilityValueType[],
  results: readonly RuntimeHostCapabilityValueType[],
  publication: RuntimeHostCapabilityExportPublication,
): RuntimeHostCapabilityExportRecord {
  return Object.freeze({
    capability,
    name,
    alias,
    kind: "export" as const,
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
    publication,
  });
}

function globalRecord(
  capability: RuntimeHostCapabilityGlobalId,
  module: RuntimeHostCapabilityGlobalModule,
  field: RuntimeHostCapabilityGlobalField,
  valueType: RuntimeHostCapabilityValueType,
  mutable: boolean,
): RuntimeHostCapabilityGlobalRecord {
  return Object.freeze({
    capability,
    module,
    field: Object.freeze({ scheme: field.scheme }),
    kind: "global" as const,
    valueType,
    mutable,
  });
}

/**
 * The sole closed authority for host capability ABI. Every projection retains
 * these exact factory-created objects; no consumer may rebuild one from a
 * capability ID or an emitted import spelling. Sorted by capability ID so the
 * async prefix keeps its historical order and position.
 */
export const RUNTIME_HOST_CAPABILITY_RECORDS: readonly RuntimeHostCapabilityRecord[] = Object.freeze([
  record("async.callback.wrap", "__make_callback", ["i32", "externref"], ["externref"], HOST_CALLBACK_EXCEPTION_POLICY),
  record("async.promise.capability.create", "Promise_new_pending", [], ["externref"]),
  record("async.promise.react", "Promise_then2", ["externref", "externref", "externref"], ["externref"]),
  record("async.promise.resolve", "Promise_resolve", ["externref"], ["externref"]),
  record("async.promise.settle.fulfill", "Promise_settle_resolve", ["externref", "externref"], ["externref"]),
  record("async.promise.settle.reject", "Promise_settle_reject", ["externref", "externref"], ["externref"]),
  record("async.value.undefined", "__get_undefined", [], ["externref"]),
  // (#3526 F1-S2) The boolean boundary. `__box_boolean` is a member of the
  // same physical `addUnionImports` family; this record is manifest AUTHORITY
  // over its ABI, not a second registration path. The one-armed family has no
  // unbox row: `__unbox_boolean` has no IR producer.
  record("boolean.box", "__box_boolean", ["i32"], ["externref"]),
  // (#3526 F3-S2) ---- family 3: the callable boundary ----------------------
  //
  // NOTHING selects any of the rows below: no provider names them, so
  // `freeze()` never publishes them and no import, export or emitted body
  // moves. They make family 3's crossings EXPRESSIBLE; F3-S5/F3-S6 give them
  // providers.
  //
  // The unmatched-callee host fallback, NATIVE-boundary spelling.
  // `planHostCallFallback(arity, nativeBoundary=true)`
  // (`host-call-fallback.ts:19-30`) names `__boundary_callback_call_<arity>`;
  // `ensureHostCallFallbackImports` gives it `[callee, this, ...args]`, hence
  // `leading`. `min: 0` and `max: null` are MEASURED, not assumed: on the
  // gc + `semanticProviders: "native-first"` lane — the only lane that is
  // simultaneously `native-first` and `!standalone && !wasi`, which
  // `calls.ts:4650-4652` requires — a one-line `f(a0..aN)` fixture imports
  // `env.__boundary_callback_call_N` at every arity 0 through 6
  // (`.tmp/f3s2-plan/p3d.json`, `p3-import-abi.json`). The census observed
  // this family in ZERO of its 14 shapes × 4 lanes because it measured no
  // such lane.
  funcFamilyRecord(
    "callable.boundary_callback.call",
    "env",
    { scheme: "arity-suffix", prefix: "__boundary_callback_call_" },
    { repeat: "externref", leading: ["externref", "externref"], min: 0, max: null },
    ["externref"],
  ),
  // The two direct host→module dispatch exports. Both ABIs are the compiled
  // ground truth of a real gc-host module, read from the BINARY's type section
  // (P1, `.tmp/f3s2-plan/p1-export-abi.json`): `__closure_arity` is
  // `(externref) -> (i32)` and `__call_fn_N` is `(externref x (N+1)) ->
  // (externref)`, each published beside its compact alias. Producers:
  // `closure-exports.ts:2194`/`:2251` and `:907-910`/`:774`, aliases `:111`
  // and `:101-104`.
  exportRecord("callable.export.arity", "__closure_arity", "$ce", ["externref"], ["i32"], "host-bridge-gated"),
  exportRecord("callable.export.call_fn.0", "__call_fn_0", "$c0", ["externref"], ["externref"], "host-bridge-gated"),
  exportRecord(
    "callable.export.call_fn.1",
    "__call_fn_1",
    "$c1",
    ["externref", "externref"],
    ["externref"],
    "host-bridge-gated",
  ),
  exportRecord(
    "callable.export.call_fn.2",
    "__call_fn_2",
    "$c2",
    ["externref", "externref", "externref"],
    ["externref"],
    "host-bridge-gated",
  ),
  exportRecord(
    "callable.export.call_fn.3",
    "__call_fn_3",
    "$c3",
    ["externref", "externref", "externref", "externref"],
    ["externref"],
    "host-bridge-gated",
  ),
  exportRecord(
    "callable.export.call_fn.4",
    "__call_fn_4",
    "$c4",
    ["externref", "externref", "externref", "externref", "externref"],
    ["externref"],
    "host-bridge-gated",
  ),
  // The unmatched-callee host fallback, HOST spellings — a declared sibling
  // PAIR, not an either/or. `host-call-fallback.ts:20` selects the fixed-arity
  // member when `knob !== "0" && arity <= 4`, and the array member otherwise,
  // so a module can and does carry BOTH: CB7/12 on gc-host with the knob unset
  // imports `env.__call_function` alongside `__call_function_0..4`
  // (`.tmp/f3s2-plan/p3-family-abi.json`), and with the knob at `"0"` only the
  // array member survives. That is why `hostSelection` names a CONDITION and
  // not the knob's value.
  record(
    "callable.host_call.array",
    "__call_function",
    ["externref", "externref", "externref"],
    ["externref"],
    undefined,
    { hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "knob-zero-or-arity-above-max" } },
  ),
  funcFamilyRecord(
    "callable.host_call.fixed",
    "env",
    { scheme: "arity-suffix", prefix: "__call_function_" },
    { repeat: "externref", leading: ["externref", "externref"], min: 0, max: 4 },
    ["externref"],
    { hostSelection: { envVar: "JS2WASM_FIXED_ARITY_HOST_CALLS", selectsWhen: "knob-not-zero-within-arity" } },
  ),
  // The two callback-maker SIBLINGS of `async.callback.wrap`. Same
  // `(i32, externref) -> externref` shape as the maker, selected by
  // `resolveCallbackMakerName` (`callback-ctor-bridge.ts:46-64`): `needsThis`
  // picks the getter bridge, a constructible function EXPRESSION picks the ctor
  // bridge, everything else keeps `__make_callback`. Both ABIs measured from
  // real gc-host modules (`.tmp/f3s2-plan/p3-import-abi.json`) —
  // `Object.defineProperty(o, "v", { get() {...} })` for the getter,
  // `addEventListener("tick", function () {...})` for the ctor. F3-S1's record
  // comment names bringing these under a record as this slice's work.
  record("callback.wrap.ctor", "__make_callback_ctor", ["i32", "externref"], ["externref"]),
  record("callback.wrap.getter", "__make_getter_callback", ["i32", "externref"], ["externref"]),
  // ---- end family 3 -------------------------------------------------------
  // (#3526 F1-S4) The externref undefined probe. NOT a member of the
  // `addUnionImports` family: on the host lane `__extern_is_undefined` is a
  // standalone `ensureLateImport` registration, which is why the preregistration
  // trigger keys on it separately. This record is manifest AUTHORITY over its
  // ABI; the physical registration path is unchanged.
  record("extern.is_undefined", "__extern_is_undefined", ["externref"], ["i32"]),
  // (#3526 F1-S1) The number boundary. Both names are members of the physical
  // `addUnionImports` family; the records are manifest AUTHORITY over their
  // ABI, not a second registration path.
  record("number.box", "__box_number", ["f64"], ["externref"]),
  record("number.unbox", "__unbox_number", ["externref"], ["f64"]),
  // (#3526 F2-S2) The four `wasm:js-string` builtins, pinned against their
  // registration site (`registry/imports.ts` `addStringImports`). These are
  // the first records in a NON-`env` module namespace, and `string.concat` is
  // the first whose result is `(ref extern)` rather than a nullable externref
  // — a distinction the pre-F2-S2 value union could not express. NOTHING
  // selects them yet: no provider row names these capabilities, so no frozen
  // manifest carries them and no import moves.
  funcRecord("string.char_code_at", "wasm:js-string", "charCodeAt", ["externref", "i32"], ["i32"]),
  // (#3526 F2-S1) The string relational boundary — family 2's first record.
  // NOT a member of the `addUnionImports` family and NOT an `ensureLateImport`
  // registration either: `env.string_compare` is a BASE import minted by the
  // legacy import collector's pre-pass (`import-collector.ts`, gated on
  // `!nativeStrings`), so this record is manifest AUTHORITY over an ABI whose
  // physical registration happens before any IR preparation runs. That is why
  // the resolve arm looks the field up in `ctx.funcMap` and never mints it.
  record("string.compare", "string_compare", ["externref", "externref"], ["i32"]),
  funcRecord("string.concat", "wasm:js-string", "concat", ["externref", "externref"], ["ref_extern"]),
  // (#3526 F2-S6) The BATCHED many-arity concat family. The IR
  // `batchStringConcat` pass fuses a single-use immutable `+` tree of three or
  // more leaves into one call, and the host lane answers it with
  // `env.__concat_<arity>` — one import per observed arity, minted late, on
  // demand. `min: 3` is the pass's own floor (`batch-string-concat.ts`'s
  // three-leaf guard and `irStringConcatManySymbol`'s RangeError); `max: null`
  // is the measured host fact — `src/runtime.ts` matches the `__concat_`
  // prefix and answers any N, and the census observed `__concat_9`. The NATIVE
  // arm's 3..8 bound is a provider fact, not a capability one, and lives on
  // that provider row.
  funcFamilyRecord(
    "string.concat.many",
    "env",
    { scheme: "arity-suffix", prefix: "__concat_" },
    { repeat: "externref", min: 3, max: null },
    ["externref"],
  ),
  // (#3526 F2-S2) The two string-literal GLOBAL namespaces. The import field
  // is DERIVED from the literal, so the row can only fix the derivation rule:
  // `addStringConstantGlobal` uses the literal itself, or `hexCodeUnits` in
  // the `string_constants16` surrogate namespace (#2880). Both are immutable
  // `externref` globals.
  globalRecord("string.const", "string_constants", { scheme: "literal" }, "externref", false),
  globalRecord("string.const.utf16", "string_constants16", { scheme: "literal-utf16-hex" }, "externref", false),
  funcRecord("string.eq", "wasm:js-string", "equals", ["externref", "externref"], ["i32"]),
  funcRecord("string.len", "wasm:js-string", "length", ["externref"], ["i32"]),
]);

const RECORD_BY_ID: ReadonlyMap<RuntimeHostCapabilityId, RuntimeHostCapabilityRecord> = new Map(
  RUNTIME_HOST_CAPABILITY_RECORDS.map((entry) => [entry.capability, entry] as const),
);
const CANONICAL_RECORDS: ReadonlySet<RuntimeHostCapabilityRecord> = new Set(RUNTIME_HOST_CAPABILITY_RECORDS);

function compareCapabilityRecords(left: RuntimeHostCapabilityRecord, right: RuntimeHostCapabilityRecord): number {
  return left.capability < right.capability ? -1 : left.capability > right.capability ? 1 : 0;
}

function describeRecord(value: unknown): string {
  if (value && typeof value === "object" && "capability" in value) return String(value.capability);
  return String(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(
      `host capability ${describeRecord(value)} keys ${actual.join(",")} do not match ${canonical.join(",")}`,
    );
  }
}

function assertValueTypes(
  value: unknown,
  expected: readonly RuntimeHostCapabilityValueType[],
  field: "params" | "results" | "valueType",
  capability: RuntimeHostCapabilityId,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index] || !RUNTIME_HOST_CAPABILITY_VALUE_TYPES.has(String(entry)))
  ) {
    throw new Error(
      `host capability ${capability} ${field} ${JSON.stringify(value)} do not match ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * Validate one record structurally and against the exact closed ABI. This is
 * intentionally separate from the identity guard so malformed test catalogues
 * produce a precise preparation-time invariant rather than looking canonical.
 *
 * (#3526 F2-S2) The kind and module membership checks are the RUNTIME TWINS of
 * the closed type unions above, and they are deliberately distinct from the
 * equality rejections: `unknown host capability <id> kind/module <x>` says the
 * schema has no such arm, while `... does not match ...` says the arm is real
 * but the row is wrong.
 */
export function assertRuntimeHostCapabilityRecord(value: unknown): asserts value is RuntimeHostCapabilityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`host capability record must be a plain object, got ${String(value)}`);
  }
  const candidate = value as Record<string, unknown>;
  if (Object.getPrototypeOf(candidate) !== Object.prototype) {
    throw new Error(`host capability ${describeRecord(candidate)} must be a plain object`);
  }
  const capability = candidate.capability;
  if (typeof capability !== "string" || !RUNTIME_HOST_CAPABILITY_ID_SET.has(capability)) {
    throw new Error(`unknown host capability ${String(capability)}`);
  }
  const id = capability as RuntimeHostCapabilityId;
  const expected = RECORD_BY_ID.get(id);
  if (!expected) throw new Error(`host capability ${id} has no canonical record`);
  if (typeof candidate.kind !== "string" || !RUNTIME_HOST_CAPABILITY_KIND_SET.has(candidate.kind)) {
    throw new Error(`unknown host capability ${id} kind ${String(candidate.kind)}`);
  }
  if (candidate.kind !== expected.kind) {
    throw new Error(`host capability ${id} kind ${String(candidate.kind)} does not match ${expected.kind}`);
  }
  if (expected.kind === "global") {
    assertGlobalCapabilityRecord(candidate, id, expected);
    return;
  }
  if (expected.kind === "func-family") {
    assertFuncFamilyCapabilityRecord(candidate, id, expected);
    return;
  }
  if (expected.kind === "export") {
    assertExportCapabilityRecord(candidate, id, expected);
    return;
  }
  const keys = ["capability", "field", "kind", "module", "params", "results"];
  if (expected.exceptionPolicy !== undefined) keys.push("exceptionPolicy");
  if (expected.hostSelection !== undefined) keys.push("hostSelection");
  assertExactKeys(candidate, keys);
  if (typeof candidate.module !== "string" || !RUNTIME_HOST_CAPABILITY_FUNC_MODULE_SET.has(candidate.module)) {
    throw new Error(`unknown host capability ${id} module ${String(candidate.module)}`);
  }
  if (candidate.module !== expected.module) {
    throw new Error(`host capability ${id} module ${String(candidate.module)} does not match ${expected.module}`);
  }
  if (candidate.field !== expected.field) {
    throw new Error(`host capability ${id} field ${String(candidate.field)} does not match ${expected.field}`);
  }
  assertValueTypes(candidate.params, expected.params, "params", id);
  assertValueTypes(candidate.results, expected.results, "results", id);
  if (candidate.exceptionPolicy !== expected.exceptionPolicy) {
    throw new Error(
      `host capability ${id} exception policy ${String(candidate.exceptionPolicy)} does not match ${String(expected.exceptionPolicy)}`,
    );
  }
  assertHostSelection(candidate.hostSelection, expected.hostSelection, id);
}

/**
 * (#3526 F3-S2) Compare the declared selection axis STRUCTURALLY.
 *
 * `exceptionPolicy` can be compared with `!==` (`:538`) only because it is a
 * string literal. `hostSelection` is an object, so identity comparison would
 * accept every structurally-equal foreign object and reject every identical
 * one — the exact inversion of what a closed schema needs. Presence must agree
 * too: an absent axis on a row that declares one is not "no opinion", it is a
 * row that lost its sibling contract.
 */
function assertHostSelection(
  candidate: unknown,
  expected: RuntimeHostCapabilityHostSelection | undefined,
  id: RuntimeHostCapabilityId,
): void {
  if (expected === undefined) {
    if (candidate !== undefined) {
      throw new Error(`host capability ${id} host selection ${describeRecord(candidate)} does not match none`);
    }
    return;
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`host capability ${id} host selection ${String(candidate)} does not match a selection axis`);
  }
  assertExactKeys(candidate as Record<string, unknown>, ["envVar", "selectsWhen"]);
  const { envVar, selectsWhen } = candidate as { envVar?: unknown; selectsWhen?: unknown };
  if (typeof envVar !== "string" || !RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VAR_SET.has(envVar)) {
    throw new Error(`unknown host capability ${id} host selection env var ${String(envVar)}`);
  }
  if (typeof selectsWhen !== "string" || !RUNTIME_HOST_CAPABILITY_HOST_SELECTION_SET.has(selectsWhen)) {
    throw new Error(`unknown host capability ${id} host selection condition ${String(selectsWhen)}`);
  }
  if (envVar !== expected.envVar || selectsWhen !== expected.selectsWhen) {
    throw new Error(
      `host capability ${id} host selection ${envVar}/${selectsWhen} does not match ${expected.envVar}/${expected.selectsWhen}`,
    );
  }
}

/**
 * (#3526 F3-S2) The EXPORT arm. The exact-key list is the enforcement that an
 * export row carries NO `module`: a row that grew one would be refused here
 * before any consumer could read it as an import namespace.
 */
function assertExportCapabilityRecord(
  candidate: Record<string, unknown>,
  id: RuntimeHostCapabilityId,
  expected: RuntimeHostCapabilityExportRecord,
): void {
  assertExactKeys(candidate, ["alias", "capability", "kind", "name", "params", "publication", "results"]);
  const { name, alias, publication } = candidate as { name?: unknown; alias?: unknown; publication?: unknown };
  if (typeof name !== "string" || name.length === 0 || name !== expected.name) {
    throw new Error(`host capability ${id} export name ${String(name)} does not match ${expected.name}`);
  }
  if (typeof alias !== "string" || alias.length === 0 || alias !== expected.alias) {
    throw new Error(`host capability ${id} export alias ${String(alias)} does not match ${expected.alias}`);
  }
  if (typeof publication !== "string" || !RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATION_SET.has(publication)) {
    throw new Error(`unknown host capability ${id} export publication ${String(publication)}`);
  }
  if (publication !== expected.publication) {
    throw new Error(`host capability ${id} export publication ${publication} does not match ${expected.publication}`);
  }
  assertValueTypes(candidate.params, expected.params, "params", id);
  assertValueTypes(candidate.results, expected.results, "results", id);
}

/**
 * (#3526 F2-S6) The family arm. It checks the DERIVATION RULE, because that is
 * all a family row states: which scheme derives the field, from which prefix,
 * and over which arity range.
 *
 * `min >= 3` is not decoration — it is the measured floor of the producer
 * (`batchStringConcat` only fuses three or more leaves, and
 * `irStringConcatManySymbol` throws below three), so a row admitting arity 2
 * would describe an import no lane can ever request.
 */
function assertFuncFamilyCapabilityRecord(
  candidate: Record<string, unknown>,
  id: RuntimeHostCapabilityId,
  expected: RuntimeHostCapabilityFuncFamilyRecord,
): void {
  const familyKeys = ["capability", "field", "kind", "module", "params", "results"];
  if (expected.hostSelection !== undefined) familyKeys.push("hostSelection");
  assertExactKeys(candidate, familyKeys);
  if (typeof candidate.module !== "string" || !RUNTIME_HOST_CAPABILITY_FUNC_MODULE_SET.has(candidate.module)) {
    throw new Error(`unknown host capability ${id} module ${String(candidate.module)}`);
  }
  if (candidate.module !== expected.module) {
    throw new Error(`host capability ${id} module ${String(candidate.module)} does not match ${expected.module}`);
  }
  const field = candidate.field;
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`host capability ${id} field ${String(field)} does not match a family field scheme`);
  }
  assertExactKeys(field as Record<string, unknown>, ["prefix", "scheme"]);
  const { scheme, prefix } = field as { scheme?: unknown; prefix?: unknown };
  if (typeof scheme !== "string" || !RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEME_SET.has(scheme)) {
    throw new Error(`unknown host capability ${id} field scheme ${String(scheme)}`);
  }
  if (scheme !== expected.field.scheme) {
    throw new Error(`host capability ${id} field scheme ${scheme} does not match ${expected.field.scheme}`);
  }
  if (typeof prefix !== "string" || prefix.length === 0 || prefix !== expected.field.prefix) {
    throw new Error(`host capability ${id} field prefix ${String(prefix)} does not match ${expected.field.prefix}`);
  }
  const params = candidate.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`host capability ${id} params ${String(params)} do not match a family params scheme`);
  }
  const paramKeys = ["max", "min", "repeat"];
  if (expected.params.leading !== undefined) paramKeys.push("leading");
  assertExactKeys(params as Record<string, unknown>, paramKeys);
  const { repeat, min, max, leading } = params as {
    repeat?: unknown;
    min?: unknown;
    max?: unknown;
    leading?: unknown;
  };
  assertValueTypes([repeat], [expected.params.repeat], "params", id);
  if (expected.params.leading === undefined) {
    if (leading !== undefined) {
      throw new Error(`host capability ${id} params leading ${JSON.stringify(leading)} does not match none`);
    }
  } else {
    assertValueTypes(leading, expected.params.leading, "params", id);
  }
  if (!Number.isSafeInteger(min) || (min as number) < RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_MIN_ARITY) {
    throw new Error(
      `host capability ${id} params min ${String(min)} is below the ${RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_MIN_ARITY}-operand floor`,
    );
  }
  if (max !== null && (!Number.isSafeInteger(max) || (max as number) < (min as number))) {
    throw new Error(`host capability ${id} params max ${String(max)} does not cover min ${String(min)}`);
  }
  if (min !== expected.params.min || max !== expected.params.max) {
    throw new Error(
      `host capability ${id} params range ${String(min)}..${String(max)} does not match ${String(expected.params.min)}..${String(expected.params.max)}`,
    );
  }
  assertValueTypes(candidate.results, expected.results, "results", id);
  assertHostSelection(candidate.hostSelection, expected.hostSelection, id);
}

function assertGlobalCapabilityRecord(
  candidate: Record<string, unknown>,
  id: RuntimeHostCapabilityId,
  expected: RuntimeHostCapabilityGlobalRecord,
): void {
  assertExactKeys(candidate, ["capability", "field", "kind", "module", "mutable", "valueType"]);
  if (typeof candidate.module !== "string" || !RUNTIME_HOST_CAPABILITY_GLOBAL_MODULE_SET.has(candidate.module)) {
    throw new Error(`unknown host capability ${id} module ${String(candidate.module)}`);
  }
  if (candidate.module !== expected.module) {
    throw new Error(`host capability ${id} module ${String(candidate.module)} does not match ${expected.module}`);
  }
  const field = candidate.field;
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`host capability ${id} field ${String(field)} does not match a global field scheme`);
  }
  assertExactKeys(field as Record<string, unknown>, ["scheme"]);
  const scheme = (field as { scheme?: unknown }).scheme;
  if (typeof scheme !== "string" || !RUNTIME_HOST_CAPABILITY_FIELD_SCHEME_SET.has(scheme)) {
    throw new Error(`unknown host capability ${id} field scheme ${String(scheme)}`);
  }
  if (scheme !== expected.field.scheme) {
    throw new Error(`host capability ${id} field scheme ${scheme} does not match ${expected.field.scheme}`);
  }
  assertValueTypes([candidate.valueType], [expected.valueType], "valueType", id);
  if (typeof candidate.mutable !== "boolean" || candidate.mutable !== expected.mutable) {
    throw new Error(
      `host capability ${id} mutable ${String(candidate.mutable)} does not match ${String(expected.mutable)}`,
    );
  }
}

/** Authenticate that an attached record is the exact factory-created object. */
export function assertCanonicalRuntimeHostCapabilityRecord(
  value: unknown,
): asserts value is RuntimeHostCapabilityRecord {
  assertRuntimeHostCapabilityRecord(value);
  if (!CANONICAL_RECORDS.has(value)) {
    throw new Error(`host capability ${value.capability} is not the canonical catalog record`);
  }
}

/**
 * (#3526 F2-S2) The fail-closed kind guard every func-assuming consumer takes.
 * A global record has no `params`/`results` and no callable import spelling,
 * so a consumer that reached one would silently build a nonsense
 * `irImportFuncRef`. This throws instead, naming the capability.
 *
 * (#3526 F3-S2) Its CODE is unchanged and its refusal set has grown: an
 * `export` record is refused for a different reason than a global one. An
 * export DOES have `params`/`results`, so the shape alone would not stop a
 * consumer — but it has no `module` and its direction is host→module, so
 * building an import reference from it would name something the module never
 * imports. The kind test catches both.
 */
export function asCallableRuntimeHostCapabilityRecord(
  value: RuntimeHostCapabilityRecord,
): RuntimeHostCapabilityFuncRecord {
  if (value.kind !== "func") {
    throw new Error(`host capability ${value.capability} is not a callable host capability`);
  }
  return value;
}

/** Validate, canonicalize traversal order, and retain the exact record objects. */
export function canonicalizeRuntimeHostCapabilityCatalog(
  records: readonly RuntimeHostCapabilityRecord[],
): readonly RuntimeHostCapabilityRecord[] {
  if (!Array.isArray(records)) throw new Error("host capability catalog must be an array");
  const seen = new Set<RuntimeHostCapabilityId>();
  for (const entry of records) {
    assertCanonicalRuntimeHostCapabilityRecord(entry);
    if (seen.has(entry.capability)) {
      throw new Error(`host capability catalog duplicates ${entry.capability}`);
    }
    seen.add(entry.capability);
  }
  const missing = RUNTIME_HOST_CAPABILITY_IDS.filter((capability) => !seen.has(capability));
  if (missing.length > 0 || records.length !== RUNTIME_HOST_CAPABILITY_IDS.length) {
    throw new Error(`host capability catalog is incomplete; missing ${missing.join(",") || "none"}`);
  }
  return Object.freeze([...records].sort(compareCapabilityRecords));
}

/** Resolve one selected ID from an already validated catalog, fail-closed. */
export function resolveRuntimeHostCapabilityRecord(
  records: readonly RuntimeHostCapabilityRecord[],
  capability: RuntimeHostCapabilityId,
): RuntimeHostCapabilityRecord {
  const found = records.find((candidate) => candidate.capability === capability);
  if (!found) throw new Error(`host capability catalog does not define ${capability}`);
  assertCanonicalRuntimeHostCapabilityRecord(found);
  return found;
}

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

/**
 * Resolve one selected FAMILY id at one arity, fail-closed on misses, kind and
 * range. This is the ONLY place a family's physical field name is derived; no
 * consumer may rebuild `prefix + arity` itself.
 */
export function resolveRuntimeHostCapabilityFuncFamilyRecord(
  records: readonly RuntimeHostCapabilityRecord[],
  capability: RuntimeHostCapabilityFuncFamilyId,
  arity: number,
): ResolvedRuntimeHostCapabilityFuncFamilyRow {
  const found = resolveRuntimeHostCapabilityRecord(records, capability);
  if (found.kind !== "func-family") {
    throw new Error(`host capability ${capability} is not a host capability family`);
  }
  const { min, max, repeat } = found.params;
  if (!Number.isSafeInteger(arity) || arity < min || (max !== null && arity > max)) {
    throw new Error(
      `host capability family ${capability} does not cover arity ${String(arity)} (${min}..${max ?? "unbounded"})`,
    );
  }
  return Object.freeze({
    module: found.module,
    field: `${found.field.prefix}${arity}`,
    // (#3526 F3-S2) `leading ++ repeat x arity`. The fixed prefix comes first
    // because that is the physical order `ensureHostCallFallbackImports`
    // registers (`host-call-fallback.ts:34-38`: callee, this, then the args).
    params: Object.freeze([...(found.params.leading ?? []), ...Array.from({ length: arity }, () => repeat)]),
    results: found.results,
  });
}

/**
 * (#3526 F2-S8) Resolve one selected GLOBAL ID, fail-closed on both misses and
 * kind — the exact twin of {@link resolveRuntimeHostCapabilityFuncRecord}.
 *
 * {@link resolveRuntimeHostCapabilityRecord} is deliberately kind-AGNOSTIC (the
 * manifest freeze publishes records of every kind through it), so a consumer
 * that wants a global — the string-literal storage seam is the first — needs
 * its own guard rather than reusing the func one, whose whole job is to refuse
 * exactly this kind. A global record carries a field SCHEME rather than a field
 * name, because the field IS the literal.
 */
export function resolveRuntimeHostCapabilityGlobalRecord(
  records: readonly RuntimeHostCapabilityRecord[],
  capability: RuntimeHostCapabilityGlobalId,
): RuntimeHostCapabilityGlobalRecord {
  const found = resolveRuntimeHostCapabilityRecord(records, capability);
  if (found.kind !== "global") {
    throw new Error(`host capability ${capability} is not a global host capability`);
  }
  return found;
}

/**
 * (#3526 F3-S2) Resolve one selected EXPORT ID, fail-closed on both misses and
 * kind — the twin of {@link resolveRuntimeHostCapabilityGlobalRecord}.
 *
 * An export row carries a `name`/`alias` pair and a publication gate where a
 * func row carries a module and a field, so a consumer that wants an export
 * needs its own guard rather than reusing the func one, whose whole job is to
 * refuse exactly this kind.
 */
export function resolveRuntimeHostCapabilityExportRecord(
  records: readonly RuntimeHostCapabilityRecord[],
  capability: RuntimeHostCapabilityExportId,
): RuntimeHostCapabilityExportRecord {
  const found = resolveRuntimeHostCapabilityRecord(records, capability);
  if (found.kind !== "export") {
    throw new Error(`host capability ${capability} is not an export host capability`);
  }
  return found;
}

/**
 * Resolve one selected FUNC ID, fail-closed on both misses and kind. The
 * static parameter type already rejects a global id; the kind guard is its
 * runtime twin, for catalogues that arrive through an `unknown` boundary.
 */
export function resolveRuntimeHostCapabilityFuncRecord(
  records: readonly RuntimeHostCapabilityRecord[],
  capability: RuntimeHostCapabilityFuncId,
): RuntimeHostCapabilityFuncRecord {
  return asCallableRuntimeHostCapabilityRecord(resolveRuntimeHostCapabilityRecord(records, capability));
}

/**
 * (#3526 F3-S1) The host callback MAKER's record, resolved from the catalogue
 * once at module scope.
 *
 * from-ast runs in Phase 1, BEFORE the runtime manifest is frozen, so the maker
 * crossing it emits cannot read a selected provider — but it must not spell the
 * import by hand either. This const is the seam between those two facts: the
 * STATIC catalogue is the authority over the maker's `env`.`__make_callback`
 * ABI at build time, and the FROZEN manifest is the authority over whether that
 * crossing is admitted at all, post-freeze
 * (`preparedHostCallbackWrapProvider`). Both name the same record — this one —
 * so neither authority can drift from the other.
 *
 * Scope, precisely: this covers the IR seam. Renaming the record's `field`
 * lands in one place FOR THAT SEAM, but two legacy sites still spell the maker
 * by hand — `src/codegen/declarations/import-collector.ts:2010`/`:2053` mint
 * `env.__make_callback` and `src/codegen/async-frame.ts:165` looks it up
 * through `ctx.funcMap` — so a rename must move those too. Measured
 * fail-safe rather than silent: perturbing the field to `__make_callback_probe`
 * demotes the whole module to a 504-byte legacy build rather than miscompiling.
 * Bringing those two under the record is F3-S2's `callback.wrap.*` sibling row.
 */
export const HOST_CALLBACK_WRAP_CAPABILITY_RECORD: RuntimeHostCapabilityFuncRecord =
  resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "async.callback.wrap");
