// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent equation replay. No producer runtime dependency or report authority.
import { type IrFunction, type IrInstr } from "../../../core/nodes.js";
import { copyPreparedIrDataObject, createPreparedIrDataObject } from "../../../../shared/contracts/prepared-ir-data.js";
import { preparedIrDataMismatch } from "../../../../shared/contracts/prepared-ir-data.js";

import type { IrType } from "../../../core/types.js";
import type { IrFuncRef } from "../../../core/value-references.js";

import type {
  NativeJsClassValueDomainInput as Input,
  NativeJsClassValueDomainResult as Result,
  NativeJsClassValueDomainObligation as Obligation,
  NativeJsClassValueDomainHeapCell as Cell,
  NativeJsValueDomain as Domain,
  NativeJsValueRoot as Root,
  NativeJsValueFamily as Family,
  NativeJsClassValueDomainLocation as Location,
} from "./contracts.js";

export type Data = Record<string, unknown>;
class ReplayFailure extends Error {}
export function fail(message: string): never {
  throw new ReplayFailure(message);
}
export function record(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("record required");
  return value as Data;
}
export function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) fail("dense array required");
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail("sparse array");
  return value;
}
export function fields(value: Data, expected: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some((key) => typeof key !== "string" || !expected.includes(key)))
    fail("closed field population");
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("identity required");
  return value;
}
export function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("nonnegative safe integer required");
  return value as number;
}
export interface Occurrence {
  readonly fn: IrFunction;
  readonly blockOrdinal: number;
  readonly nestedPath: readonly number[];
  readonly instructionOrdinal: number;
  readonly instruction: IrInstr;
}
interface Census {
  readonly functions: number;
  readonly instructions: number;
  readonly parameters: number;
  readonly blockArguments: number;
  readonly definitions: number;
  readonly globals: number;
  readonly invokes: number;
  readonly constructs: number;
}
export interface Population {
  readonly nativeReferenceCalls?: ReadonlyMap<IrFunction, ReadonlySet<IrInstr>>;
  readonly occurrences: readonly Occurrence[];
  readonly functions: ReadonlyMap<string, IrFunction>;
  readonly definitions: ReadonlyMap<string, ReadonlySet<number>>;
  readonly census: Census;
}
export const BOTTOM: Domain = Object.freeze({ kind: "bottom" });
export const UNKNOWN: Domain = Object.freeze({ kind: "unknown" });
export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Data)[key])}`)
    .join(",")}}`;
}
export function roots(values: readonly Root[]): readonly Root[] {
  return [...new Map(values.map((root) => [stable(root), root])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, root]) => root);
}
const defineKnownProperty = Reflect.defineProperty;
const mergedCellOwnKeys = Reflect.ownKeys;
export function createReplayLocation(
  unitId: Location["unitId"],
  blockOrdinal: Location["blockOrdinal"],
  nestedPath: Location["nestedPath"],
  instructionOrdinal: Location["instructionOrdinal"],
): Location {
  const fields = [
    ["unitId", unitId],
    ["blockOrdinal", blockOrdinal],
    ["nestedPath", nestedPath],
    ["instructionOrdinal", instructionOrdinal],
  ] as const satisfies readonly { [K in keyof Location]-?: readonly [K, Location[K]] }[keyof Location][];
  const result = createPreparedIrDataObject();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const descriptor = { __proto__: null, value: field[1], writable: true, enumerable: true, configurable: true };
    if (!defineKnownProperty(result, field[0], descriptor)) fail("private replay location definition failed");
  }
  return result as unknown as Location;
}

export function known(families: readonly Family[], candidates: readonly Root[] = []): Domain {
  if (!families.length) return BOTTOM;
  const normalizedFamilies = [...new Set(families)].sort(),
    normalizedRoots = roots(candidates),
    result = createPreparedIrDataObject();
  for (const [key, value] of [
    ["kind", "known"],
    ["families", normalizedFamilies],
    ["roots", normalizedRoots],
  ] as const) {
    const descriptor = { __proto__: null, value, writable: true, enumerable: true, configurable: true };
    if (!defineKnownProperty(result, key, descriptor)) fail("private known property definition failed");
  }
  return result as unknown as Extract<Domain, { kind: "known" }>;
}
export function join(a: Domain, b: Domain): Domain {
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (a.kind === "bottom") return b;
  if (b.kind === "bottom") return a;
  return known([...a.families, ...b.families], [...a.roots, ...b.roots]);
}
export function same(a: unknown, b: unknown): boolean {
  return preparedIrDataMismatch(a, b) === undefined;
}
export function contains(domain: Domain, family: Family): boolean {
  return domain.kind === "known" && domain.families.includes(family);
}
export function numberType(type: IrType): Domain {
  if (type.kind !== "val") return UNKNOWN;
  if (type.val.kind === "i32" && "symbol" in type.val && type.val.symbol === true) return UNKNOWN;
  if (type.val.kind === "i32")
    return known(["boolean" in type.val && type.val.boolean === true ? "Boolean" : "Number"]);
  if (type.val.kind === "f64" || type.val.kind === "f32") return known(["Number"]);
  return UNKNOWN;
}
export function constant(value: unknown, type?: IrType | null): Domain {
  const data = record(value);
  if (data.kind === "undefined") return known(["Undefined"]);
  if (data.kind === "null") return known(["Null"]);
  if (data.kind === "bool") return known(["Boolean"]);
  if (["f64", "f32", "i32"].includes(data.kind as string)) {
    if (typeof data.value !== "number") fail("numeric constant payload");
    if (type?.kind === "val" && type.val.kind === "i32" && "symbol" in type.val && type.val.symbol === true)
      return UNKNOWN;
    return data.kind === "i32" &&
      type?.kind === "val" &&
      type.val.kind === "i32" &&
      "boolean" in type.val &&
      type.val.boolean === true
      ? known(["Boolean"])
      : known(["Number"]);
  }
  return UNKNOWN;
}
export function unitTarget(input: Input, target: IrFuncRef): IrFunction | undefined {
  const unit = input.units.find((row) => same(row.target.binding, target.binding));
  return unit && input.module.functions.find((fn) => fn.unitId === unit.unitId);
}
export type GlobalState = Result["globals"][number];
export type FunctionState = Result["functions"][number];
export type Call = Result["calls"][number];
export type Edge = Result["edges"][number];
export interface World {
  globals: Map<string, GlobalState>;
  heap: Map<string, Cell>;
  roots: Set<string>;
}
export interface Flow extends World {
  alive: boolean;
  values: Map<number, Domain>;
  slots: Map<number, Domain>;
}
export function cellKey(root: Root, key: Cell["key"]): string {
  return `${stable(root)}:${stable(key)}`;
}
export function mergeCell(before: Cell | undefined, after: Cell): Cell {
  if (!before) return after;
  const literal = {
    ...after,
    presence: before.presence === after.presence ? after.presence : "maybe",
    valueDomain: join(before.valueDomain, after.valueDomain),
    prototypeRoots: roots([...before.prototypeRoots, ...after.prototypeRoots]),
  } satisfies Cell;
  const result = createPreparedIrDataObject();
  for (const key of mergedCellOwnKeys(literal)) {
    const descriptor = {
      __proto__: null,
      value: (literal as unknown as Record<PropertyKey, unknown>)[key],
      writable: true,
      enumerable: true,
      configurable: true,
    };
    if (!defineKnownProperty(result, key, descriptor)) fail("private merged cell definition failed");
  }
  return result as unknown as Cell;
}
export function storeCell(
  flow: Flow,
  root: Root,
  key: Cell["key"],
  domain: Domain,
  presence: Cell["presence"] = "present",
  prototypes: readonly Root[] = [],
): void {
  const id = cellKey(root, key),
    next: Cell = copyPreparedIrDataObject({
      root,
      key,
      presence,
      valueDomain: domain,
      prototypeRoots: prototypes,
    } satisfies Cell) as unknown as Cell;
  flow.heap.set(id, mergeCell(flow.heap.get(id), next));
}
export function mergeGlobal(before: GlobalState | undefined, after: GlobalState): GlobalState {
  if (!before) return after;
  const bindingId = after.bindingId,
    initialization = before.initialization === after.initialization ? after.initialization : "maybe",
    domain = join(before.domain, after.domain),
    result = createPreparedIrDataObject();
  for (const [key, value] of [
    ["bindingId", bindingId],
    ["initialization", initialization],
    ["domain", domain],
  ] as const) {
    const descriptor = { __proto__: null, value, writable: true, enumerable: true, configurable: true };
    if (!defineKnownProperty(result, key, descriptor)) fail("private merged global definition failed");
  }
  return result as unknown as GlobalState;
}
export function cloneFlow(flow: Flow): Flow {
  return { ...cloneWorld(flow), alive: flow.alive, values: new Map(flow.values), slots: new Map(flow.slots) };
}
export function cloneWorld(world: World): World {
  return { globals: new Map(world.globals), heap: new Map(world.heap), roots: new Set(world.roots) };
}
function absentCell(cell: Cell): Cell {
  return copyPreparedIrDataObject({
    ...cell,
    presence: "absent",
    valueDomain: BOTTOM,
  } satisfies Cell) as unknown as Cell;
}
/** Missing objects are not missing properties of an object that actually exists. */
export function joinWorld(a: World, b: World): World {
  const out = cloneWorld(a);
  for (const [id, state] of b.globals) out.globals.set(id, mergeGlobal(out.globals.get(id), state));
  for (const id of new Set([...a.heap.keys(), ...b.heap.keys()])) {
    const left = a.heap.get(id),
      right = b.heap.get(id);
    if (left && right) out.heap.set(id, mergeCell(left, right));
    else if (right) out.heap.set(id, a.roots.has(stable(right.root)) ? mergeCell(absentCell(right), right) : right);
    else if (left && b.roots.has(stable(left.root))) out.heap.set(id, mergeCell(left, absentCell(left)));
  }
  for (const root of b.roots) out.roots.add(root);
  return out;
}
export function worldData(world: World): unknown {
  return copyPreparedIrDataObject({
    globals: [...world.globals].sort(([a], [b]) => a.localeCompare(b)),
    heap: [...world.heap].sort(([a], [b]) => a.localeCompare(b)),
    roots: [...world.roots].sort(),
  });
}
export function combineFlow(a: Flow, b: Flow): Flow {
  if (!a.alive) return cloneFlow(b);
  if (!b.alive) return cloneFlow(a);
  const out = cloneFlow(a);
  for (const [key, value] of b.values) out.values.set(key, join(out.values.get(key) ?? BOTTOM, value));
  for (const [key, value] of b.slots) out.slots.set(key, join(out.slots.get(key) ?? BOTTOM, value));
  Object.assign(out, joinWorld(a, b));
  return out;
}
export function flowData(flow: Flow): unknown {
  return copyPreparedIrDataObject({
    alive: flow.alive,
    values: [...flow.values].sort(([a], [b]) => a - b),
    slots: [...flow.slots].sort(([a], [b]) => a - b),
    world: worldData(flow),
  });
}
export function cycleBlocks(fn: IrFunction): ReadonlySet<number> {
  const active: number[] = [],
    done = new Set<number>(),
    cycles = new Set<number>();
  const visit = (index: number) => {
    const loopStart = active.indexOf(index);
    if (loopStart >= 0) {
      for (const member of active.slice(loopStart)) cycles.add(member);
      return;
    }
    if (done.has(index)) return;
    active.push(index);
    const end = fn.blocks[index]!.terminator,
      branches = end.kind === "br" ? [end.branch] : end.kind === "br_if" ? [end.ifTrue, end.ifFalse] : [];
    for (const branch of branches) visit(fn.blocks.findIndex((block) => block.id === branch.target));
    active.pop();
    done.add(index);
  };
  for (let index = 0; index < fn.blocks.length; index++) visit(index);
  return cycles;
}

/** Only observed data properties or a complete null-ended prototype walk close a write. */
export function propertyWriteIsClosed(world: World, receiver: Domain, key: Cell["key"]): boolean {
  if (
    key.kind !== "literal" ||
    receiver.kind !== "known" ||
    !receiver.roots.length ||
    receiver.families.some((family) => family !== "Object" && family !== "Function")
  )
    return false;
  const visit = (root: Root, seen: ReadonlySet<string>): boolean => {
    const id = stable(root);
    if (root.kind === "external" || seen.has(id)) return false;
    const own = world.heap.get(cellKey(root, key));
    if (own?.presence === "present") return !(root.view === "constructor" && key.value === "prototype");
    if (own?.presence === "maybe") return false;
    const link = world.heap.get(cellKey(root, { kind: "internal", value: "prototype" }));
    if (!link || link.valueDomain.kind === "unknown") return false;
    const next = new Set(seen);
    next.add(id);
    return link.prototypeRoots.every((prototype) => visit(prototype, next));
  };
  return receiver.roots.every((root) => visit(root, new Set()));
}

/** Derive projection readiness only from this replay's computed summaries and complete edges. */
export function projectNativeJsClassValueDomains(
  input: Input,
  summaries: ReadonlyMap<string, FunctionState>,
  edges: readonly Edge[],
  obligations: readonly Obligation[],
): Pick<Result, "projections" | "obligations"> {
  const base = [...obligations],
    derived: Obligation[] = [];
  const projections: Result["projections"][number][] = input.exports
    .map((row) => {
      const fn = unitTarget(input, row.target)!,
        summary = summaries.get(fn.unitId)!;
      const normalDomain = !summary.normalCompletion
        ? BOTTOM
        : summary.normalResultDomains.length === 1
          ? summary.normalResultDomains[0]!
          : summary.normalResultDomains.length === 0
            ? known(["Undefined"])
            : UNKNOWN;
      let decision: Result["projections"][number]["decision"] = "unknown";
      if (normalDomain.kind === "known")
        decision =
          normalDomain.families.length !== 1
            ? "dynamic-required"
            : normalDomain.families[0] === "Number"
              ? "number"
              : normalDomain.families[0] === "Boolean"
                ? "boolean"
                : normalDomain.families[0] === "Undefined"
                  ? "void-undefined"
                  : "dynamic-required";
      const dependencies = projectionDependencies(input, edges, fn.unitId),
        pending = base.filter((obligation) => obligation.unitId !== null && dependencies.has(obligation.unitId));
      if (pending.length) decision = "unknown";
      if (normalDomain.kind === "unknown" || normalDomain.kind === "bottom") {
        const unresolved: Obligation = { location: null, unitId: fn.unitId, reason: "unsafe-scalar-projection" };
        pending.push(unresolved);
        derived.push(unresolved);
      }
      return { externalName: row.externalName, target: row.target, normalDomain, decision, obligations: pending };
    })
    .sort((a, b) => a.externalName.localeCompare(b.externalName));
  return {
    projections,
    obligations: [...new Map([...base, ...derived].map((row) => [stable(row), row])).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row),
  };
}
function projectionDependencies(input: Input, edges: readonly Edge[], unit: string): Set<string> {
  const dependencies = new Set([unit, ...input.startupUnits]);
  let changed: boolean;
  do {
    changed = false;
    for (const edge of edges)
      if (edge.kind === "call" && dependencies.has(edge.fromUnitId) && !dependencies.has(edge.toUnitId)) {
        dependencies.add(edge.toUnitId);
        changed = true;
      }
  } while (changed);
  return dependencies;
}

/** Executable phase state is private and never supplied as a proof or caller label. */
export interface ReplayModel {
  readonly input: Input;
  readonly population: Population;
  readonly phase: "startup" | "public";
  projectionSummaries?: ReadonlyMap<string, FunctionState>;
  readonly baseline: World | undefined;
  history: World | undefined;
  readonly parameters: Map<string, Domain[]>;
  readonly reachable: Set<string>;
  readonly summaries: Map<string, FunctionState>;
  readonly retained: Map<string, readonly Root[]>;
  readonly thrown: Map<string, readonly Root[]>;
  readonly values: Map<string, Domain>;
  readonly globals: Map<string, GlobalState>;
  readonly heap: Map<string, Cell>;
  readonly observedRoots: Set<string>;
  readonly initialWorld: World;
  readonly entryWorlds: Map<string, World>;
  readonly normalWorlds: Map<string, World>;
  readonly abruptWorlds: Map<string, World>;
  readonly cyclicBlocks: Map<string, ReadonlySet<number>>;
  readonly calls: Map<string, Call>;
  readonly edges: Map<string, Edge>;
  readonly obligations: Map<string, Obligation>;
  readonly completions: Set<string>;
  changed: boolean;
}
// These comparers consume only closed solver-owned state, never caller DATA or reports.
function privateFields<T>(fields: Record<keyof T, boolean>): boolean {
  return Object.values(fields).every((equal) => equal === true);
}
function privateSequence<T>(a: readonly T[], b: readonly T[], equal: (a: T, b: T) => boolean): boolean {
  return a.length === b.length && a.every((value, index) => equal(value, b[index]!));
}
function privateRoot(a: Root, b: Root): boolean {
  switch (a.kind) {
    case "external":
      return (
        b.kind === "external" &&
        privateFields<typeof a>({
          kind: Object.is(a.kind, b.kind),
          bindingId: Object.is(a.bindingId, b.bindingId),
        })
      );
    case "allocation":
      return (
        b.kind === "allocation" &&
        privateFields<typeof a>({
          kind: Object.is(a.kind, b.kind),
          unitId: Object.is(a.unitId, b.unitId),
          site: Object.is(a.site, b.site),
          definitionId: Object.is(a.definitionId, b.definitionId),
          view: Object.is(a.view, b.view),
          memberOrdinal: Object.is(a.memberOrdinal, b.memberOrdinal),
        })
      );
    default: {
      const exhaustive: never = a;
      return fail("unhandled private state: " + typeof exhaustive);
    }
  }
}
function privateDomain(a: Domain, b: Domain): boolean {
  switch (a.kind) {
    case "bottom":
    case "unknown":
      return privateFields<typeof a>({ kind: Object.is(a.kind, b.kind) });
    case "known":
      return (
        b.kind === "known" &&
        privateFields<typeof a>({
          kind: Object.is(a.kind, b.kind),
          families: privateSequence(a.families, b.families, Object.is),
          roots: privateSequence(a.roots, b.roots, privateRoot),
        })
      );
    default: {
      const exhaustive: never = a;
      return fail("unhandled private state: " + typeof exhaustive);
    }
  }
}
function privateKey(a: Cell["key"], b: Cell["key"]): boolean {
  switch (a.kind) {
    case "wildcard":
      return privateFields<typeof a>({ kind: Object.is(a.kind, b.kind) });
    case "literal":
    case "internal":
      return (
        b.kind === a.kind &&
        privateFields<typeof a>({
          kind: Object.is(a.kind, b.kind),
          value: Object.is(a.value, b.value),
        })
      );
    default: {
      const exhaustive: never = a;
      return fail("unhandled private state: " + typeof exhaustive);
    }
  }
}
function privateCell(a: Cell, b: Cell): boolean {
  return privateFields<Cell>({
    root: privateRoot(a.root, b.root),
    key: privateKey(a.key, b.key),
    presence: Object.is(a.presence, b.presence),
    valueDomain: privateDomain(a.valueDomain, b.valueDomain),
    prototypeRoots: privateSequence(a.prototypeRoots, b.prototypeRoots, privateRoot),
  });
}
function privateGlobal(a: GlobalState, b: GlobalState): boolean {
  return privateFields<GlobalState>({
    bindingId: Object.is(a.bindingId, b.bindingId),
    initialization: Object.is(a.initialization, b.initialization),
    domain: privateDomain(a.domain, b.domain),
  });
}
function samePrivateWorld(a: World, b: World): boolean {
  const globalsA = [...a.globals].sort(([x], [y]) => x.localeCompare(y)),
    globalsB = [...b.globals].sort(([x], [y]) => x.localeCompare(y)),
    heapA = [...a.heap].sort(([x], [y]) => x.localeCompare(y)),
    heapB = [...b.heap].sort(([x], [y]) => x.localeCompare(y));
  return privateFields<World>({
    globals:
      a.globals.size === b.globals.size &&
      privateSequence(
        globalsA,
        globalsB,
        ([keyA, valueA], [keyB, valueB]) => Object.is(keyA, keyB) && privateGlobal(valueA, valueB),
      ),
    heap:
      a.heap.size === b.heap.size &&
      privateSequence(
        heapA,
        heapB,
        ([keyA, valueA], [keyB, valueB]) => Object.is(keyA, keyB) && privateCell(valueA, valueB),
      ),
    roots: a.roots.size === b.roots.size && privateSequence([...a.roots].sort(), [...b.roots].sort(), Object.is),
  });
}
/** Scalar encoding for closed solver roots only; this computation never validates caller DATA. */
export function privateGateRootKey(root: Root): string {
  switch (root.kind) {
    case "allocation": {
      const fragments: Record<keyof typeof root, string> = {
        definitionId: `${JSON.stringify("definitionId")}:${stable(root.definitionId)}`,
        kind: `${JSON.stringify("kind")}:${stable(root.kind)}`,
        memberOrdinal: `${JSON.stringify("memberOrdinal")}:${stable(root.memberOrdinal)}`,
        site: `${JSON.stringify("site")}:${stable(root.site)}`,
        unitId: `${JSON.stringify("unitId")}:${stable(root.unitId)}`,
        view: `${JSON.stringify("view")}:${stable(root.view)}`,
      };
      return `{${Object.values(fragments).join(",")}}`;
    }
    case "external": {
      const fragments: Record<keyof typeof root, string> = {
        bindingId: `${JSON.stringify("bindingId")}:${stable(root.bindingId)}`,
        kind: `${JSON.stringify("kind")}:${stable(root.kind)}`,
      };
      return `{${Object.values(fragments).join(",")}}`;
    }
    default: {
      const exhaustive: never = root;
      return fail("unhandled private root: " + typeof exhaustive);
    }
  }
}
function normalizedPrivateRoots(values: readonly Root[]): boolean {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const root of values) {
    if (root.kind !== "allocation" && root.kind !== "external") return false;
    const key = privateGateRootKey(root);
    if (seen.has(key) || (previous !== undefined && previous.localeCompare(key) > 0)) return false;
    seen.add(key);
    previous = key;
  }
  return true;
}
function normalizedPrivateDomain(domain: Domain): boolean {
  switch (domain.kind) {
    case "bottom":
    case "unknown":
      return true;
    case "known":
      return (
        domain.families.length > 0 &&
        domain.families.every(
          (family, index) => typeof family === "string" && (index === 0 || domain.families[index - 1]! < family),
        ) &&
        normalizedPrivateRoots(domain.roots)
      );
    default: {
      const exhaustive: never = domain;
      void exhaustive;
      return false;
    }
  }
}
function privateRootsAbsorb(before: readonly Root[], incoming: readonly Root[]): boolean {
  const indexed = new Map(before.map((root) => [privateGateRootKey(root), root]));
  return incoming.every((root) => {
    const key = privateGateRootKey(root);
    return indexed.has(key) && privateRoot(indexed.get(key)!, root);
  });
}
function privateDomainAbsorbs(before: Domain, incoming: Domain): boolean {
  if (!normalizedPrivateDomain(incoming)) return false;
  switch (before.kind) {
    case "unknown":
      return privateFields<typeof before>({ kind: true });
    case "bottom":
      return privateFields<typeof before>({ kind: incoming.kind === "bottom" });
    case "known":
      if (incoming.kind === "bottom") return true;
      return (
        incoming.kind === "known" &&
        privateFields<typeof before>({
          kind: true,
          families: incoming.families.every((family) => before.families.includes(family)),
          roots: privateRootsAbsorb(before.roots, incoming.roots),
        })
      );
    default: {
      const exhaustive: never = before;
      void exhaustive;
      return false;
    }
  }
}
function privateGlobalAbsorbs(before: GlobalState, incoming: GlobalState): boolean {
  return privateFields<GlobalState>({
    bindingId: Object.is(before.bindingId, incoming.bindingId),
    initialization: before.initialization === incoming.initialization || before.initialization === "maybe",
    domain: privateDomainAbsorbs(before.domain, incoming.domain),
  });
}
function privateCellAbsorbs(before: Cell, incoming: Cell): boolean {
  return privateFields<Cell>({
    root: privateRoot(before.root, incoming.root),
    key: privateKey(before.key, incoming.key),
    presence: before.presence === incoming.presence || before.presence === "maybe",
    valueDomain: privateDomainAbsorbs(before.valueDomain, incoming.valueDomain),
    prototypeRoots: privateRootsAbsorb(before.prototypeRoots, incoming.prototypeRoots),
  });
}
/** Computational absorption for private observations, never input validation or stored authority. */
export function canOmitNormalizedWorldJoin(before: World, incoming: World): boolean {
  if (
    ![...before.globals.values()].every((global) => normalizedPrivateDomain(global.domain)) ||
    ![...before.heap.values()].every(
      (cell) => normalizedPrivateDomain(cell.valueDomain) && normalizedPrivateRoots(cell.prototypeRoots),
    )
  )
    return false;
  return privateFields<World>({
    globals: [...incoming.globals].every(
      ([key, value]) => before.globals.has(key) && privateGlobalAbsorbs(before.globals.get(key)!, value),
    ),
    heap:
      [...incoming.heap].every(
        ([key, value]) => before.heap.has(key) && privateCellAbsorbs(before.heap.get(key)!, value),
      ) &&
      [...before.heap].every(
        ([key, value]) =>
          incoming.heap.has(key) ||
          !incoming.roots.has(stable(value.root)) ||
          value.presence === "absent" ||
          value.presence === "maybe",
      ),
    roots: [...incoming.roots].every((root) => before.roots.has(root)),
  });
}
export function joinUnitWorld(model: ReplayModel, table: Map<string, World>, unit: string, world: World): void {
  const before = table.get(unit),
    after = before ? joinWorld(before, world) : cloneWorld(world);
  if (!before || !samePrivateWorld(before, after)) {
    table.set(unit, after);
    model.changed = true;
  }
}
/** Descriptive observations never become executable phase entries. */
export function commitFlow(model: ReplayModel, flow: World): void {
  const before: World = { globals: model.globals, heap: model.heap, roots: model.observedRoots },
    after = joinWorld(before, flow);
  if (!samePrivateWorld(before, after)) {
    for (const [id, value] of after.globals) model.globals.set(id, value);
    for (const [id, value] of after.heap) model.heap.set(id, value);
    for (const id of after.roots) model.observedRoots.add(id);
    model.changed = true;
  }
}
function aggregateKey(root: Root): string {
  return root.kind === "external" ? stable(root) : stable([root.unitId, root.site, root.definitionId]);
}
/** Publicly retained roots follow real heap edges and views of the same aggregate. */
export function persistentWorld(world: World, baseline: World, seeds: readonly Root[], previous?: World): World {
  const candidates = new Map<string, Root>();
  const remember = (root: Root) => candidates.set(stable(root), root);
  for (const root of seeds) remember(root);
  for (const source of [world, baseline, ...(previous ? [previous] : [])]) {
    for (const global of source.globals.values())
      if (global.domain.kind === "known") global.domain.roots.forEach(remember);
    for (const cell of source.heap.values()) {
      remember(cell.root);
      cell.prototypeRoots.forEach(remember);
      if (cell.valueDomain.kind === "known") cell.valueDomain.roots.forEach(remember);
    }
  }
  const keep = new Set(seeds.map(stable));
  for (const source of [world, baseline])
    for (const global of source.globals.values())
      if (global.domain.kind === "known") for (const root of global.domain.roots) keep.add(stable(root));
  for (const id of previous?.roots ?? []) keep.add(id);
  let changed: boolean;
  do {
    const before = keep.size,
      aggregates = new Set([...keep].flatMap((id) => (candidates.has(id) ? [aggregateKey(candidates.get(id)!)] : [])));
    for (const [id, root] of candidates) if (aggregates.has(aggregateKey(root))) keep.add(id);
    for (const cell of world.heap.values())
      if (keep.has(stable(cell.root))) {
        for (const root of cell.prototypeRoots) keep.add(stable(root));
        if (cell.valueDomain.kind === "known") for (const root of cell.valueDomain.roots) keep.add(stable(root));
      }
    changed = before !== keep.size;
  } while (changed);
  return {
    globals: new Map(world.globals),
    heap: new Map([...world.heap].filter(([, cell]) => keep.has(stable(cell.root)))),
    roots: keep,
  };
}
export function updatePublicHistory(model: ReplayModel): void {
  if (model.phase !== "public" || !model.baseline) return;
  for (const entry of model.input.exports) {
    const unit = unitTarget(model.input, entry.target)!.unitId,
      summary = model.summaries.get(unit)!,
      seeds = roots([...summary.escapedRoots, ...(model.retained.get(unit) ?? []), ...(model.thrown.get(unit) ?? [])]);
    for (const world of [model.normalWorlds.get(unit), model.abruptWorlds.get(unit)]) {
      if (!world) continue;
      const projected = persistentWorld(world, model.baseline, seeds, model.history),
        next = model.history ? joinWorld(model.history, projected) : projected;
      if (!model.history || !samePrivateWorld(model.history, next)) {
        model.history = next;
        model.changed = true;
      }
    }
  }
}
function mergeCalls(a: Call, b: Call): Call {
  const unique = <T>(values: readonly T[]) =>
    [...new Map(values.map((value) => [stable(value), value])).entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([, value]) => value);
  return {
    ...a,
    calleeDomain: join(a.calleeDomain, b.calleeDomain),
    receiverDomain: a.receiverDomain === null ? null : join(a.receiverDomain, b.receiverDomain ?? BOTTOM),
    argumentDomains: a.argumentDomains.map((value, index) => join(value, b.argumentDomains[index]!)),
    targets: unique([...a.targets, ...b.targets]),
    normalDomain: join(a.normalDomain, b.normalDomain),
    mayThrow: a.mayThrow || b.mayThrow,
    obligations: unique([...a.obligations, ...b.obligations]),
  };
}
/** Merge only descriptions after both executable phases have reached their fixed point. */
export function mergePhaseModels(startup: ReplayModel, out: ReplayModel): ReplayModel {
  out.projectionSummaries = new Map(out.summaries);
  for (const [key, value] of startup.values) out.values.set(key, join(value, out.values.get(key) ?? BOTTOM));
  for (const [unit, a] of startup.summaries) {
    const b = out.summaries.get(unit)!;
    out.summaries.set(unit, {
      ...b,
      parameterDomains: a.parameterDomains.map((value, index) => join(value, b.parameterDomains[index]!)),
      normalResultDomains: a.normalResultDomains.map((value, index) => join(value, b.normalResultDomains[index]!)),
      normalCompletion: a.normalCompletion || b.normalCompletion,
      mayThrow: a.mayThrow || b.mayThrow,
      readsGlobals: [...new Set([...a.readsGlobals, ...b.readsGlobals])].sort(),
      writesGlobals: [...new Set([...a.writesGlobals, ...b.writesGlobals])].sort(),
      escapedRoots: roots([...a.escapedRoots, ...b.escapedRoots]),
    });
  }
  for (const [key, value] of startup.calls)
    out.calls.set(key, out.calls.has(key) ? mergeCalls(value, out.calls.get(key)!) : value);
  for (const [key, value] of startup.edges) out.edges.set(key, value);
  for (const [key, value] of startup.obligations) out.obligations.set(key, value);
  commitFlow(out, { globals: startup.globals, heap: startup.heap, roots: startup.observedRoots });
  return out;
}
/** Only family membership is unordered. Duplicate/foreign members still refuse. */
function equationData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(equationData);
  if (value === null || typeof value !== "object") return value;
  const row = record(value),
    copy: Data = createPreparedIrDataObject();
  for (const [key, field] of Object.entries(row)) copy[key] = equationData(field);
  if (row.kind === "known") {
    fields(row, ["kind", "families", "roots"]);
    const families = array(row.families).map(identifier);
    if (
      !families.length ||
      new Set(families).size !== families.length ||
      families.some(
        (family) => !["Undefined", "Null", "Number", "Boolean", "String", "Object", "Function"].includes(family),
      )
    )
      fail("invalid domain family set");
    copy.families = [...families].sort();
  }
  return copy;
}
export function equationSame(a: unknown, b: unknown): boolean {
  return same(equationData(a), equationData(b));
}

/** Reasons at one actual occurrence form a complete canonical, duplicate-free census. */
export function orderedObligations(rows: readonly Obligation[]): readonly Obligation[] {
  return [...new Map(rows.map((row) => [stable(row), row])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
}
