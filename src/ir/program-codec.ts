// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — lossless codec for the production `PreparedIrProgram`.
//
// The codec owns no schema of its own. Its accepted data domain is exactly the
// prepared-data model that `freezePreparedIrValue` (src/ir/program.ts, package
// A) accepts and preserves:
//
//   - primitives: string, boolean, finite/non-finite/negative-zero number,
//     bigint, null, undefined
//   - arrays, including holes (absent index), present `undefined` and present
//     `null` as three distinct states
//   - plain records (Object.prototype or null prototype) whose own string keys
//     may be anything — including `__proto__` and integer-like keys — plus at
//     most one symbol key, the IR_CLASS_SHAPE_CELL brand
//   - Map / Set (and A's FrozenMap / FrozenSet)
//   - recursion only through exact branded IR class shapes
//
// Everything else (functions, symbols, foreign instances, other cycles) is
// refused before any bytes are produced. Decoding rebuilds that model and hands
// it to A's copier, so "prepared data" has a single definition.
//
// Canonical bytes: this file writes JSON itself. Record keys are sorted by
// UTF-16 code unit, every non-JSON value has exactly one tagged spelling, and a
// decoded value must re-encode to the identical bytes or the input is refused
// (this rejects leading whitespace, duplicate keys, reordered keys and every
// other non-canonical serialization without a second parser).
//
// A decoded program is data until its runtime projections are regenerated
// through A/B's pure producer, compared field-for-field with the persisted
// claims, frozen in place and passed through A's complete validator. Only that
// re-authenticated program is returned by `decodePreparedIrProgram`.

import { IR_CLASS_SHAPE_CELL } from "./nodes.js";
import {
  freezePreparedIrRuntimeValue,
  freezePreparedIrValue,
  preparedIrDataMismatch,
  PreparedIrProgramInvariantError,
  type PreparedIrProgram,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";
import { preparedIrDraftAbiLookup } from "./program-abi-contracts.js";
import { irProgramRuntimeDemands } from "./program-runtime-demands.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import { prepareWholeProgramRuntimeManifest } from "./runtime-program-manifest.js";

export const PREPARED_IR_PROGRAM_CODEC = "prepared-ir-program-codec-v1" as const;
export const PREPARED_IR_PROGRAM_SCHEMA = "prepared-ir-program-v1" as const;

/** Tagged single-key records. A real record key starting with `$` is escaped to `$$…`. */
const TAG_NUMBER = "$number";
const TAG_BIGINT = "$bigint";
const TAG_UNDEFINED = "$undefined";
const TAG_HOLE = "$hole";
const TAG_MAP = "$map";
const TAG_SET = "$set";
const TAG_CLASS_SHAPE_REF = "$classShapeRef";
/** The only symbol-keyed property prepared data may carry, spelled as a reserved string key. */
const KEY_CLASS_SHAPE_CELL = "$irClassShapeCell";

const SPECIAL_NUMBERS: readonly (readonly [string, number])[] = [
  ["-0", -0],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
];

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `program codec: ${detail}`);
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isReadonlyMapLike(value: object): value is ReadonlyMap<unknown, unknown> {
  if (value instanceof Map) return true;
  const tag = (value as { readonly [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  return tag === "FrozenMap" && typeof (value as ReadonlyMap<unknown, unknown>).entries === "function";
}

function isReadonlySetLike(value: object): value is ReadonlySet<unknown> {
  if (value instanceof Set) return true;
  const tag = (value as { readonly [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  return tag === "FrozenSet" && typeof (value as ReadonlySet<unknown>).values === "function";
}

/** Same predicate the prepared-data copier uses to admit a recursive class shape. */
function isRecursiveIrClassShape(value: object): value is { readonly classId: string } {
  const own = (key: PropertyKey) => Object.getOwnPropertyDescriptor(value, key)?.value;
  const classId = own("classId");
  return (
    own(IR_CLASS_SHAPE_CELL) === true &&
    typeof classId === "string" &&
    classId.startsWith("ir-class:v1:") &&
    typeof own("className") === "string" &&
    Array.isArray(own("fields")) &&
    Array.isArray(own("methods")) &&
    Array.isArray(own("constructorParams"))
  );
}

/** UTF-16 code-unit order; independent of the engine's own-key ordering rules. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Encoding — writes canonical JSON text directly
// ---------------------------------------------------------------------------

function quote(text: string): string {
  return JSON.stringify(text);
}

function tagged(tag: string, payload: string): string {
  return `{${quote(tag)}:${payload}}`;
}

function encodeValue(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      return quote(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
      const special = SPECIAL_NUMBERS.find(([, candidate]) => Object.is(candidate, value));
      if (!special) return invalid(`${path}: number ${String(value)} has no canonical spelling`);
      return tagged(TAG_NUMBER, quote(special[0]));
    }
    case "bigint":
      return tagged(TAG_BIGINT, quote(value.toString(10)));
    case "undefined":
      return tagged(TAG_UNDEFINED, "true");
    case "function":
      return invalid(`${path}: prepared data cannot contain executable functions`);
    case "symbol":
      return invalid(`${path}: prepared data cannot contain symbol values`);
    case "object":
      break;
    default:
      return invalid(`${path}: unsupported value type ${typeof value}`);
  }
  if (value === null) return "null";
  if (ancestors.has(value)) {
    if (isRecursiveIrClassShape(value)) return tagged(TAG_CLASS_SHAPE_REF, quote(value.classId));
    return invalid(`${path}: prepared data must be acyclic outside exact IR class shapes`);
  }
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        items.push(tagged(TAG_HOLE, "true"));
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, index)!;
      if (!("value" in descriptor)) return invalid(`${path}[${index}]: array element must be a data property`);
      items.push(encodeValue(descriptor.value, `${path}[${index}]`, next));
    }
    return `[${items.join(",")}]`;
  }
  if (isReadonlyMapLike(value)) {
    const entries = [...value.entries()].map(
      ([key, item], index) =>
        `[${encodeValue(key, `${path}<key ${index}>`, next)},${encodeValue(item, `${path}<value ${index}>`, next)}]`,
    );
    return tagged(TAG_MAP, `[${entries.join(",")}]`);
  }
  if (isReadonlySetLike(value)) {
    const items = [...value.values()].map((item, index) => encodeValue(item, `${path}<item ${index}>`, next));
    return tagged(TAG_SET, `[${items.join(",")}]`);
  }
  if (!isPlainRecord(value)) {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name;
    return invalid(`${path}: prepared data contains unsupported ${name ?? "object"} instance`);
  }
  const fields: { readonly spelled: string; readonly text: string }[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      return invalid(`${path}: property ${String(key)} must be a data property`);
    }
    if (typeof key === "symbol") {
      if (key !== IR_CLASS_SHAPE_CELL) return invalid(`${path}: unsupported symbol property ${String(key)}`);
      if (descriptor.value !== true) return invalid(`${path}: IR_CLASS_SHAPE_CELL must be exactly true`);
      fields.push({ spelled: KEY_CLASS_SHAPE_CELL, text: "true" });
      continue;
    }
    fields.push({
      spelled: key.startsWith("$") ? `$${key}` : key,
      text: encodeValue(descriptor.value, `${path}.${key}`, next),
    });
  }
  fields.sort((left, right) => compareKeys(left.spelled, right.spelled));
  return `{${fields.map((field) => `${quote(field.spelled)}:${field.text}`).join(",")}}`;
}

/**
 * Canonical bytes for one program. The program is shape-checked first so the
 * codec never publishes a value a consumer would refuse on structure alone.
 */
export function encodePreparedIrProgram(program: PreparedIrProgram): string {
  assertPreparedIrProgramShape(program);
  return `{"codec":${quote(PREPARED_IR_PROGRAM_CODEC)},"program":${encodeValue(program, "program", new Set())},"schema":${quote(PREPARED_IR_PROGRAM_SCHEMA)}}`;
}

// ---------------------------------------------------------------------------
// Decoding — rebuilds the data model, then proves canonical bytes by re-encoding
// ---------------------------------------------------------------------------

type ShapeScope = ReadonlyMap<string, object>;

const TAGS = new Set([TAG_NUMBER, TAG_BIGINT, TAG_UNDEFINED, TAG_HOLE, TAG_MAP, TAG_SET, TAG_CLASS_SHAPE_REF]);

/** Sentinel returned by `decodeValue` for an array hole; never escapes `decodeValue`. */
const HOLE: unique symbol = Symbol("program-codec.hole");

function decodeTagged(tag: string, payload: unknown, path: string, shapes: ShapeScope): unknown {
  switch (tag) {
    case TAG_NUMBER: {
      const special = typeof payload === "string" && SPECIAL_NUMBERS.find(([spelling]) => spelling === payload);
      if (!special)
        return invalid(`${path}: ${TAG_NUMBER} payload must be one of ${SPECIAL_NUMBERS.map(([s]) => s).join(", ")}`);
      return special[1];
    }
    case TAG_BIGINT: {
      if (typeof payload !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(payload) || payload === "-0") {
        return invalid(`${path}: ${TAG_BIGINT} payload must be a canonical decimal integer`);
      }
      return BigInt(payload);
    }
    case TAG_UNDEFINED:
      if (payload !== true) return invalid(`${path}: ${TAG_UNDEFINED} payload must be true`);
      return undefined;
    case TAG_HOLE:
      if (payload !== true) return invalid(`${path}: ${TAG_HOLE} payload must be true`);
      return HOLE;
    case TAG_MAP: {
      if (!Array.isArray(payload)) return invalid(`${path}: ${TAG_MAP} payload must be an entry array`);
      const map = new Map<unknown, unknown>();
      payload.forEach((entry, index) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return invalid(`${path}: ${TAG_MAP} entry ${index} must be a [key, value] pair`);
        }
        const key = decodeValue(entry[0], `${path}<key ${index}>`, shapes);
        if (key === HOLE) return invalid(`${path}: ${TAG_MAP} key ${index} cannot be a hole`);
        if (map.has(key)) return invalid(`${path}: ${TAG_MAP} repeats key ${String(key)}`);
        const item = decodeValue(entry[1], `${path}<value ${index}>`, shapes);
        if (item === HOLE) return invalid(`${path}: ${TAG_MAP} value ${index} cannot be a hole`);
        map.set(key, item);
      });
      return map;
    }
    case TAG_SET: {
      if (!Array.isArray(payload)) return invalid(`${path}: ${TAG_SET} payload must be an item array`);
      const set = new Set<unknown>();
      payload.forEach((item, index) => {
        const decoded = decodeValue(item, `${path}<item ${index}>`, shapes);
        if (decoded === HOLE) return invalid(`${path}: ${TAG_SET} item ${index} cannot be a hole`);
        if (set.has(decoded)) return invalid(`${path}: ${TAG_SET} repeats item ${String(decoded)}`);
        set.add(decoded);
      });
      return set;
    }
    case TAG_CLASS_SHAPE_REF: {
      if (typeof payload !== "string") return invalid(`${path}: ${TAG_CLASS_SHAPE_REF} payload must be a class id`);
      const shape = shapes.get(payload);
      if (!shape) return invalid(`${path}: ${TAG_CLASS_SHAPE_REF} ${payload} does not name an enclosing class shape`);
      return shape;
    }
    default:
      return invalid(`${path}: unknown codec tag ${tag}`);
  }
}

function define(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function decodeValue(node: unknown, path: string, shapes: ShapeScope): unknown {
  if (node === null || typeof node === "string" || typeof node === "boolean") return node;
  if (typeof node === "number") {
    if (Object.is(node, -0)) return invalid(`${path}: -0 must be spelled through ${TAG_NUMBER}`);
    if (!Number.isFinite(node)) return invalid(`${path}: non-finite number is not canonical JSON`);
    return node;
  }
  if (typeof node !== "object") return invalid(`${path}: unsupported JSON value type ${typeof node}`);
  if (Array.isArray(node)) {
    const array: unknown[] = new Array(node.length);
    node.forEach((item, index) => {
      const decoded = decodeValue(item, `${path}[${index}]`, shapes);
      if (decoded !== HOLE) define(array, index, decoded);
    });
    return array;
  }
  const keys = Object.keys(node);
  if (keys.length === 1 && TAGS.has(keys[0]!)) {
    return decodeTagged(keys[0]!, (node as Record<string, unknown>)[keys[0]!], path, shapes);
  }
  const record: Record<PropertyKey, unknown> = Object.create(null);
  let branded = false;
  const fields: { readonly spelled: string; readonly key: string }[] = [];
  for (const spelled of keys) {
    if (spelled === KEY_CLASS_SHAPE_CELL) {
      if ((node as Record<string, unknown>)[spelled] !== true) {
        return invalid(`${path}: ${KEY_CLASS_SHAPE_CELL} must be exactly true`);
      }
      define(record, IR_CLASS_SHAPE_CELL, true);
      branded = true;
      continue;
    }
    if (spelled.startsWith("$")) {
      if (!spelled.startsWith("$$")) return invalid(`${path}: unknown codec tag ${spelled} inside a record`);
      fields.push({ spelled, key: spelled.slice(1) });
      continue;
    }
    fields.push({ spelled, key: spelled });
  }
  // A recursive class shape must be reachable by its own `$classShapeRef`
  // while its fields are still being decoded, so register it before descending.
  let scope = shapes;
  if (branded) {
    const classId = (node as Record<string, unknown>).classId;
    if (typeof classId !== "string" || !classId.startsWith("ir-class:v1:")) {
      return invalid(`${path}: a branded class shape must carry an ir-class:v1 classId`);
    }
    if (shapes.has(classId)) return invalid(`${path}: class shape ${classId} is nested inside itself twice`);
    scope = new Map(shapes).set(classId, record);
  }
  for (const { spelled, key } of fields) {
    const decoded = decodeValue((node as Record<string, unknown>)[spelled], `${path}.${key}`, scope);
    if (decoded === HOLE) return invalid(`${path}.${key}: a record field cannot be a hole`);
    define(record, key, decoded);
  }
  if (branded && !isRecursiveIrClassShape(record)) {
    return invalid(`${path}: ${KEY_CLASS_SHAPE_CELL} is only valid on an exact IR class shape`);
  }
  return record;
}

function parseEnvelope(text: string): unknown {
  if (typeof text !== "string") return invalid("encoded program must be a string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid(`encoded program is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("encoded program must be a JSON object");
  }
  const envelope = parsed as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope);
  if (envelopeKeys.join(",") !== "codec,program,schema") {
    return invalid(
      `encoded program envelope must be exactly {codec, program, schema}, got {${envelopeKeys.join(", ")}}`,
    );
  }
  if (envelope.codec !== PREPARED_IR_PROGRAM_CODEC) {
    return invalid(`unsupported codec ${String(envelope.codec)}; expected ${PREPARED_IR_PROGRAM_CODEC}`);
  }
  if (envelope.schema !== PREPARED_IR_PROGRAM_SCHEMA) {
    return invalid(`unsupported schema ${String(envelope.schema)}; expected ${PREPARED_IR_PROGRAM_SCHEMA}`);
  }
  return envelope.program;
}

/**
 * Bytes → persisted program DATA. Every persisted claim is preserved exactly
 * (including runtime projections), the value is frozen through A's copier and
 * shape-checked, and the bytes are proven canonical by re-encoding. The result
 * is NOT re-authenticated: its runtime joins are clones without producer
 * authority and A's complete validator has not run. Use
 * `decodePreparedIrProgram` for anything a backend may consume.
 */
export function decodePreparedIrProgramData(text: string): PreparedIrProgram {
  const decoded = freezePreparedIrValue(decodeValue(parseEnvelope(text), "program", new Map()));
  assertPreparedIrProgramShape(decoded);
  const reencoded = encodePreparedIrProgram(decoded);
  if (reencoded !== text) {
    const at = firstDifference(text, reencoded);
    return invalid(`encoded program is not canonical (first difference at byte ${at}); refusing non-canonical input`);
  }
  return decoded;
}

function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) if (left[index] !== right[index]) return index;
  return limit;
}

/**
 * Regenerate every persisted backend/target projection through the pure
 * runtime producer, refuse any field-level contradiction with the persisted
 * claims, and return the program carrying the regenerated (authenticated)
 * joins in place of the persisted clones. A's complete validator runs last.
 */
export function reauthenticatePreparedIrProgram(persisted: PreparedIrProgram): PreparedIrProgram {
  assertPreparedIrProgramShape(persisted);
  const demands = new Map(persisted.ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)]));
  const runtime: PreparedIrProgramRuntimeProjection[] = [];
  for (const projection of persisted.runtime) {
    const key = `${projection.backend}:${projection.target}`;
    const regenerated = prepareWholeProgramRuntimeManifest({
      inventory: persisted.inventory,
      ir: persisted.ir,
      derivedUnits: persisted.derivedUnits,
      abi: preparedIrDraftAbiLookup(persisted.abi.entries),
      policy: projection.prepared.manifest.policy,
      demands,
    });
    if (regenerated.kind !== "prepared") {
      return invalid(
        `persisted runtime projection ${key} cannot be regenerated: ${regenerated.kind} ${regenerated.detail}`,
      );
    }
    const mismatch = preparedIrDataMismatch(regenerated.runtime, projection.prepared);
    if (mismatch !== undefined) {
      return invalid(`persisted runtime projection ${key} contradicts the regenerated runtime at ${mismatch}`);
    }
    if (
      regenerated.runtime.manifest.policy.backend !== projection.backend ||
      regenerated.runtime.manifest.policy.target !== projection.target
    ) {
      return invalid(`persisted runtime projection ${key} contradicts its own frozen policy`);
    }
    freezePreparedIrRuntimeValue(regenerated.runtime);
    runtime.push(
      Object.freeze({ backend: projection.backend, target: projection.target, prepared: regenerated.runtime }),
    );
  }
  const program: PreparedIrProgram = Object.freeze({
    schema: persisted.schema,
    inventory: persisted.inventory,
    units: persisted.units,
    ir: persisted.ir,
    abi: persisted.abi,
    derivedUnits: persisted.derivedUnits,
    startup: persisted.startup,
    allocations: persisted.allocations,
    runtime: Object.freeze(runtime),
    reconciliation: persisted.reconciliation,
    sealed: persisted.sealed,
  });
  assertPreparedIrProgram(program);
  return program;
}

/**
 * Bytes → complete, re-authenticated, validated program. This is the only
 * decode a backend consumer may accept.
 */
export function decodePreparedIrProgram(text: string): PreparedIrProgram {
  return reauthenticatePreparedIrProgram(decodePreparedIrProgramData(text));
}

/** Content fingerprint of canonical bytes (FNV-1a-64; identity aid, not a security hash). */
export function digestEncodedPreparedIrProgram(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${PREPARED_IR_PROGRAM_CODEC}:${hash.toString(16).padStart(16, "0")}`;
}

// ---------------------------------------------------------------------------
// Structural shape check shared by encode, decode and the backend consumer
// ---------------------------------------------------------------------------

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${path} must be a record`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(`${path} must be an array`);
  return value;
}

function requireMap(value: unknown, path: string): ReadonlyMap<unknown, unknown> {
  if (value === null || typeof value !== "object" || !isReadonlyMapLike(value)) {
    return invalid(`${path} must be a ReadonlyMap`);
  }
  return value;
}

/**
 * Structural contract of `PreparedIrProgram` as published by package A —
 * container kinds, discriminators and the joins a codec must see before it can
 * even address a body. Semantic validation (population, ABI contracts, class
 * layouts, allocations, runtime reproduction) is A's `assertPreparedIrProgram`,
 * which `reauthenticatePreparedIrProgram` and the consumer run afterwards.
 */
export function assertPreparedIrProgramShape(value: unknown): asserts value is PreparedIrProgram {
  const program = requireRecord(value, "program");
  if (program.schema !== PREPARED_IR_PROGRAM_SCHEMA) {
    return invalid(`program.schema must be ${PREPARED_IR_PROGRAM_SCHEMA}, got ${String(program.schema)}`);
  }
  if (program.reconciliation !== "complete") {
    return invalid(`program.reconciliation must be "complete", got ${String(program.reconciliation)}`);
  }
  if (program.sealed !== true) return invalid("program.sealed must be true");

  const inventory = requireRecord(program.inventory, "program.inventory");
  const sources = requireArray(inventory.sources, "program.inventory.sources");
  requireArray(inventory.classes, "program.inventory.classes");
  requireArray(inventory.allUnits, "program.inventory.allUnits");
  const terminals = requireArray(inventory.terminalUnits, "program.inventory.terminalUnits");
  const sourceIds = new Set<string>();
  for (const [index, source] of sources.entries()) {
    const record = requireRecord(source, `program.inventory.sources[${index}]`);
    if (typeof record.id !== "string") return invalid(`program.inventory.sources[${index}].id must be a string`);
    if (sourceIds.has(record.id)) return invalid(`program.inventory.sources repeats ${record.id}`);
    sourceIds.add(record.id);
  }
  const terminalIds = new Set<string>();
  for (const [index, terminal] of terminals.entries()) {
    const record = requireRecord(terminal, `program.inventory.terminalUnits[${index}]`);
    if (typeof record.id !== "string") return invalid(`program.inventory.terminalUnits[${index}].id must be a string`);
    if (record.terminal !== true) return invalid(`program.inventory.terminalUnits[${index}] must be terminal`);
    if (terminalIds.has(record.id)) return invalid(`program.inventory.terminalUnits repeats ${record.id}`);
    if (typeof record.sourceId !== "string" || !sourceIds.has(record.sourceId)) {
      return invalid(`terminal ${record.id} names source ${String(record.sourceId)} absent from the inventory`);
    }
    terminalIds.add(record.id);
  }

  const units = requireMap(program.units, "program.units");
  if (units.size !== terminalIds.size) {
    return invalid(`program.units holds ${units.size} units but the inventory has ${terminalIds.size} terminals`);
  }
  for (const [key, unit] of units) {
    if (typeof key !== "string" || !terminalIds.has(key))
      return invalid(`program.units key ${String(key)} is not a terminal`);
    const record = requireRecord(unit, `program.units[${key}]`);
    if (record.id !== key) return invalid(`program.units[${key}] carries id ${String(record.id)}`);
  }

  const ir = requireRecord(program.ir, "program.ir");
  const functions = requireArray(ir.functions, "program.ir.functions");
  const bodyIds = new Set<string>();
  for (const [index, fn] of functions.entries()) {
    const record = requireRecord(fn, `program.ir.functions[${index}]`);
    if (typeof record.unitId !== "string") return invalid(`program.ir.functions[${index}].unitId must be a string`);
    if (typeof record.name !== "string") return invalid(`program.ir.functions[${index}].name must be a string`);
    if (bodyIds.has(record.unitId)) return invalid(`program.ir.functions repeats body ${record.unitId}`);
    requireArray(record.blocks, `program.ir.functions[${index}].blocks`);
    requireArray(record.params, `program.ir.functions[${index}].params`);
    requireArray(record.resultTypes, `program.ir.functions[${index}].resultTypes`);
    bodyIds.add(record.unitId);
  }

  const abi = requireRecord(program.abi, "program.abi");
  const entries = requireArray(abi.entries, "program.abi.entries");
  const bindingIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const record = requireRecord(entry, `program.abi.entries[${index}]`);
    const plan = requireRecord(record.plan, `program.abi.entries[${index}].plan`);
    if (typeof plan.id !== "string") return invalid(`program.abi.entries[${index}].plan.id must be a string`);
    if (bindingIds.has(plan.id)) return invalid(`program ABI contains duplicate binding IDs (${plan.id})`);
    bindingIds.add(plan.id);
    const contract = requireRecord(record.contract, `program.abi.entries[${index}].contract`);
    if (typeof contract.kind !== "string")
      return invalid(`program.abi.entries[${index}].contract.kind must be a string`);
  }

  const derived = requireArray(program.derivedUnits, "program.derivedUnits");
  for (const [index, record] of derived.entries()) {
    const unit = requireRecord(record, `program.derivedUnits[${index}]`);
    if (typeof unit.id !== "string") return invalid(`program.derivedUnits[${index}].id must be a string`);
  }

  const startup = requireArray(program.startup, "program.startup");
  for (const [index, plan] of startup.entries()) {
    const record = requireRecord(plan, `program.startup[${index}]`);
    if (typeof record.sourceId !== "string" || !sourceIds.has(record.sourceId)) {
      return invalid(`program.startup[${index}] names source ${String(record.sourceId)} absent from the inventory`);
    }
    if (typeof record.executable !== "boolean") return invalid(`program.startup[${index}].executable must be boolean`);
    requireArray(record.evaluations, `program.startup[${index}].evaluations`);
  }

  const allocations = requireRecord(program.allocations, "program.allocations");
  if (typeof allocations.size !== "number") return invalid("program.allocations.size must be a number");
  requireArray(allocations.entries, "program.allocations.entries");
  requireArray(allocations.metadata, "program.allocations.metadata");

  const runtime = requireArray(program.runtime, "program.runtime");
  const projections = new Set<string>();
  for (const [index, projection] of runtime.entries()) {
    const record = requireRecord(projection, `program.runtime[${index}]`);
    if (typeof record.backend !== "string" || typeof record.target !== "string") {
      return invalid(`program.runtime[${index}] must name backend and target`);
    }
    const key = `${record.backend}/${record.target}`;
    if (projections.has(key)) return invalid(`program.runtime repeats projection ${key}`);
    projections.add(key);
    const prepared = requireRecord(record.prepared, `program.runtime[${index}].prepared`);
    requireArray(prepared.functions, `program.runtime[${index}].prepared.functions`);
    const manifest = requireRecord(prepared.manifest, `program.runtime[${index}].prepared.manifest`);
    const policy = requireRecord(manifest.policy, `program.runtime[${index}].prepared.manifest.policy`);
    if (policy.backend !== record.backend || policy.target !== record.target) {
      return invalid(`program.runtime[${index}] frozen policy contradicts its backend/target`);
    }
    requireMap(prepared.providers, `program.runtime[${index}].prepared.providers`);
  }
}
