// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { signatureKey } from "./producer-private-keys.js";
import type { IrConst, IrValueId } from "../../../core/nodes.js";
import type { IrType } from "../../../core/types.js";
import type { IrBindingId, IrUnitId } from "../../../../shared/contracts/ir-identity.js";
import type { IrJsClassBinding, IrJsClassDefinition, IrJsClassRole } from "../../../core/js-class-contracts.js";
export type * from "./contracts.js";
import type {
  NativeJsValueFamily,
  NativeJsValueRoot,
  NativeJsValueDomain,
  NativeJsClassValueDomainLocation,
  NativeJsClassValueDomainReason,
  NativeJsClassValueDomainObligation,
  NativeJsClassValueDomainInput,
  NativeJsClassValueDomainTarget,
  NativeJsClassValueDomainHeapCell,
  NativeJsClassValueDomainResult,
} from "./contracts.js";
import { forEachNestedBuffer, type IrInstr } from "../../../core/nodes.js";
import { JS_TAG_IDS } from "../../../core/js-value-tag-identities.js";
import {
  nativeJsClassValueDataKey as key,
  freezeNativeJsClassValueData as frozen,
  copyNativeJsClassValueData as ownData,
} from "./data.js";

import {
  indexNativeJsClassValueDomainInput as indexInput,
  type NativeJsClassValueIndexedFunction as IndexedFunction,
} from "./input.js";

const BOTTOM: NativeJsValueDomain = Object.freeze({ kind: "bottom" });
const UNKNOWN: NativeJsValueDomain = Object.freeze({ kind: "unknown" });
const FAMILIES: readonly NativeJsValueFamily[] = [
  "Undefined",
  "Null",
  "Number",
  "Boolean",
  "String",
  "Object",
  "Function",
];
function rootScalarKey(value: string | number | null): string {
  return typeof value === "number" && !Number.isFinite(value) ? `number:${value}` : JSON.stringify(value);
}
function rootKey(root: NativeJsValueRoot): string {
  switch (root.kind) {
    case "allocation": {
      const fields = {
        definitionId: `${rootScalarKey("definitionId")}:${rootScalarKey(root.definitionId)}`,
        kind: `${rootScalarKey("kind")}:${rootScalarKey(root.kind)}`,
        memberOrdinal: `${rootScalarKey("memberOrdinal")}:${rootScalarKey(root.memberOrdinal)}`,
        site: `${rootScalarKey("site")}:${rootScalarKey(root.site)}`,
        unitId: `${rootScalarKey("unitId")}:${rootScalarKey(root.unitId)}`,
        view: `${rootScalarKey("view")}:${rootScalarKey(root.view)}`,
      } satisfies Record<keyof typeof root, string>;
      return `{${fields.definitionId},${fields.kind},${fields.memberOrdinal},${fields.site},${fields.unitId},${fields.view}}`;
    }
    case "external": {
      const fields = {
        bindingId: `${rootScalarKey("bindingId")}:${rootScalarKey(root.bindingId)}`,
        kind: `${rootScalarKey("kind")}:${rootScalarKey(root.kind)}`,
      } satisfies Record<keyof typeof root, string>;
      return `{${fields.bindingId},${fields.kind}}`;
    }
    default: {
      const exhaustive: never = root;
      throw new TypeError("unsupported private root kind: " + typeof exhaustive);
    }
  }
}
export { rootKey as privateProducerRootKey };
function known(
  families: readonly NativeJsValueFamily[],
  roots: readonly NativeJsValueRoot[] = [],
): NativeJsValueDomain {
  const unique = new Map(roots.map((root) => [rootKey(root), root]));
  return {
    kind: "known",
    families: FAMILIES.filter((family) => families.includes(family)),
    roots: [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, root]) => root),
  };
}
function join(a: NativeJsValueDomain, b: NativeJsValueDomain): NativeJsValueDomain {
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (a.kind === "bottom") return b;
  if (b.kind === "bottom") return a;
  return known([...a.families, ...b.families], [...a.roots, ...b.roots]);
}
function constant(value: IrConst): NativeJsValueDomain {
  return value.kind === "undefined"
    ? known(["Undefined"])
    : value.kind === "null"
      ? known(["Null"])
      : value.kind === "bool"
        ? known(["Boolean"])
        : value.kind === "f64" || value.kind === "f32" || value.kind === "i32"
          ? known(["Number"])
          : UNKNOWN;
}
function orderedObligations(
  rows: readonly NativeJsClassValueDomainObligation[],
): readonly NativeJsClassValueDomainObligation[] {
  return [...new Map(rows.map((row) => [key(row), row])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
}
function scalar(type: IrType): NativeJsValueDomain {
  if (type.kind !== "val") return UNKNOWN;
  if (type.val.kind === "f64" || type.val.kind === "f32") return known(["Number"]);
  if (type.val.kind === "i32" && type.val.boolean) return known(["Boolean"]);
  return UNKNOWN;
}
interface FunctionState {
  params: NativeJsValueDomain[];
  results: NativeJsValueDomain[];
  normal: boolean;
  mayThrow: boolean;
  reads: Set<IrBindingId>;
  writes: Set<IrBindingId>;
  escapes: Map<string, NativeJsValueRoot>;
  retained: Map<string, NativeJsValueRoot>;
}
interface WorldState {
  readonly globals: Map<IrBindingId, NativeJsClassValueDomainResult["globals"][number]>;
  readonly heap: Map<string, NativeJsClassValueDomainHeapCell>;
}
interface EvaluationState {
  readonly unit: IndexedFunction;
  readonly summary: FunctionState;
  readonly values: Map<IrValueId, NativeJsValueDomain>;
  readonly slots: Map<number, NativeJsValueDomain>;
  live: boolean;
}
class ValueDomainSolver {
  readonly input: NativeJsClassValueDomainInput;
  readonly functions: ReadonlyMap<IrUnitId, IndexedFunction>;
  readonly summaries = new Map<IrUnitId, FunctionState>();
  readonly reachable = new Set<IrUnitId>();
  readonly values = new Map<string, { unitId: IrUnitId; value: IrValueId; domain: NativeJsValueDomain }>();
  globals = new Map<IrBindingId, NativeJsClassValueDomainResult["globals"][number]>();
  heap = new Map<string, NativeJsClassValueDomainHeapCell>();
  readonly entryWorlds = new Map<IrUnitId, WorldState>();
  readonly normalWorlds = new Map<IrUnitId, WorldState>();
  readonly publicTerminalWorlds = new Map<IrUnitId, WorldState>();
  readonly publicReachable = new Set<IrUnitId>();
  readonly publicPhase: boolean;
  completedStartupWorld: WorldState | undefined;
  projectionSummaries: ReadonlyMap<IrUnitId, { normal: boolean; results: readonly NativeJsValueDomain[] }> | undefined;
  readonly initialWorld: WorldState;
  observedWorld: WorldState;
  readonly calls = new Map<string, NativeJsClassValueDomainResult["calls"][number]>();
  readonly edges = new Map<string, NativeJsClassValueDomainResult["edges"][number]>();
  readonly obligations = new Map<string, NativeJsClassValueDomainObligation>();
  readonly targets = new Map<string, IrUnitId>();
  readonly definitions: ReadonlyMap<IrBindingId, IrJsClassDefinition>;
  constructor(input: NativeJsClassValueDomainInput, publicEntryWorld?: WorldState) {
    this.publicPhase = publicEntryWorld !== undefined;
    this.input = ownData(input);
    this.functions = indexInput(this.input);
    this.definitions = new Map(this.input.definitions.map((row) => [row.bindingId, row.definition]));
    for (const row of this.input.units) {
      const identity = key(row.target.binding);
      if (this.targets.has(identity)) throw new TypeError("native class value domain duplicate callable target");
      this.targets.set(identity, row.unitId);
    }
    for (const [unitId, { fn, types }] of this.functions) {
      this.summaries.set(unitId, {
        params: fn.params.map(() => BOTTOM),
        results: fn.resultTypes.map(() => BOTTOM),
        normal: false,
        mayThrow: false,
        reads: new Set(),
        writes: new Set(),
        escapes: new Map(),
        retained: new Map(),
      });
      for (const value of types.keys()) this.values.set(key([unitId, value]), { unitId, value, domain: BOTTOM });
      for (const [ordinal, block] of fn.blocks.entries()) {
        const end = block.terminator;
        const branches = end.kind === "br" ? [end.branch] : end.kind === "br_if" ? [end.ifTrue, end.ifFalse] : [];
        for (const branch of branches) this.edge(unitId, ordinal, unitId, branch.target, "cfg");
      }
    }
    for (const global of this.input.globals) {
      const domain =
        global.initial.kind === "uninitialized"
          ? BOTTOM
          : global.initial.kind === "constant"
            ? constant(global.initial.value)
            : global.initial.kind === "issued-builtin" && this.targets.has(key(global.initial.target.binding))
              ? known(["Function"], [{ kind: "external", bindingId: global.ref.binding.bindingId }])
              : UNKNOWN;
      this.globals.set(global.ref.binding.bindingId, {
        bindingId: global.ref.binding.bindingId,
        initialization: global.initial.kind === "uninitialized" ? "uninitialized" : "initialized",
        domain,
      });
    }
    this.initialWorld = publicEntryWorld ?? this.world();
    this.observedWorld = this.initialWorld;
    for (const item of this.input.exports) {
      const target = this.targets.get(key(item.target.binding));
      if (!target) throw new TypeError("native class value domain export target absent");
    }
    this.input.startupUnits.forEach((unitId, index) => {
      const prior = this.input.startupUnits[index - 1];
      if (prior) this.edge(prior, 0, unitId, 0, "startup");
    });
    const lastStartup = this.input.startupUnits.at(-1);
    if (lastStartup)
      for (const item of this.input.exports)
        this.edge(lastStartup, 0, this.targets.get(key(item.target.binding))!, 0, "startup");
    for (const row of this.publicPhase ? this.input.entryInputs : []) {
      const state = this.summaries.get(row.unitId)!;
      state.params[row.parameter] = join(
        state.params[row.parameter]!,
        row.transport === "external-js" ? UNKNOWN : scalar(row.type),
      );
    }
  }
  world(): WorldState {
    return { globals: new Map(this.globals), heap: new Map(this.heap) };
  }
  observe(): void {
    this.observedWorld = this.joinWorld(this.observedWorld, this.world());
  }
  observePublicTerminal(unitId: IrUnitId): void {
    if (!this.publicPhase || !this.publicReachable.has(unitId)) return;
    const prior = this.publicTerminalWorlds.get(unitId),
      current = this.world();
    this.publicTerminalWorlds.set(unitId, prior ? this.joinWorld(prior, current) : current);
  }
  retainedPublicWorld(world: WorldState): WorldState {
    const roots = new Set<string>(),
      sites = new Set<string>();
    const retain = (root: NativeJsValueRoot): boolean => {
      const identity = key(root);
      if (roots.has(identity)) return false;
      roots.add(identity);
      if (root.kind === "allocation") sites.add(key([root.unitId, root.site]));
      return true;
    };
    const domain = (value: NativeJsValueDomain): void => {
      if (value.kind === "known") value.roots.forEach(retain);
    };
    world.globals.forEach((row) => domain(row.domain));
    for (const unitId of this.publicReachable) this.summaries.get(unitId)!.retained.forEach(retain);
    for (const entry of this.input.exports)
      this.summaries.get(this.targets.get(key(entry.target.binding))!)!.results.forEach(domain);
    let changed: boolean;
    do {
      changed = false;
      for (const cell of world.heap.values()) {
        if (
          !roots.has(key(cell.root)) &&
          !(cell.root.kind === "allocation" && sites.has(key([cell.root.unitId, cell.root.site])))
        )
          continue;
        changed = retain(cell.root) || changed;
        if (cell.valueDomain.kind === "known")
          for (const root of cell.valueDomain.roots) changed = retain(root) || changed;
        for (const root of cell.prototypeRoots) changed = retain(root) || changed;
      }
    } while (changed);
    // Only externally retained graph state crosses invocations. A static site
    // never proves freshness or identifies two dynamic allocation occurrences.
    return {
      globals: new Map(world.globals),
      heap: new Map([...world.heap].filter(([, cell]) => roots.has(key(cell.root)))),
    };
  }
  useWorld(world: WorldState): void {
    this.globals = new Map(world.globals);
    this.heap = new Map(world.heap);
  }
  joinWorld(left: WorldState, right: WorldState): WorldState {
    const globals = new Map(left.globals),
      heap = new Map(left.heap);
    for (const [id, row] of right.globals) {
      const old = globals.get(id);
      globals.set(
        id,
        old
          ? {
              bindingId: id,
              initialization: old.initialization === row.initialization ? row.initialization : "maybe",
              domain: join(old.domain, row.domain),
            }
          : row,
      );
    }
    const leftRoots = new Set([...left.heap.values()].map((cell) => rootKey(cell.root)));
    const rightRoots = new Set([...right.heap.values()].map((cell) => rootKey(cell.root)));
    for (const [id, row] of right.heap) {
      const old = heap.get(id);
      heap.set(
        id,
        old
          ? {
              ...row,
              presence: old.presence === row.presence ? row.presence : "maybe",
              valueDomain: join(old.valueDomain, row.valueDomain),
              prototypeRoots: [
                ...new Map(
                  [...old.prototypeRoots, ...row.prototypeRoots].map((root) => [rootKey(root), root]),
                ).values(),
              ],
            }
          : leftRoots.has(rootKey(row.root))
            ? { ...row, presence: "maybe" }
            : row,
      );
    }
    for (const [id, row] of left.heap)
      if (!right.heap.has(id) && rightRoots.has(rootKey(row.root))) heap.set(id, { ...row, presence: "maybe" });
    return { globals, heap };
  }
  enter(unitId: IrUnitId, world: WorldState): void {
    const prior = this.entryWorlds.get(unitId);
    this.entryWorlds.set(unitId, prior ? this.joinWorld(prior, world) : world);
    this.reachable.add(unitId);
  }
  note(
    location: NativeJsClassValueDomainLocation | null,
    reason: NativeJsClassValueDomainReason,
    unitId: IrUnitId | null = location?.unitId ?? null,
  ): NativeJsClassValueDomainObligation {
    const obligation = { location, unitId, reason };
    this.obligations.set(key(obligation), obligation);
    return obligation;
  }
  edge(
    fromUnitId: IrUnitId,
    fromBlockOrdinal: number,
    toUnitId: IrUnitId,
    toBlockOrdinal: number,
    kind: "cfg" | "call" | "startup",
  ): void {
    const edge = { fromUnitId, fromBlockOrdinal, toUnitId, toBlockOrdinal, kind };
    this.edges.set(key(edge), edge);
  }
  emit(state: EvaluationState, instr: IrInstr, domain: NativeJsValueDomain): void {
    if (instr.result === null) return;
    state.values.set(instr.result, domain);
    const identity = key([state.unit.fn.unitId, instr.result]);
    const current = this.values.get(identity)!;
    this.values.set(identity, { ...current, domain: join(current.domain, domain) });
  }
  returned(state: EvaluationState, values: readonly NativeJsValueDomain[]): void {
    state.summary.normal = true;
    values.forEach((value, i) => (state.summary.results[i] = join(state.summary.results[i]!, value)));
    for (const domain of values) this.escape(state, domain);
    const unitId = state.unit.fn.unitId,
      prior = this.normalWorlds.get(unitId),
      current = this.world();
    this.normalWorlds.set(unitId, prior ? this.joinWorld(prior, current) : current);
    this.observePublicTerminal(unitId);
  }
  escape(state: EvaluationState, domain: NativeJsValueDomain, retained = false): void {
    if (domain.kind === "known")
      for (const root of domain.roots) {
        state.summary.escapes.set(key(root), root);
        if (retained) state.summary.retained.set(key(root), root);
      }
  }
  cell(
    root: NativeJsValueRoot,
    name: string | NativeJsClassValueDomainHeapCell["key"],
    domain: NativeJsValueDomain,
    presence: "absent" | "present" | "maybe" = "present",
    prototypeRoots: readonly NativeJsValueRoot[] = [],
  ): void {
    const property = typeof name === "string" ? { kind: "literal" as const, value: name } : name;
    const identity = key([root, property]),
      current = this.heap.get(identity);
    this.heap.set(identity, {
      root,
      key: property,
      presence: current && current.presence !== presence ? "maybe" : presence,
      valueDomain: current ? join(current.valueDomain, domain) : domain,
      prototypeRoots: [
        ...new Map(
          [...(current?.prototypeRoots ?? []), ...prototypeRoots].map((value) => [key(value), value]),
        ).values(),
      ],
    });
  }
  opaque(
    state: EvaluationState,
    location: NativeJsClassValueDomainLocation | null,
    reason: NativeJsClassValueDomainReason,
  ): void {
    this.note(location, reason, state.unit.fn.unitId);
    state.summary.mayThrow = true;
    for (const global of this.input.globals)
      if (global.mutable) {
        const current = this.globals.get(global.ref.binding.bindingId)!;
        this.globals.set(current.bindingId, { ...current, domain: UNKNOWN });
      }
    for (const [identity, cell] of this.heap)
      this.heap.set(identity, { ...cell, valueDomain: UNKNOWN, presence: "maybe" });
    this.observePublicTerminal(state.unit.fn.unitId);
  }
  bind(
    unitId: IrUnitId,
    params: readonly NativeJsValueDomain[],
    location: NativeJsClassValueDomainLocation,
  ): FunctionState {
    const target = this.summaries.get(unitId)!;
    for (const id of target.reads) this.summaries.get(location.unitId)!.reads.add(id);
    for (const id of target.writes) this.summaries.get(location.unitId)!.writes.add(id);
    for (const root of target.retained.values()) {
      this.summaries.get(location.unitId)!.escapes.set(key(root), root);
      this.summaries.get(location.unitId)!.retained.set(key(root), root);
    }
    this.enter(unitId, this.world());
    this.edge(location.unitId, location.blockOrdinal, unitId, 0, "call");
    target.params.forEach(
      (domain, index) => (target.params[index] = join(domain, params[index] ?? known(["Undefined"]))),
    );
    return target;
  }
  applyNormalWorld(unitId: IrUnitId): void {
    const world = this.normalWorlds.get(unitId);
    if (world) this.useWorld(this.joinWorld(this.world(), world));
  }
  definitionRoot(
    location: NativeJsClassValueDomainLocation,
    instr: IrInstr,
    definitionId: IrBindingId,
    view: IrJsClassRole,
    memberOrdinal: number | null = null,
  ): NativeJsValueRoot {
    if (instr.alloc === undefined) throw new TypeError("native class value domain allocation lacks genuine site");
    return { kind: "allocation", unitId: location.unitId, site: instr.alloc, definitionId, view, memberOrdinal };
  }
  binding(id: IrBindingId): IrJsClassBinding | undefined {
    for (const definition of this.definitions.values())
      for (const binding of [definition.outerBinding, definition.innerBinding]) if (binding?.id === id) return binding;
    return undefined;
  }
  currentBinding(id: IrBindingId): IrBindingId {
    return this.binding(id)?.valueGlobal?.binding.bindingId ?? id;
  }
  property(receiver: NativeJsValueDomain, name: string, visiting = new Set<string>()): NativeJsValueDomain {
    if (receiver.kind !== "known" || !receiver.roots.length) return receiver.kind === "bottom" ? BOTTOM : UNKNOWN;
    let result = BOTTOM;
    for (const root of receiver.roots) {
      if (root.kind === "external" || !["object", "constructor", "prototype", "method"].includes(root.view)) {
        result = join(result, UNKNOWN);
        continue;
      }
      if (visiting.has(key(root))) {
        result = join(result, UNKNOWN);
        continue;
      }
      const next = new Set(visiting).add(key(root));
      const cell = this.heap.get(key([root, { kind: "literal", value: name }])),
        wildcard = this.heap.get(key([root, { kind: "wildcard" }]));
      if (wildcard) {
        result = join(result, wildcard.valueDomain);
        if (wildcard.valueDomain.kind === "unknown") continue;
      }
      if (cell && cell.presence !== "absent") result = join(result, cell.valueDomain);
      if (!cell || cell.presence !== "present") {
        const proto = this.heap.get(key([root, { kind: "internal", value: "prototype" }]));
        result = join(
          result,
          proto?.valueDomain.kind === "unknown"
            ? UNKNOWN
            : proto?.prototypeRoots.length
              ? this.property(known(["Object"], proto.prototypeRoots), name, next)
              : UNKNOWN,
        );
      }
    }
    return result;
  }
  define(
    state: EvaluationState,
    instr: Extract<IrInstr, { kind: "js.class.define" }>,
    location: NativeJsClassValueDomainLocation,
  ): NativeJsValueDomain {
    const definition = this.definitions.get(instr.definition);
    if (!definition) throw new TypeError("native class value domain foreign definition");
    const constructorRoot = this.definitionRoot(location, instr, instr.definition, "constructor"),
      prototype = this.definitionRoot(location, instr, instr.definition, "prototype"),
      environment = this.definitionRoot(location, instr, instr.definition, "environment");
    this.cell(constructorRoot, "prototype", known(["Object"], [prototype]));
    this.cell(prototype, "constructor", known(["Function"], [constructorRoot]));
    this.cell(constructorRoot, { kind: "internal", value: "environment" }, known(["Object"], [environment]));
    for (const [root, bindingId] of [
      [constructorRoot, definition.realm.functionPrototype],
      [prototype, definition.realm.objectPrototype],
    ] as const)
      this.cell(root, { kind: "internal", value: "prototype" }, BOTTOM, "present", [{ kind: "external", bindingId }]);
    for (const member of definition.members) {
      const method = this.definitionRoot(location, instr, instr.definition, "method", member.sourceOrdinal);
      this.cell(method, { kind: "internal", value: "environment" }, known(["Object"], [environment]));
      this.cell(member.static ? constructorRoot : prototype, member.name, known(["Function"], [method]));
      this.cell(method, { kind: "internal", value: "prototype" }, BOTTOM, "present", [
        { kind: "external", bindingId: definition.realm.functionPrototype },
      ]);
    }
    let captured = 0;
    definition.captures.forEach((capture, index) => {
      if (capture.mode !== "live-global")
        this.cell(
          environment,
          { kind: "internal", value: `capture:${index}` },
          state.values.get(instr.captures[captured++]!) ?? BOTTOM,
        );
    });
    if (captured !== instr.captures.length)
      throw new TypeError("native class value domain definition capture census differs");
    if (definition.innerBinding) {
      const inner = this.definitionRoot(location, instr, instr.definition, "binding-cell");
      this.cell(
        environment,
        { kind: "internal", value: `capture:${definition.captures.length}` },
        known(["Object"], [inner]),
      );
      this.cell(inner, { kind: "internal", value: "binding-value" }, known(["Function"], [constructorRoot]));
    }
    return known(["Function"], [constructorRoot]);
  }
  possibleTargets(domain: NativeJsValueDomain, construct: boolean): NativeJsClassValueDomainTarget[] {
    if (domain.kind !== "known") return [];
    const rows = new Map<string, NativeJsClassValueDomainTarget>();
    for (const root of domain.roots) {
      let target: NativeJsClassValueDomainTarget | undefined;
      if (root.kind === "allocation" && root.definitionId) {
        const definition = this.definitions.get(root.definitionId);
        const body =
          construct && root.view === "constructor"
            ? definition?.constructor
            : !construct && root.view === "method"
              ? definition?.members.find((member) => member.sourceOrdinal === root.memberOrdinal)?.body
              : undefined;
        if (body)
          target = {
            target: body.target,
            unitId: body.unitId,
            definitionId: root.definitionId,
            sourceBodyKind: body.sourceBodyKind,
          };
      } else if (root.kind === "external" && !construct) {
        const initial = this.input.globals.find((global) => global.ref.binding.bindingId === root.bindingId)?.initial;
        if (initial?.kind === "issued-builtin") {
          const unitId = this.targets.get(key(initial.target.binding));
          if (unitId) target = { target: initial.target, unitId, definitionId: null, sourceBodyKind: null };
        }
      }
      if (target) rows.set(key(target.target.binding), target);
    }
    return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  }
  hidden(
    root: NativeJsValueRoot,
    receiver: NativeJsValueDomain,
    construct: boolean,
    newTarget: NativeJsValueDomain = UNKNOWN,
  ): NativeJsValueDomain[] {
    if (root.kind !== "allocation") return [UNKNOWN, receiver, UNKNOWN, UNKNOWN];
    const environment = { ...root, view: "environment" as const, memberOrdinal: null },
      home = { ...root, view: construct ? ("prototype" as const) : ("prototype" as const), memberOrdinal: null };
    const definition = root.definitionId && this.definitions.get(root.definitionId);
    const isStatic =
      !construct && definition?.members.find((member) => member.sourceOrdinal === root.memberOrdinal)?.static;
    return [
      known(["Object"], [environment]),
      receiver,
      known(
        [isStatic ? "Function" : "Object"],
        [isStatic ? { ...root, view: "constructor", memberOrdinal: null } : home],
      ),
      newTarget,
    ];
  }
  call(
    state: EvaluationState,
    instr: Extract<IrInstr, { kind: "call" | "js.class.invoke" | "js.class.construct" }>,
    location: NativeJsClassValueDomainLocation,
  ): NativeJsValueDomain {
    const value = (id: IrValueId) => state.values.get(id) ?? BOTTOM;
    const args = instr.args.map(value),
      construct = instr.kind === "js.class.construct";
    const callee = instr.kind === "call" ? UNKNOWN : value(construct ? instr.constructor : instr.callable);
    let receiver = instr.kind === "js.class.invoke" ? value(instr.receiver) : construct ? BOTTOM : null;
    let targets = this.possibleTargets(callee, construct);
    if (instr.kind === "call") {
      const unitId = this.targets.get(key(instr.target.binding));
      targets = unitId ? [{ target: instr.target, unitId, definitionId: null, sourceBodyKind: null }] : [];
    }
    const obligations: NativeJsClassValueDomainObligation[] = [];
    let normal = BOTTOM,
      mayThrow = instr.kind !== "call";
    const unresolved =
      callee.kind === "known" &&
      callee.families.includes("Function") &&
      (!callee.roots.length ||
        callee.roots.some((root) => this.possibleTargets(known(["Function"], [root]), construct).length === 0));
    if (
      (!targets.length && instr.kind === "call") ||
      (instr.kind !== "call" && (callee.kind === "unknown" || unresolved))
    ) {
      mayThrow = true;
      if (instr.kind === "call" && state.unit.nativeReferenceCalls.has(instr)) {
        state.summary.mayThrow = true;
        this.observePublicTerminal(state.unit.fn.unitId);
      } else {
        this.opaque(state, location, "unknown-callee");
        obligations.push(this.note(location, "unknown-callee"), this.note(location, "opaque-effect"));
        for (const domain of [callee, receiver ?? BOTTOM, ...args]) this.escape(state, domain, true);
      }
      normal = UNKNOWN;
      if (construct) receiver = UNKNOWN;
    }
    for (const target of targets) {
      let actual = args;
      if (target.definitionId && callee.kind === "known") {
        const root = callee.roots.find(
          (candidate) =>
            candidate.kind === "allocation" &&
            candidate.definitionId === target.definitionId &&
            (construct
              ? candidate.view === "constructor"
              : candidate.view === "method" &&
                this.definitions
                  .get(target.definitionId!)
                  ?.members.find((member) => member.sourceOrdinal === candidate.memberOrdinal)?.body.unitId ===
                  target.unitId),
        );
        if (!root) {
          normal = join(normal, UNKNOWN);
          continue;
        }
        let self = receiver ?? BOTTOM;
        if (construct) {
          const definition = this.definitions.get(target.definitionId)!;
          const instance = this.definitionRoot(location, instr, target.definitionId, "object");
          self = known(["Object"], [instance]);
          receiver = join(receiver ?? BOTTOM, self);
          const actualPrototype = this.property(value(instr.newTarget), "prototype");
          const fallback: NativeJsValueRoot = { kind: "external", bindingId: definition.realm.objectPrototype };
          const prototypes =
            actualPrototype.kind === "known"
              ? [
                  ...actualPrototype.roots,
                  ...(actualPrototype.families.some((family) => family !== "Object" && family !== "Function")
                    ? [fallback]
                    : []),
                ]
              : [];
          this.cell(
            instance,
            { kind: "internal", value: "prototype" },
            actualPrototype.kind === "unknown" ? UNKNOWN : BOTTOM,
            "present",
            prototypes,
          );
          let ready = true;
          for (const field of definition.instanceElements) {
            let stored = known(["Undefined"]);
            if (field.initializer) {
              const summary = this.bind(
                field.initializer.unitId,
                this.hidden(root, self, true, value(instr.newTarget)),
                location,
              );
              if (!summary.normal) {
                ready = false;
                break;
              }
              stored = summary.results[0] ?? BOTTOM;
              if (summary.normal) this.applyNormalWorld(field.initializer.unitId);
            }
            this.cell(instance, field.name, stored);
          }
          if (!ready) continue;
        }
        actual = [
          ...this.hidden(root, self, construct, instr.kind === "js.class.construct" ? value(instr.newTarget) : UNKNOWN),
          ...args,
        ];
      }
      const summary = this.bind(target.unitId, actual, location);
      mayThrow ||= summary.mayThrow;
      if (summary.normal) {
        normal = join(normal, summary.results.length ? summary.results[0]! : known(["Undefined"]));
        this.applyNormalWorld(target.unitId);
      }
    }
    state.summary.mayThrow ||= mayThrow;
    this.calls.set(key(location), {
      location,
      kind: instr.kind === "call" ? "direct" : construct ? "construct" : "invoke",
      calleeDomain: callee,
      receiverDomain: receiver,
      argumentDomains: args,
      targets,
      normalDomain: normal,
      mayThrow,
      obligations: orderedObligations(obligations),
    });
    if (normal.kind === "bottom") state.live = false;
    return normal;
  }
  frame(
    state: EvaluationState,
    instr: Extract<IrInstr, { kind: "js.class.frame.new" | "js.class.frame.get" }>,
    location: NativeJsClassValueDomainLocation,
  ): NativeJsValueDomain {
    const value = (id: IrValueId) => state.values.get(id) ?? BOTTOM;
    switch (instr.kind) {
      case "js.class.frame.new": {
        const frame = this.definitionRoot(location, instr, instr.definition, "frame");
        for (const [name, operand] of [
          ["environment", instr.environment],
          ["this", instr.thisValue],
          ["home-object", instr.homeObject],
          ["new-target", instr.newTarget],
        ] as const)
          this.cell(frame, { kind: "internal", value: name }, value(operand));
        return known(["Object"], [frame]);
      }
      case "js.class.frame.get": {
        const frames = value(instr.frame);
        if (frames.kind !== "known") return frames.kind === "bottom" ? BOTTOM : UNKNOWN;
        let result = BOTTOM;
        for (const root of frames.roots) {
          if (instr.access.kind === "capture") {
            const definition = this.definitions.get(instr.access.definitionId);
            const body =
              definition &&
              [
                definition.constructor,
                ...definition.members.map((member) => member.body),
                ...definition.instanceElements.flatMap((field) => (field.initializer ? [field.initializer] : [])),
              ].find((candidate) => candidate.unitId === location.unitId);
            const capture = body?.frame.captures[instr.access.index];
            if (!capture) throw new TypeError("native class value domain frame capture census differs");
            if (capture.mode === "live-global") {
              const id = capture.valueGlobal?.binding.bindingId;
              const global = id && this.globals.get(id);
              if (!global) throw new TypeError("native class value domain live capture global absent");
              state.summary.reads.add(global.bindingId);
              state.summary.mayThrow = true;
              if (global.initialization === "uninitialized") {
                state.live = false;
                result = join(result, BOTTOM);
              } else if (global.initialization === "maybe") {
                this.note(location, "mutable-binding-carrier");
                result = join(result, UNKNOWN);
              } else result = join(result, global.domain);
              continue;
            }
            const environment = this.heap.get(key([root, { kind: "internal", value: "environment" }]))?.valueDomain;
            if (environment?.kind !== "known") {
              result = join(result, UNKNOWN);
              continue;
            }
            for (const env of environment.roots)
              result = join(
                result,
                this.heap.get(key([env, { kind: "internal", value: `capture:${instr.access.index}` }]))?.valueDomain ??
                  UNKNOWN,
              );
          } else
            result = join(
              result,
              this.heap.get(key([root, { kind: "internal", value: instr.access.kind }]))?.valueDomain ?? UNKNOWN,
            );
        }
        return result;
      }
    }
  }
  simple(state: EvaluationState, instr: IrInstr, location: NativeJsClassValueDomainLocation): NativeJsValueDomain {
    const value = (id: IrValueId) => state.values.get(id) ?? BOTTOM;
    switch (instr.kind) {
      case "const":
        return constant(instr.value);
      case "box": {
        const operand = value(instr.value),
          tag = instr.toType.kind === "dynamic" ? instr.toType.tag : undefined;
        const family: NativeJsValueFamily | undefined =
          tag === JS_TAG_IDS.NumberF64 || tag === JS_TAG_IDS.NumberI32
            ? "Number"
            : tag === JS_TAG_IDS.Boolean
              ? "Boolean"
              : tag === JS_TAG_IDS.Object
                ? "Object"
                : tag === JS_TAG_IDS.Function
                  ? "Function"
                  : tag === JS_TAG_IDS.String
                    ? "String"
                    : undefined;
        if (!family || operand.kind !== "known" || operand.families.some((actual) => actual !== family)) {
          this.note(location, "unsupported-value");
          return operand.kind === "bottom" ? BOTTOM : UNKNOWN;
        }
        return operand;
      }
      case "unbox": {
        const operand = value(instr.value),
          expected =
            instr.tagId === JS_TAG_IDS.NumberF64 || instr.tagId === JS_TAG_IDS.NumberI32
              ? "Number"
              : instr.tagId === JS_TAG_IDS.Boolean
                ? "Boolean"
                : instr.tagId === JS_TAG_IDS.String
                  ? "String"
                  : instr.tagId === JS_TAG_IDS.Object
                    ? "Object"
                    : instr.tagId === JS_TAG_IDS.Function
                      ? "Function"
                      : null;
        const producer = state.unit.occurrences.find((row) => row.instr.result === instr.value)?.instr;
        const exactBox =
          producer?.kind === "box" && producer.toType.kind === "dynamic" && producer.toType.tag === instr.tagId;
        if (
          !exactBox ||
          !expected ||
          operand.kind !== "known" ||
          operand.families.some((family) => family !== expected)
        ) {
          this.note(location, "unsafe-scalar-projection");
          return UNKNOWN;
        }
        return operand;
      }
      case "tag.test":
      case "dyn.truthy":
        return value(instr.value).kind === "bottom" ? BOTTOM : known(["Boolean"]);
      case "dyn.eq":
        if (value(instr.lhs).kind === "bottom" || value(instr.rhs).kind === "bottom") return BOTTOM;
        if (instr.loose) this.opaque(state, location, "opaque-effect");
        return known(["Boolean"]);
      case "dyn.to_number":
        if (value(instr.value).kind === "bottom") return BOTTOM;
        this.opaque(state, location, "opaque-effect");
        return known(["Number"]);
      case "binary":
      case "unary": {
        const operands = instr.kind === "binary" ? [value(instr.lhs), value(instr.rhs)] : [value(instr.rand)];
        if (operands.some((operand) => operand.kind === "bottom")) return BOTTOM;
        if (
          operands.some(
            (operand) =>
              operand.kind !== "known" ||
              operand.families.some((family) => family !== "Number" && family !== "Boolean"),
          )
        ) {
          this.note(location, "unsafe-scalar-projection");
          return UNKNOWN;
        }
        return scalar(instr.resultType!);
      }
      case "select":
        return join(value(instr.whenTrue), value(instr.whenFalse));
      case "slot.read":
        return state.slots.get(instr.slotIndex) ?? BOTTOM;
      case "slot.write":
        state.slots.set(instr.slotIndex, join(state.slots.get(instr.slotIndex) ?? BOTTOM, value(instr.value)));
        return BOTTOM;
      case "global.get": {
        const id = instr.target.binding.bindingId;
        state.summary.reads.add(id);
        return this.globals.get(id)?.domain ?? UNKNOWN;
      }
      case "global.set": {
        const id = instr.target.binding.bindingId,
          current = this.globals.get(id);
        if (!current) throw new TypeError("native class value domain global write absent");
        state.summary.writes.add(id);
        this.escape(state, value(instr.value), true);
        this.globals.set(id, {
          bindingId: id,
          initialization: "initialized",
          domain:
            current.initialization === "uninitialized" ? value(instr.value) : join(current.domain, value(instr.value)),
        });
        return BOTTOM;
      }
      case "js.class.define":
        return this.define(state, instr, location);
      case "js.class.binding.new":
        return known(["Object"], [this.definitionRoot(location, instr, instr.binding, "binding-cell")]);
      case "js.class.binding.init":
      case "js.class.binding.write": {
        const domain = value(instr.value);
        const tdz = this.binding(instr.storage.bindingId)?.tdzGlobal;
        if (tdz) state.summary[instr.kind === "js.class.binding.init" ? "writes" : "reads"].add(tdz.binding.bindingId);
        if (instr.storage.kind === "cell") {
          const cell = value(instr.storage.cell);
          if (cell.kind === "known")
            for (const root of cell.roots) this.cell(root, { kind: "internal", value: "binding-value" }, domain);
          else this.note(location, "mutable-binding-carrier");
        } else {
          const id = this.currentBinding(instr.storage.bindingId),
            current = this.globals.get(id);
          if (!current) throw new TypeError("native class value domain binding global absent");
          state.summary.writes.add(id);
          this.escape(state, domain, true);
          this.globals.set(id, {
            bindingId: id,
            initialization: "initialized",
            domain: current.initialization === "uninitialized" ? domain : join(current.domain, domain),
          });
        }
        return BOTTOM;
      }
      case "js.class.binding.read": {
        state.summary.mayThrow = true;
        const tdz = this.binding(instr.storage.bindingId)?.tdzGlobal;
        if (tdz) state.summary.reads.add(tdz.binding.bindingId);
        if (instr.storage.kind === "cell") {
          const cells = value(instr.storage.cell);
          return cells.kind === "known"
            ? cells.roots.reduce(
                (domain, root) =>
                  join(
                    domain,
                    this.heap.get(key([root, { kind: "internal", value: "binding-value" }]))?.valueDomain ?? BOTTOM,
                  ),
                BOTTOM,
              )
            : UNKNOWN;
        }
        const id = this.currentBinding(instr.storage.bindingId),
          current = this.globals.get(id);
        state.summary.reads.add(id);
        if (!current) throw new TypeError("native class value domain binding read absent");
        if (current.initialization === "uninitialized") {
          state.live = false;
          return BOTTOM;
        }
        if (current.initialization === "maybe") {
          this.note(location, "mutable-binding-carrier");
          return UNKNOWN;
        }
        return current.domain;
      }
      case "js.class.property.get": {
        if (instr.key.kind !== "string") {
          this.opaque(state, location, "unknown-property");
          return UNKNOWN;
        }
        const receiver = value(instr.receiver);
        if (
          receiver.kind === "known" &&
          receiver.roots.some(
            (root) => root.kind === "external" || !["object", "constructor", "prototype", "method"].includes(root.view),
          )
        ) {
          this.opaque(state, location, "unknown-property");
          return UNKNOWN;
        }
        const found = this.property(receiver, instr.key.value);
        if (found.kind === "unknown") {
          this.opaque(state, location, "unknown-property");
          this.escape(state, receiver, true);
        }
        return found;
      }
      case "js.class.property.define":
      case "js.class.property.set": {
        const receiver = value(instr.receiver),
          stored = value(instr.value);
        // No source/site label proves that the receiver is fresh for this activation.
        this.escape(state, stored, true);
        const uncertain =
          receiver.kind !== "known" ||
          (instr.kind === "js.class.property.define" &&
            (!instr.attributes.writable || !instr.attributes.configurable)) ||
          (instr.kind === "js.class.property.set" &&
            (instr.key.kind !== "string" ||
              this.property(receiver, instr.key.value).kind === "unknown" ||
              (instr.key.value === "prototype" &&
                receiver.roots.some((root) => root.kind === "allocation" && root.view === "constructor"))));
        if (uncertain) {
          this.opaque(state, location, "unknown-property");
          this.escape(state, receiver, true);
        }
        if (receiver.kind === "known")
          for (const root of receiver.roots) {
            const property =
              instr.key.kind === "string" ? { kind: "literal", value: instr.key.value } : { kind: "wildcard" };
            const own = this.heap.get(key([root, property]));
            this.cell(
              root,
              instr.key.kind === "string" ? instr.key.value : { kind: "wildcard" },
              uncertain ? UNKNOWN : stored,
              instr.kind === "js.class.property.define" || (!uncertain && own?.presence === "present")
                ? "present"
                : "maybe",
            );
          }
        state.summary.mayThrow = true;
        return BOTTOM;
      }
      case "js.class.frame.new":
      case "js.class.frame.get":
        return this.frame(state, instr, location);
      case "js.class.constructor.complete": {
        const self = value(instr.self);
        if (instr.completion.kind === "normal") return self;
        const returned = value(instr.completion.value);
        if (returned.kind !== "known") return returned.kind === "bottom" ? BOTTOM : UNKNOWN;
        const objects = returned.families.filter((family) => family === "Object" || family === "Function");
        const replacements = objects.length ? known(objects, returned.roots) : BOTTOM;
        return returned.families.some((family) => family !== "Object" && family !== "Function")
          ? join(self, replacements)
          : replacements;
      }
      case "js.class.identity":
        return value(instr.left).kind === "bottom" || value(instr.right).kind === "bottom"
          ? BOTTOM
          : known(["Boolean"]);
      case "js.class.instanceof":
        if (value(instr.value).kind === "bottom" || value(instr.constructor).kind === "bottom") return BOTTOM;
        this.opaque(state, location, "opaque-effect");
        return known(["Boolean"]);
      case "call":
      case "js.class.invoke":
      case "js.class.construct":
        return this.call(state, instr, location);
      case "throw":
        this.escape(state, value(instr.value), true);
        state.summary.mayThrow = true;
        state.live = false;
        return BOTTOM;
      case "early.return":
        this.returned(state, instr.value === null ? [] : [value(instr.value)]);
        state.live = false;
        return BOTTOM;
      default: {
        let nested = false;
        forEachNestedBuffer(instr, () => (nested = true));
        const unsupportedControl = nested || instr.kind === "raw.wasm";
        this.opaque(state, location, unsupportedControl ? "unsupported-control" : "opaque-effect");
        if (!unsupportedControl && instr.result !== null) this.note(location, "unsupported-value");
        if (unsupportedControl)
          this.returned(
            state,
            state.summary.results.map(() => UNKNOWN),
          );
        return UNKNOWN;
      }
    }
  }
  walk(
    state: EvaluationState,
    instructions: readonly IrInstr[],
    blockOrdinal: number,
    nestedPath: readonly number[] = [],
  ): void {
    for (const [instructionOrdinal, instr] of instructions.entries()) {
      if (!state.live) break;
      const location = { unitId: state.unit.fn.unitId, blockOrdinal, nestedPath, instructionOrdinal };
      if (instr.kind === "if" || instr.kind === "if.stmt") {
        if ((state.values.get(instr.cond) ?? BOTTOM).kind === "bottom") {
          state.live = false;
          break;
        }
        const before = this.world();
        const branches = [instr.then, instr.else].map((body, ordinal) => {
          this.useWorld(before);
          const child = { ...state, values: new Map(state.values), slots: new Map(state.slots), live: true };
          this.walk(child, body, blockOrdinal, [...nestedPath, ordinal, instructionOrdinal]);
          return { child, world: this.world() };
        });
        const continuing = branches.filter(({ child }) => child.live);
        this.useWorld(continuing.reduce((world, branch) => this.joinWorld(world, branch.world), before));
        for (const { child } of branches)
          for (const [slot, domain] of child.slots)
            state.slots.set(slot, join(state.slots.get(slot) ?? BOTTOM, domain));
        for (const { child } of branches)
          for (const [value, domain] of child.values)
            state.values.set(value, join(state.values.get(value) ?? BOTTOM, domain));
        state.live = continuing.length !== 0;
        if (instr.kind === "if")
          this.emit(
            state,
            instr,
            join(
              branches[0]!.child.values.get(instr.thenValue) ?? BOTTOM,
              branches[1]!.child.values.get(instr.elseValue) ?? BOTTOM,
            ),
          );
        continue;
      }
      const domain = this.simple(state, instr, location);
      this.emit(state, instr, domain);
      this.observe();
      if (!state.live) this.observePublicTerminal(state.unit.fn.unitId);
      let ordinal = 0;
      forEachNestedBuffer(instr, (body) => {
        const child = { ...state, values: new Map(state.values), slots: new Map(state.slots), live: true };
        this.walk(child, body, blockOrdinal, [...nestedPath, ordinal++, instructionOrdinal]);
        for (const [value, childDomain] of child.values)
          state.values.set(value, join(state.values.get(value) ?? BOTTOM, childDomain));
      });
    }
  }
  evaluate(unitId: IrUnitId): void {
    const entry = this.entryWorlds.get(unitId);
    if (!entry) return;
    this.useWorld(entry);
    const unit = this.functions.get(unitId)!,
      summary = this.summaries.get(unitId)!;
    const values = new Map<IrValueId, NativeJsValueDomain>();
    unit.fn.params.forEach((param, i) => values.set(param.value, summary.params[i]!));
    for (const block of unit.fn.blocks)
      for (const value of block.blockArgs) values.set(value, this.values.get(key([unitId, value]))!.domain);
    const state: EvaluationState = { unit, summary, values, slots: new Map(), live: true };
    const queue = [0],
      visited = new Set<number>();
    while (queue.length) {
      const ordinal = queue.shift()!;
      if (visited.has(ordinal)) continue;
      visited.add(ordinal);
      const block = unit.fn.blocks[ordinal];
      if (!block) throw new TypeError("native class value domain CFG target absent");
      state.live = true;
      this.walk(state, block.instrs, ordinal);
      if (!state.live) continue;
      const end = block.terminator;
      if (end.kind === "return")
        this.returned(
          state,
          end.values.map((value) => state.values.get(value) ?? BOTTOM),
        );
      else if (end.kind === "br" || end.kind === "br_if") {
        if (end.kind === "br_if" && (state.values.get(end.condition) ?? BOTTOM).kind === "bottom") continue;
        const branches = end.kind === "br" ? [end.branch] : [end.ifTrue, end.ifFalse];
        for (const branch of branches) {
          const next = unit.fn.blocks[branch.target];
          if (!next || next.blockArgs.length !== branch.args.length)
            throw new TypeError("native class value domain CFG argument census differs");
          next.blockArgs.forEach((value, i) => {
            const domain = join(state.values.get(value) ?? BOTTOM, state.values.get(branch.args[i]!) ?? BOTTOM);
            state.values.set(value, domain);
            const identity = key([unitId, value]),
              row = this.values.get(identity)!;
            this.values.set(identity, { ...row, domain: join(row.domain, domain) });
          });
          if (branch.target <= ordinal) {
            this.opaque(state, null, "unsupported-control");
            this.returned(
              state,
              summary.results.map(() => UNKNOWN),
            );
          }
          queue.push(branch.target);
        }
      }
    }
    unit.fn.params.forEach((param, i) => {
      const identity = key([unitId, param.value]),
        current = this.values.get(identity)!;
      this.values.set(identity, { ...current, domain: join(current.domain, summary.params[i]!) });
    });
    if (
      summary.normal &&
      [...this.obligations.values()].some((row) => row.unitId === unitId && row.reason === "unsupported-control")
    )
      summary.results = summary.results.map(() => UNKNOWN);
  }
  signature(): string {
    return signatureKey({
      summaries: [...this.summaries].map(([unitId, state]) => [
        unitId,
        state.params,
        state.results,
        state.normal,
        state.mayThrow,
        [...state.reads].sort(),
        [...state.writes].sort(),
        [...state.escapes].sort(([a], [b]) => a.localeCompare(b)),
        [...state.retained].sort(([a], [b]) => a.localeCompare(b)),
      ]),
      reachable: [...this.reachable],
      entries: [...this.entryWorlds].map(([unit, world]) => [unit, [...world.globals], [...world.heap]]),
      normalWorlds: [...this.normalWorlds].map(([unit, world]) => [unit, [...world.globals], [...world.heap]]),
      publicTerminalWorlds: [...this.publicTerminalWorlds].map(([unit, world]) => [
        unit,
        [...world.globals],
        [...world.heap],
      ]),
      publicReachable: [...this.publicReachable].sort(),
      observedWorld: [[...this.observedWorld.globals], [...this.observedWorld.heap]],
      obligations: [...this.obligations].sort(([a], [b]) => a.localeCompare(b)),
      values: [...this.values],
      calls: [...this.calls],
    });
  }
  solve(): void {
    let previous: string, completed: WorldState | undefined;
    do {
      previous = this.signature();
      let world: WorldState | undefined = this.initialWorld;
      if (!this.publicPhase)
        for (const unitId of this.input.startupUnits) {
          if (!world) break;
          this.enter(unitId, world);
          this.evaluate(unitId);
          world = this.summaries.get(unitId)!.normal ? this.normalWorlds.get(unitId) : undefined;
        }
      else {
        for (const entry of this.input.exports) this.publicReachable.add(this.targets.get(key(entry.target.binding))!);
        let changed: boolean;
        do {
          changed = false;
          for (const edge of this.edges.values())
            if (
              edge.kind === "call" &&
              this.publicReachable.has(edge.fromUnitId) &&
              !this.publicReachable.has(edge.toUnitId)
            ) {
              this.publicReachable.add(edge.toUnitId);
              changed = true;
            }
        } while (changed);
        for (const [unitId, terminal] of this.publicTerminalWorlds)
          if (this.publicReachable.has(unitId)) world = this.joinWorld(world, this.retainedPublicWorld(terminal));
        for (const entry of this.input.exports) this.enter(this.targets.get(key(entry.target.binding))!, world);
      }
      for (const unitId of this.functions.keys())
        if (this.reachable.has(unitId) && (this.publicPhase || !this.input.startupUnits.includes(unitId)))
          this.evaluate(unitId);
      completed = world;
    } while (previous !== this.signature());
    this.completedStartupWorld = this.publicPhase ? undefined : completed;
    let aggregate = this.observedWorld;
    for (const world of [...this.entryWorlds.values(), ...this.normalWorlds.values()])
      aggregate = this.joinWorld(aggregate, world);
    this.useWorld(aggregate);
  }
  absorbStartup(startup: ValueDomainSolver): void {
    // Phase-private fixed points are complete before diagnostic populations join.
    // In particular, public argument/result summaries never re-enter startup.
    this.projectionSummaries = new Map(
      [...this.summaries].map(([id, row]) => [id, { normal: row.normal, results: [...row.results] }]),
    );
    this.useWorld(this.joinWorld(this.world(), startup.world()));
    for (const [id, old] of startup.values) {
      const current = this.values.get(id)!;
      this.values.set(id, { ...current, domain: join(current.domain, old.domain) });
    }
    for (const [id, old] of startup.summaries) {
      const current = this.summaries.get(id)!;
      current.params = current.params.map((domain, index) => join(domain, old.params[index]!));
      current.results = current.results.map((domain, index) => join(domain, old.results[index]!));
      current.normal ||= old.normal;
      current.mayThrow ||= old.mayThrow;
      for (const value of old.reads) current.reads.add(value);
      for (const value of old.writes) current.writes.add(value);
      for (const [identity, root] of old.escapes) current.escapes.set(identity, root);
      for (const [identity, root] of old.retained) current.retained.set(identity, root);
    }
    for (const [identity, old] of startup.calls) {
      const current = this.calls.get(identity);
      this.calls.set(
        identity,
        current
          ? {
              ...current,
              calleeDomain: join(current.calleeDomain, old.calleeDomain),
              receiverDomain:
                current.receiverDomain === null ? null : join(current.receiverDomain, old.receiverDomain ?? BOTTOM),
              argumentDomains: current.argumentDomains.map((domain, index) =>
                join(domain, old.argumentDomains[index]!),
              ),
              normalDomain: join(current.normalDomain, old.normalDomain),
              targets: [
                ...new Map([...current.targets, ...old.targets].map((target) => [key(target), target])).values(),
              ].sort((a, b) => key(a).localeCompare(key(b))),
              mayThrow: current.mayThrow || old.mayThrow,
              obligations: orderedObligations([...current.obligations, ...old.obligations]),
            }
          : old,
      );
    }
    for (const [identity, row] of startup.edges) this.edges.set(identity, row);
    for (const [identity, row] of startup.obligations) this.obligations.set(identity, row);
  }
  result(): NativeJsClassValueDomainResult {
    let instructions = 0,
      parameters = 0,
      blockArguments = 0,
      invokes = 0,
      constructs = 0;
    for (const [unitId, unit] of this.functions) {
      parameters += unit.fn.params.length;
      blockArguments += unit.fn.blocks.reduce((count, block) => count + block.blockArgs.length, 0);
      instructions += unit.occurrences.length;
      for (const { instr, location } of unit.occurrences) {
        invokes += instr.kind === "js.class.invoke" ? 1 : 0;
        constructs += instr.kind === "js.class.construct" ? 1 : 0;
        if (["call", "js.class.invoke", "js.class.construct"].includes(instr.kind) && !this.calls.has(key(location))) {
          if (instr.kind !== "call" && instr.kind !== "js.class.invoke" && instr.kind !== "js.class.construct")
            continue;
          this.calls.set(key(location), {
            location,
            kind: instr.kind === "call" ? "direct" : instr.kind === "js.class.invoke" ? "invoke" : "construct",
            calleeDomain: BOTTOM,
            receiverDomain: instr.kind === "call" ? null : BOTTOM,
            argumentDomains: instr.args.map(() => BOTTOM),
            targets: [],
            normalDomain: BOTTOM,
            mayThrow: false,
            obligations: [],
          });
        }
      }
      const current = this.summaries.get(unitId)!;
      if (!current.normal && current.results.some((domain) => domain.kind !== "bottom"))
        throw new TypeError("native class value domain nonreturn census differs");
    }
    const functions = [...this.functions.keys()].map((unitId) => {
      const state = this.summaries.get(unitId)!;
      return {
        unitId,
        parameterDomains: state.params,
        normalResultDomains: state.results,
        normalCompletion: state.normal,
        mayThrow: state.mayThrow,
        readsGlobals: [...state.reads].sort(),
        writesGlobals: [...state.writes].sort(),
        escapedRoots: [...state.escapes].sort(([a], [b]) => a.localeCompare(b)).map(([, root]) => root),
      };
    });
    const projections = this.input.exports.map((entry) => {
      const unitId = this.targets.get(key(entry.target.binding))!,
        summary = (this.projectionSummaries ?? this.summaries).get(unitId)!;
      const startupComplete = this.publicPhase || this.input.startupUnits.every((id) => this.summaries.get(id)!.normal);
      const normal = startupComplete && summary.normal ? (summary.results[0] ?? known(["Undefined"])) : BOTTOM;
      if (normal.kind !== "known") this.note(null, "unsafe-scalar-projection", unitId);
      const dependencies = new Set([unitId, ...this.input.startupUnits]);
      let changed: boolean;
      do {
        changed = false;
        for (const edge of this.edges.values())
          if (edge.kind === "call" && dependencies.has(edge.fromUnitId) && !dependencies.has(edge.toUnitId)) {
            dependencies.add(edge.toUnitId);
            changed = true;
          }
      } while (changed);
      const obligations = orderedObligations(
        [...this.obligations.values()].filter((row) => row.unitId === null || dependencies.has(row.unitId)),
      );
      const decision =
        normal.kind !== "known" || obligations.length !== 0
          ? ("unknown" as const)
          : normal.families.length === 1 && normal.families[0] === "Number"
            ? ("number" as const)
            : normal.families.length === 1 && normal.families[0] === "Boolean"
              ? ("boolean" as const)
              : normal.families.length === 1 && normal.families[0] === "Undefined"
                ? ("void-undefined" as const)
                : ("dynamic-required" as const);
      return { externalName: entry.externalName, target: entry.target, normalDomain: normal, decision, obligations };
    });
    return frozen({
      schema: "native-js-class-value-domain-result-v1",
      namespace: this.input.namespace,
      census: {
        functions: this.functions.size,
        instructions,
        parameters,
        blockArguments,
        definitions: this.definitions.size,
        globals: this.globals.size,
        invokes,
        constructs,
      },
      values: [...this.values.values()].sort(
        (a, b) =>
          [...this.functions.keys()].indexOf(a.unitId) - [...this.functions.keys()].indexOf(b.unitId) ||
          a.value - b.value,
      ),
      calls: [...this.calls].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
      functions,
      globals: [...this.globals.values()].sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
      heap: [...this.heap].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
      edges: [...this.edges].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
      projections,
      obligations: [...this.obligations].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
    });
  }
}

/** Deterministic descriptions only; callers must independently replay against current actual DATA. */
export function analyzeNativeJsClassValueDomains(input: NativeJsClassValueDomainInput): NativeJsClassValueDomainResult {
  const startup = new ValueDomainSolver(input);
  startup.solve();
  if (!startup.completedStartupWorld) return startup.result();
  const publicModel = new ValueDomainSolver(input, startup.completedStartupWorld);
  publicModel.solve();
  publicModel.absorbStartup(startup);
  return publicModel.result();
}
