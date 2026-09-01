// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4617 C1) Frontend-neutral declaration-fact record schema.
 *
 * This module owns ONLY the versioned record vocabulary, its structural
 * validation, canonical ordering, deep freeze, and canonical bytes. It
 * deliberately imports nothing: no TypeScript, no Acorn, no checker, no
 * codegen, no Wasm, and no Node-only hashing API. A consumer of a parsed
 * snapshot never needs a frontend object to decide whether a fact is present,
 * well formed, or canonical.
 *
 * The v1 vocabulary is closed and minimal — exactly the population the
 * standalone `bench_loop` Prepared function-value route consumes:
 *
 *   - one source-qualified query-site reference for an identifier;
 *   - zero or one value-declaration reference;
 *   - the complete ordered declaration-reference population for that binding;
 *   - declaration roles limited to the first-slice shapes.
 *
 * An explicit `null` value declaration and an explicit empty declaration
 * population are valid recorded answers. An ABSENT query record is a missing
 * fact and may never be read as either answer.
 */

/** Schema version. Any other value fails closed; there is no migration yet. */
export const SEMANTIC_DECLARATION_SNAPSHOT_VERSION = "semantic-declaration-snapshot/1";

/** Closed first-slice declaration roles. Source identity, not spelling, is authority. */
export const SEMANTIC_DECLARATION_ROLES = [
  "named-import-specifier",
  "reduction-local-variable",
  "top-level-function",
] as const;

export type SemanticDeclarationRole = (typeof SEMANTIC_DECLARATION_ROLES)[number];

/** A source-qualified half-open range. `sourceId` is the canonical IR source identity. */
export interface SemanticSourceRangeRecord {
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
}

export interface SemanticDeclarationRecord extends SemanticSourceRangeRecord {
  readonly role: SemanticDeclarationRole;
}

export interface SemanticDeclarationQueryRecord {
  readonly site: SemanticSourceRangeRecord;
  readonly valueDeclaration: SemanticDeclarationRecord | null;
  readonly declarations: readonly SemanticDeclarationRecord[];
}

export interface SemanticDeclarationSnapshot {
  readonly version: string;
  readonly queries: readonly SemanticDeclarationQueryRecord[];
}

export type SemanticDeclarationSnapshotErrorCode =
  | "unsupported-version"
  | "malformed-record"
  | "unknown-field"
  | "unknown-role"
  | "invalid-range"
  | "duplicate-query"
  | "duplicate-declaration"
  | "non-canonical-order"
  | "value-declaration-not-in-population"
  | "missing-query"
  | "unresolved-declaration"
  | "ambiguous-declaration"
  | "stale-source"
  | "capture-answer-changed"
  | "unsupported-declaration-role";

/** The one typed missing/invalid-fact failure every consumer must fail closed on. */
export class SemanticDeclarationSnapshotError extends Error {
  constructor(
    readonly code: SemanticDeclarationSnapshotErrorCode,
    message: string,
  ) {
    super(`semantic-declaration-snapshot ${code}: ${message}`);
    this.name = "SemanticDeclarationSnapshotError";
  }
}

const SITE_FIELDS = ["sourceId", "start", "end"] as const;
const DECLARATION_FIELDS = ["sourceId", "start", "end", "role"] as const;
const QUERY_FIELDS = ["site", "valueDeclaration", "declarations"] as const;
const SNAPSHOT_FIELDS = ["version", "queries"] as const;

function fail(code: SemanticDeclarationSnapshotErrorCode, message: string): never {
  throw new SemanticDeclarationSnapshotError(code, message);
}

function requireExactFields(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("malformed-record", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) if (!fields.includes(key)) fail("unknown-field", `${label} carries unknown field ${key}`);
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) fail("malformed-record", `${label} is missing field ${field}`);
  }
  return record;
}

function requireRange(record: Record<string, unknown>, label: string): SemanticSourceRangeRecord {
  const { sourceId, start, end } = record;
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    fail("malformed-record", `${label} must carry a non-empty sourceId`);
  }
  for (const [name, offset] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      fail("invalid-range", `${label} ${name} must be a non-negative safe integer`);
    }
  }
  if ((start as number) >= (end as number)) fail("invalid-range", `${label} start must precede end`);
  return { sourceId, start: start as number, end: end as number };
}

/** Canonical key for one query site; derived only from the neutral fields. */
export function semanticSourceRangeKey(range: SemanticSourceRangeRecord): string {
  return `${range.sourceId}\u0000${range.start}\u0000${range.end}`;
}

/** Canonical key for one declaration reference; derived only from the neutral fields. */
export function semanticDeclarationRecordKey(record: SemanticDeclarationRecord): string {
  return `${semanticSourceRangeKey(record)}\u0000${record.role}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Total order over declaration references: source, then range, then role. */
export function compareSemanticDeclarationRecords(
  left: SemanticDeclarationRecord,
  right: SemanticDeclarationRecord,
): number {
  return (
    compareStrings(left.sourceId, right.sourceId) ||
    left.start - right.start ||
    left.end - right.end ||
    compareStrings(left.role, right.role)
  );
}

function compareQueryRecords(left: SemanticDeclarationQueryRecord, right: SemanticDeclarationQueryRecord): number {
  return (
    compareStrings(left.site.sourceId, right.site.sourceId) ||
    left.site.start - right.site.start ||
    left.site.end - right.site.end
  );
}

function parseDeclaration(value: unknown, label: string): SemanticDeclarationRecord {
  const record = requireExactFields(value, DECLARATION_FIELDS, label);
  const range = requireRange(record, label);
  const role = record.role;
  if (typeof role !== "string" || !(SEMANTIC_DECLARATION_ROLES as readonly string[]).includes(role)) {
    fail("unknown-role", `${label} carries unknown role ${JSON.stringify(role)}`);
  }
  return { ...range, role: role as SemanticDeclarationRole };
}

function parseQuery(value: unknown, index: number): SemanticDeclarationQueryRecord {
  const label = `query[${index}]`;
  const record = requireExactFields(value, QUERY_FIELDS, label);
  const site = requireRange(requireExactFields(record.site, SITE_FIELDS, `${label}.site`), `${label}.site`);
  const valueDeclaration =
    record.valueDeclaration === null ? null : parseDeclaration(record.valueDeclaration, `${label}.valueDeclaration`);
  if (!Array.isArray(record.declarations)) fail("malformed-record", `${label}.declarations must be an array`);
  const declarations = record.declarations.map((entry, position) =>
    parseDeclaration(entry, `${label}.declarations[${position}]`),
  );
  const seen = new Set<string>();
  for (let position = 0; position < declarations.length; position++) {
    const key = semanticDeclarationRecordKey(declarations[position]!);
    if (seen.has(key)) fail("duplicate-declaration", `${label} repeats declaration ${key}`);
    seen.add(key);
    if (position > 0 && compareSemanticDeclarationRecords(declarations[position - 1]!, declarations[position]!) >= 0) {
      fail("non-canonical-order", `${label}.declarations is not in canonical order at ${position}`);
    }
  }
  if (valueDeclaration && !seen.has(semanticDeclarationRecordKey(valueDeclaration))) {
    fail("value-declaration-not-in-population", `${label} value declaration is absent from its declaration population`);
  }
  return { site, valueDeclaration, declarations };
}

function deepFreezeSnapshot(snapshot: SemanticDeclarationSnapshot): SemanticDeclarationSnapshot {
  for (const query of snapshot.queries) {
    Object.freeze(query.site);
    if (query.valueDeclaration) Object.freeze(query.valueDeclaration);
    for (const declaration of query.declarations) Object.freeze(declaration);
    Object.freeze(query.declarations);
    Object.freeze(query);
  }
  Object.freeze(snapshot.queries);
  return Object.freeze(snapshot);
}

/**
 * Structural validation of an untrusted snapshot value. Unknown versions,
 * roles, or fields, malformed or out-of-order populations, duplicate query
 * keys, duplicate declaration references, and a value declaration absent from
 * its own population all fail closed with a typed error.
 */
export function validateSemanticDeclarationSnapshot(value: unknown): SemanticDeclarationSnapshot {
  const record = requireExactFields(value, SNAPSHOT_FIELDS, "snapshot");
  if (record.version !== SEMANTIC_DECLARATION_SNAPSHOT_VERSION) {
    fail("unsupported-version", `snapshot version ${JSON.stringify(record.version)} is not readable`);
  }
  if (!Array.isArray(record.queries)) fail("malformed-record", "snapshot.queries must be an array");
  const queries = record.queries.map((entry, index) => parseQuery(entry, index));
  const seen = new Set<string>();
  for (let index = 0; index < queries.length; index++) {
    const key = semanticSourceRangeKey(queries[index]!.site);
    if (seen.has(key)) fail("duplicate-query", `snapshot repeats query site ${key}`);
    seen.add(key);
    if (index > 0 && compareQueryRecords(queries[index - 1]!, queries[index]!) >= 0) {
      fail("non-canonical-order", `snapshot.queries is not in canonical order at ${index}`);
    }
  }
  return deepFreezeSnapshot({ version: SEMANTIC_DECLARATION_SNAPSHOT_VERSION, queries });
}

/** Sort into canonical order, validate, and deep freeze a produced population. */
export function canonicalizeSemanticDeclarationSnapshot(
  queries: readonly SemanticDeclarationQueryRecord[],
): SemanticDeclarationSnapshot {
  const ordered = [...queries]
    .map((query) => ({
      site: { sourceId: query.site.sourceId, start: query.site.start, end: query.site.end },
      valueDeclaration: query.valueDeclaration ? { ...query.valueDeclaration } : null,
      declarations: [...query.declarations].sort(compareSemanticDeclarationRecords),
    }))
    .sort(compareQueryRecords);
  return validateSemanticDeclarationSnapshot({ version: SEMANTIC_DECLARATION_SNAPSHOT_VERSION, queries: ordered });
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function jsonInteger(value: number): string {
  if (!Number.isSafeInteger(value)) fail("invalid-range", `refusing to serialize non-integer ${value}`);
  return String(value);
}

function serializeRange(range: SemanticSourceRangeRecord): string {
  return `{"sourceId":${jsonString(range.sourceId)},"start":${jsonInteger(range.start)},"end":${jsonInteger(range.end)}}`;
}

function serializeDeclaration(record: SemanticDeclarationRecord): string {
  return `{"sourceId":${jsonString(record.sourceId)},"start":${jsonInteger(record.start)},"end":${jsonInteger(
    record.end,
  )},"role":${jsonString(record.role)}}`;
}

/**
 * Canonical bytes. Object keys and record populations are emitted in a fixed,
 * schema-driven order rather than relying on insertion-order `JSON.stringify`,
 * so parsing and reserializing a valid snapshot reproduces the same bytes.
 */
export function serializeSemanticDeclarationSnapshot(snapshot: SemanticDeclarationSnapshot): string {
  const validated = validateSemanticDeclarationSnapshot(snapshot);
  const queries = validated.queries.map(
    (query) =>
      `{"site":${serializeRange(query.site)},"valueDeclaration":${
        query.valueDeclaration ? serializeDeclaration(query.valueDeclaration) : "null"
      },"declarations":[${query.declarations.map(serializeDeclaration).join(",")}]}`,
  );
  return `{"version":${jsonString(validated.version)},"queries":[${queries.join(",")}]}`;
}

/** Parse canonical bytes back into a validated, frozen snapshot. */
export function parseSemanticDeclarationSnapshot(text: string): SemanticDeclarationSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("malformed-record", `snapshot bytes are not valid JSON: ${String(error)}`);
  }
  return validateSemanticDeclarationSnapshot(parsed);
}
