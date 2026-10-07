// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  IrPreparedSourceMap,
  IrSourceMapOrigin,
  IrUnitInventory,
} from "../../shared/contracts/ir-unit-inventory.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { ProgramAbiDerivedUnitRecord } from "./abi.js";
import type { SourcePos } from "../../wasm/model/instructions.js";
import { createDerivedIrUnitId } from "../../shared/contracts/identity-values.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export interface IrSourceMapPositionInput {
  readonly sourceMap: IrPreparedSourceMap;
  readonly inventory: Pick<IrUnitInventory, "sources" | "allUnits">;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
}
export interface IrSourceMapPositionProjector {
  project(ownerUnitId: IrUnitId, origin: IrSourceMapOrigin): SourcePos | null;
}

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "source map position: " + detail);
}

/** Open inventory views inspect only consumed properties; closed data rejects extras. */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  closed = true,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("plain record required");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid("foreign record prototype");
  if (closed) {
    for (const key of Reflect.ownKeys(value))
      if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
        invalid("unknown record field");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of [...required, ...optional]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      if (required.includes(key)) invalid("missing own data field");
      continue;
    }
    if (!("value" in descriptor) || descriptor.value === undefined) invalid("own data field required");
    result[key] = descriptor.value;
  }
  return result;
}

function branch(fields: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(fields))
    if (!required.includes(key) && !optional.includes(key)) invalid("unknown origin field");
  for (const key of required) if (!Object.hasOwn(fields, key)) invalid("missing origin field");
}

/** Reject sparse/extra/accessor arrays before accessing any element value. */
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid("ordinary dense array required");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length: number = Object.getOwnPropertyDescriptor(value, "length")!.value;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1) invalid("sparse or extra-key array");
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) invalid("extra array key");
    if (!("value" in Object.getOwnPropertyDescriptor(descriptors, key)!.value)) invalid("array data indices required");
  }
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) result.push(descriptors[String(i)]!.value);
  return result;
}

function text(value: unknown): string {
  if (typeof value !== "string") invalid("primitive string required");
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!result) invalid("nonempty identity required");
  return result;
}
function owner(value: unknown): string | null {
  return value === null ? null : id(value);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid("nonnegative safe integer required");
  return value === 0 ? 0 : value;
}
function span(value: unknown, length: number): { start: number; end: number } {
  const fields = record(value, ["start", "end"]);
  const start = integer(fields.start);
  const end = integer(fields.end);
  if (start > end || end > length) invalid("span range outside source text");
  return { start, end };
}

interface Source {
  readonly id: string;
  readonly name: string;
  readonly originalLength: number;
  readonly analyzedLength: number;
  readonly lines: readonly number[];
}
interface Unit {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: string;
  readonly lexicalOwnerId: string | null;
  readonly terminalOwnerId: string | null;
  readonly terminal: boolean;
  readonly start: number;
  readonly end: number;
  readonly syntheticRole?: string;
}
interface Derived {
  readonly id: string;
  readonly parentId: string;
  readonly sourceId: string;
  readonly terminalOwnerId: string | null;
  readonly role: string;
  readonly order: number;
}
interface Indexes {
  readonly sources: ReadonlyMap<string, Source>;
  readonly units: ReadonlyMap<string, Unit>;
  readonly derived: ReadonlyMap<string, Derived>;
  readonly grants: ReadonlyMap<string, string>;
}
const UNIT_KINDS = new Set([
  "top-level-function",
  "nested-function",
  "function-expression",
  "arrow-function",
  "class-constructor",
  "class-implicit-constructor",
  "class-instance-method",
  "class-static-method",
  "class-instance-getter",
  "class-static-getter",
  "class-instance-setter",
  "class-static-setter",
  "class-instance-field-initializer",
  "class-static-field-initializer",
  "class-static-block",
  "object-method",
  "object-getter",
  "object-setter",
  "export-assignment",
  "module-init",
  "synthetic-support",
]);

function lineStarts(original: string): number[] {
  const starts = [0];
  for (let i = 0; i < original.length; i++) {
    const code = original.charCodeAt(i);
    if (code === 13) {
      if (original.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (code === 10 || code === 0x2028 || code === 0x2029) starts.push(i + 1);
  }
  return starts;
}

function captureSources(catalog: Record<string, unknown>, inventory: Record<string, unknown>): Map<string, Source> {
  if (catalog.schema !== "prepared-ir-source-map-v1") invalid("unknown source-map schema");
  const sources = array(catalog.sources);
  const actual = array(inventory.sources);
  if (sources.length !== actual.length) invalid("source population count mismatch");
  const result = new Map<string, Source>();
  const names = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    const row = record(sources[i], ["sourceId", "sourceKey", "originalFileName", "mapName", "projection"]);
    const input = record(actual[i], ["id", "sourceKey", "originalFileName"], [], false);
    const sourceId = id(row.sourceId);
    const sourceKey = text(row.sourceKey);
    const name = text(row.mapName);
    const fileName = text(row.originalFileName);
    if (
      sourceId !== id(input.id) ||
      sourceKey !== text(input.sourceKey) ||
      fileName !== text(input.originalFileName) ||
      name !== sourceKey
    )
      invalid("source identity/order/name join mismatch");
    if (result.has(sourceId) || names.has(name)) invalid("duplicate source identity or map name");
    const projection = record(row.projection, ["originalText", "analyzedText", "stages"]);
    const original = text(projection.originalText);
    const analyzed = text(projection.analyzedText);
    array(projection.stages); // Stage payload validity/replay belongs to the preparation owner.
    result.set(sourceId, {
      id: sourceId,
      name,
      originalLength: original.length,
      analyzedLength: analyzed.length,
      lines: lineStarts(original),
    });
    names.add(name);
  }
  return result;
}

function terminalJoin(
  unit: { sourceId: string; terminalOwnerId: string | null },
  units: ReadonlyMap<string, Unit>,
): void {
  if (unit.terminalOwnerId === null) return;
  const terminal = units.get(unit.terminalOwnerId);
  if (!terminal?.terminal || terminal.sourceId !== unit.sourceId) invalid("terminal owner join mismatch");
}

function captureUnits(value: unknown, sources: ReadonlyMap<string, Source>): Map<string, Unit> {
  const units = new Map<string, Unit>();
  for (const item of array(value)) {
    const row = record(
      item,
      ["id", "sourceId", "kind", "lexicalOwnerId", "terminalOwnerId", "terminal", "declarationStart", "declarationEnd"],
      ["syntheticRole"],
      false,
    );
    const unitId = id(row.id);
    const sourceId = id(row.sourceId);
    const source = sources.get(sourceId);
    if (!source || units.has(unitId)) invalid("unknown source or duplicate original unit");
    const kind = text(row.kind);
    if (!UNIT_KINDS.has(kind)) invalid("unknown original unit kind");
    if (typeof row.terminal !== "boolean") invalid("primitive terminal boolean required");
    const start = integer(row.declarationStart);
    const end = integer(row.declarationEnd);
    if (start > end || end > source.analyzedLength) invalid("unit declaration range outside analyzed source");
    const terminalOwnerId = owner(row.terminalOwnerId);
    if (row.terminal && terminalOwnerId !== unitId) invalid("terminal must own itself");
    units.set(unitId, {
      id: unitId,
      sourceId,
      kind,
      lexicalOwnerId: owner(row.lexicalOwnerId),
      terminalOwnerId,
      terminal: row.terminal,
      start,
      end,
      ...(Object.hasOwn(row, "syntheticRole") ? { syntheticRole: id(row.syntheticRole) } : {}),
    });
  }
  for (const unit of units.values()) terminalJoin(unit, units);
  return units;
}

function captureDerived(
  value: unknown,
  sources: ReadonlyMap<string, Source>,
  units: ReadonlyMap<string, Unit>,
): Map<string, Derived> {
  const derived = new Map<string, Derived>();
  for (const item of array(value)) {
    const row = record(item, ["id", "parentId", "terminalOwnerId", "sourceId", "role", "ordinal"]);
    const unitId = id(row.id);
    const parentId = id(row.parentId);
    const sourceId = id(row.sourceId);
    const role = id(row.role);
    const ordinal = integer(row.ordinal);
    let canonical: string;
    try {
      canonical = createDerivedIrUnitId({
        parentId: parentId as IrUnitId,
        role: role as ProgramAbiDerivedUnitRecord["role"],
        ordinal,
      });
    } catch {
      invalid("invalid canonical derived identity");
    }
    if (canonical !== unitId || derived.has(unitId) || units.has(unitId) || !sources.has(sourceId))
      invalid("derived identity/source mismatch");
    const unit = {
      id: unitId,
      parentId,
      sourceId,
      terminalOwnerId: owner(row.terminalOwnerId),
      role,
      order: derived.size,
    };
    terminalJoin(unit, units);
    derived.set(unitId, unit);
  }
  const completed = new Set<string>();
  for (const unit of derived.values()) {
    const pending: string[] = [];
    const active = new Set<string>();
    let current: Derived | undefined = unit;
    while (current && !completed.has(current.id)) {
      if (active.has(current.id)) invalid("derived parent cycle");
      active.add(current.id);
      pending.push(current.id);
      const parent = derived.get(current.parentId) ?? units.get(current.parentId);
      if (!parent || parent.sourceId !== current.sourceId || parent.terminalOwnerId !== current.terminalOwnerId)
        invalid("derived parent ownership mismatch");
      current = derived.get(current.parentId);
    }
    for (const unitId of pending) completed.add(unitId);
  }
  return derived;
}

function ancestry(unitId: string, derived: ReadonlyMap<string, Derived>): Set<string> {
  const result = new Set<string>([unitId]);
  let current = derived.get(unitId);
  while (current) {
    result.add(current.parentId);
    current = derived.get(current.parentId);
  }
  return result;
}

function captureGrants(
  value: unknown,
  units: ReadonlyMap<string, Unit>,
  derived: ReadonlyMap<string, Derived>,
): Map<string, string> {
  const grants = new Map<string, string>();
  const rows = array(value);
  if (!rows.length) invalid("empty derived source table must be omitted");
  let previousOrder = -1;
  const kinds = new Set(["arrow-function", "function-expression", "object-method", "object-getter", "object-setter"]);
  for (const item of rows) {
    const row = record(item, ["unitId", "donorUnitId"]);
    const unitId = id(row.unitId);
    const donorId = id(row.donorUnitId);
    const target = derived.get(unitId);
    const donor = units.get(donorId);
    if (!target || target.role !== "lifted-closure" || !donor || !kinds.has(donor.kind) || grants.has(unitId))
      invalid("derived donor grant identity/role mismatch");
    if (
      target.sourceId !== donor.sourceId ||
      target.terminalOwnerId !== donor.terminalOwnerId ||
      target.order <= previousOrder
    )
      invalid("derived donor source/terminal/order mismatch");
    const ancestors = ancestry(unitId, derived);
    const seen = new Set<string>();
    let lexical = donor.lexicalOwnerId;
    while (lexical !== null && !ancestors.has(lexical)) {
      if (seen.has(lexical)) invalid("donor lexical cycle");
      seen.add(lexical);
      const parent = units.get(lexical);
      if (!parent || parent.sourceId !== donor.sourceId || parent.terminalOwnerId !== donor.terminalOwnerId)
        invalid("donor lexical owner join mismatch");
      lexical = parent.lexicalOwnerId;
    }
    if (lexical === null) invalid("donor lexical chain lacks derived owner join");
    previousOrder = target.order;
    grants.set(unitId, donorId);
  }
  return grants;
}

interface Point {
  readonly source: Source;
  readonly donorId: string;
  readonly start: number;
  readonly key: string;
}
function point(value: unknown, indexes: Indexes): Point {
  const row = record(value, ["sourceId", "donorUnitId", "analyzed", "original", "mapping"]);
  const sourceId = id(row.sourceId);
  const donorId = id(row.donorUnitId);
  const source = indexes.sources.get(sourceId);
  const donor = indexes.units.get(donorId);
  if (!source || !donor || donor.sourceId !== sourceId) invalid("point source/donor join mismatch");
  const analyzed = span(row.analyzed, source.analyzedLength);
  const original = span(row.original, source.originalLength);
  if (
    (analyzed.start < donor.start || analyzed.end > donor.end) &&
    (donor.kind !== "module-init" || analyzed.start === analyzed.end)
  )
    invalid("point escapes donor declaration");
  if (row.mapping !== "exact" && row.mapping !== "rewrite") invalid("unknown point mapping");
  return {
    source,
    donorId,
    start: original.start,
    key: JSON.stringify([sourceId, donorId, analyzed.start, analyzed.end, original.start, original.end, row.mapping]),
  };
}

function chain(value: unknown, primary: Point, indexes: Indexes, donors?: Set<string>): Point[] {
  const rows = array(value);
  if (!rows.length) invalid("empty optional point chain");
  const seen = new Set([primary.key]);
  const points: Point[] = [];
  for (const row of rows) {
    const projected = point(row, indexes);
    if (seen.has(projected.key)) invalid("duplicate causal point");
    seen.add(projected.key);
    if (donors?.has(projected.donorId)) invalid("cyclic inline donor chain");
    donors?.add(projected.donorId);
    points.push(projected);
  }
  return points;
}

function position(primary: Point): SourcePos {
  const starts = primary.source.lines;
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= primary.start) low = middle;
    else high = middle;
  }
  return { file: primary.source.name, line: low, column: primary.start - starts[low]! };
}

const GENERATED_ROLES: Readonly<Record<string, readonly string[]>> = {
  frontend: ["insertion", "implicit-return", "binding-scaffold", "control-scaffold"],
  middleend: ["cfg-scaffold", "representation-scaffold"],
  async: ["state-dispatch", "frame-access", "capability", "continuation"],
  backend: ["control-scaffold", "abi-scaffold"],
};

function project(ownerUnitId: unknown, origin: unknown, indexes: Indexes): SourcePos | null {
  const ownerId = id(ownerUnitId);
  const actual = indexes.units.get(ownerId) ?? indexes.derived.get(ownerId);
  if (!actual) invalid("unknown emitting owner");
  const allowed = ancestry(ownerId, indexes.derived);
  for (const unitId of allowed) {
    const grant = indexes.grants.get(unitId);
    if (grant !== undefined) allowed.add(grant);
  }
  const fields = record(
    origin,
    ["kind"],
    ["point", "inlinedAt", "contributors", "phase", "role", "ownerUnitId", "cause", "bindingId", "sourceIds"],
  );
  if (fields.kind === "source") {
    branch(fields, ["kind", "point"], ["inlinedAt", "contributors"]);
    const primary = point(fields.point, indexes);
    const frames = Object.hasOwn(fields, "inlinedAt")
      ? chain(fields.inlinedAt, primary, indexes, new Set([primary.donorId]))
      : [];
    if (Object.hasOwn(fields, "contributors")) chain(fields.contributors, primary, indexes);
    const outermost = frames.length ? frames[frames.length - 1]! : primary;
    if (!allowed.has(outermost.donorId)) invalid("source donor outside owner ancestry");
    return position(primary);
  }
  if (fields.kind !== "generated") invalid("unknown origin variant");
  if (fields.phase === "support" || fields.phase === "startup")
    invalid("support/startup requires physical ownership issuer");
  branch(fields, ["kind", "phase", "role", "ownerUnitId"], ["cause"]);
  const phase = text(fields.phase);
  const role = text(fields.role);
  if (!Object.hasOwn(GENERATED_ROLES, phase) || !GENERATED_ROLES[phase]!.includes(role))
    invalid("unknown generated phase/role");
  if (id(fields.ownerUnitId) !== ownerId) invalid("generated current owner mismatch");
  if (phase === "frontend" && role === "insertion" && !indexes.units.get(ownerId)?.syntheticRole)
    invalid("insertion lacks original synthetic owner");
  if (Object.hasOwn(fields, "cause") && !allowed.has(point(fields.cause, indexes).donorId))
    invalid("generated cause outside owner ancestry");
  return null;
}

/**
 * Requested-only DATA projection. Actual inventory/IR/ABI, text-stage replay,
 * startup occurrences and async/body coverage remain preparation-owner checks.
 * A returned projector is a detached snapshot, not a current emission capability.
 * Construction scans original text once; each call walks only owner/point chains
 * and binary-searches the primary source's UTF-16 line starts.
 */
export function createIrSourceMapPositionProjector(input: IrSourceMapPositionInput): IrSourceMapPositionProjector {
  const fields = record(input, ["sourceMap", "inventory", "derivedUnits"]);
  const catalog = record(fields.sourceMap, ["schema", "sources"], ["derivedSources"]);
  const inventory = record(fields.inventory, ["sources", "allUnits"], [], false);
  const sources = captureSources(catalog, inventory);
  const units = captureUnits(inventory.allUnits, sources);
  const derived = captureDerived(fields.derivedUnits, sources, units);
  const grants = Object.hasOwn(catalog, "derivedSources")
    ? captureGrants(catalog.derivedSources, units, derived)
    : new Map<string, string>();
  const indexes: Indexes = { sources, units, derived, grants };
  return Object.freeze({
    project: (ownerUnitId: IrUnitId, origin: IrSourceMapOrigin) => project(ownerUnitId, origin, indexes),
  });
}
