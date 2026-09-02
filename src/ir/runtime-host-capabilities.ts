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
  "extern.is_undefined",
  "number.box",
  "number.unbox",
  "string.char_code_at",
  "string.compare",
  "string.concat",
  "string.eq",
  "string.len",
] as const);

export const RUNTIME_HOST_CAPABILITY_GLOBAL_IDS = Object.freeze(["string.const", "string.const.utf16"] as const);

export type RuntimeHostCapabilityFuncId = (typeof RUNTIME_HOST_CAPABILITY_FUNC_IDS)[number];
export type RuntimeHostCapabilityGlobalId = (typeof RUNTIME_HOST_CAPABILITY_GLOBAL_IDS)[number];
export type RuntimeHostCapabilityId = RuntimeHostCapabilityFuncId | RuntimeHostCapabilityGlobalId;

/** Every id, sorted — the completeness axis the catalogue is checked against. */
export const RUNTIME_HOST_CAPABILITY_IDS: readonly RuntimeHostCapabilityId[] = Object.freeze(
  [...RUNTIME_HOST_CAPABILITY_FUNC_IDS, ...RUNTIME_HOST_CAPABILITY_GLOBAL_IDS].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  ),
);

const RUNTIME_HOST_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_IDS);
const RUNTIME_HOST_CAPABILITY_FUNC_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_FUNC_IDS);
const RUNTIME_HOST_CAPABILITY_GLOBAL_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_GLOBAL_IDS);

export function isRuntimeHostCapabilityId(value: string): value is RuntimeHostCapabilityId {
  return RUNTIME_HOST_CAPABILITY_ID_SET.has(value);
}

/** Runtime twin of the func half of the id union (the `host-callable` domain). */
export function isRuntimeHostCapabilityFuncId(value: string): value is RuntimeHostCapabilityFuncId {
  return RUNTIME_HOST_CAPABILITY_FUNC_ID_SET.has(value);
}

/** Runtime twin of the global half of the id union. */
export function isRuntimeHostCapabilityGlobalId(value: string): value is RuntimeHostCapabilityGlobalId {
  return RUNTIME_HOST_CAPABILITY_GLOBAL_ID_SET.has(value);
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

export const RUNTIME_HOST_CAPABILITY_KINDS = Object.freeze(["func", "global"] as const);
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

export type RuntimeHostCapabilityRecord<
  Id extends RuntimeHostCapabilityId = RuntimeHostCapabilityId,
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> =
  | RuntimeHostCapabilityFuncRecord<Extract<Id, RuntimeHostCapabilityFuncId>, Value>
  | RuntimeHostCapabilityGlobalRecord<Extract<Id, RuntimeHostCapabilityGlobalId>, Value>;

function funcRecord(
  capability: RuntimeHostCapabilityFuncId,
  module: RuntimeHostCapabilityFuncModule,
  field: string,
  params: readonly RuntimeHostCapabilityValueType[],
  results: readonly RuntimeHostCapabilityValueType[],
  exceptionPolicy?: HostCallbackExceptionPolicy,
): RuntimeHostCapabilityFuncRecord {
  return Object.freeze({
    capability,
    module,
    field,
    kind: "func" as const,
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
    ...(exceptionPolicy === undefined ? {} : { exceptionPolicy }),
  });
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
): RuntimeHostCapabilityFuncRecord {
  return funcRecord(capability, "env", field, params, results, exceptionPolicy);
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
  const keys = ["capability", "field", "kind", "module", "params", "results"];
  if (expected.exceptionPolicy !== undefined) keys.push("exceptionPolicy");
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
