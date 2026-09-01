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
 */

export const RUNTIME_HOST_CAPABILITY_IDS = Object.freeze([
  "async.callback.wrap",
  "async.promise.capability.create",
  "async.promise.react",
  "async.promise.resolve",
  "async.promise.settle.fulfill",
  "async.promise.settle.reject",
  "async.value.undefined",
  "boolean.box",
  "number.box",
  "number.unbox",
] as const);

export type RuntimeHostCapabilityId = (typeof RUNTIME_HOST_CAPABILITY_IDS)[number];

const RUNTIME_HOST_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(RUNTIME_HOST_CAPABILITY_IDS);

export function isRuntimeHostCapabilityId(value: string): value is RuntimeHostCapabilityId {
  return RUNTIME_HOST_CAPABILITY_ID_SET.has(value);
}

/**
 * Value types an R6 host capability may carry. `f64` was added by F1-S1 for
 * the number boundary; the async projection stays on `externref | i32`.
 */
export type RuntimeHostCapabilityValueType = "externref" | "i32" | "f64";

const RUNTIME_HOST_CAPABILITY_VALUE_TYPES: ReadonlySet<string> = new Set<RuntimeHostCapabilityValueType>([
  "externref",
  "i32",
  "f64",
]);

/**
 * Exception policy at the host reaction boundary. A compiled throw crosses
 * that boundary as a WebAssembly.Exception carrying the original JS value in
 * this module's exception tag. The host Promise must observe that value, not
 * the Wasm carrier. Foreign tags and runtime traps are deliberately excluded.
 */
export const HOST_CALLBACK_EXCEPTION_POLICY = "module-tag-payload" as const;
export type HostCallbackExceptionPolicy = typeof HOST_CALLBACK_EXCEPTION_POLICY;

/** Exact concrete capability record selected by the frozen semantic manifest. */
export interface RuntimeHostCapabilityRecord<
  Id extends RuntimeHostCapabilityId = RuntimeHostCapabilityId,
  Value extends RuntimeHostCapabilityValueType = RuntimeHostCapabilityValueType,
> {
  readonly capability: Id;
  readonly module: "env";
  readonly field: string;
  readonly kind: "func";
  readonly params: readonly Value[];
  readonly results: readonly Value[];
  readonly exceptionPolicy?: HostCallbackExceptionPolicy;
}

function record(
  capability: RuntimeHostCapabilityId,
  field: string,
  params: readonly RuntimeHostCapabilityValueType[],
  results: readonly RuntimeHostCapabilityValueType[],
  exceptionPolicy?: HostCallbackExceptionPolicy,
): RuntimeHostCapabilityRecord {
  return Object.freeze({
    capability,
    module: "env" as const,
    field,
    kind: "func" as const,
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
    ...(exceptionPolicy === undefined ? {} : { exceptionPolicy }),
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
  // (#3526 F1-S1) The number boundary. Both names are members of the physical
  // `addUnionImports` family; the records are manifest AUTHORITY over their
  // ABI, not a second registration path.
  record("number.box", "__box_number", ["f64"], ["externref"]),
  record("number.unbox", "__unbox_number", ["externref"], ["f64"]),
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
  field: "params" | "results",
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
  const keys = ["capability", "field", "kind", "module", "params", "results"];
  if (expected.exceptionPolicy !== undefined) keys.push("exceptionPolicy");
  assertExactKeys(candidate, keys);
  if (candidate.module !== expected.module) {
    throw new Error(`host capability ${id} module ${String(candidate.module)} does not match ${expected.module}`);
  }
  if (candidate.field !== expected.field) {
    throw new Error(`host capability ${id} field ${String(candidate.field)} does not match ${expected.field}`);
  }
  if (candidate.kind !== expected.kind) {
    throw new Error(`host capability ${id} kind ${String(candidate.kind)} does not match ${expected.kind}`);
  }
  assertValueTypes(candidate.params, expected.params, "params", id);
  assertValueTypes(candidate.results, expected.results, "results", id);
  if (candidate.exceptionPolicy !== expected.exceptionPolicy) {
    throw new Error(
      `host capability ${id} exception policy ${String(candidate.exceptionPolicy)} does not match ${String(expected.exceptionPolicy)}`,
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
