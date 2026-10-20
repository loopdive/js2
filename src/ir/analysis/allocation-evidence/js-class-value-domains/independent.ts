// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent equation replay. No producer runtime dependency or report authority.
import { inputPopulation } from "./independent-input.js";
import { directUses, forEachNestedBuffer, type IrFunction, type IrInstr } from "../../../core/nodes.js";
import { assertPreparedIrData, copyPreparedIrDataObject } from "../../../../shared/contracts/prepared-ir-data.js";
import { JS_TAG_IDS } from "../../../core/js-value-tag-identities.js";
import type { IrBindingId } from "../../../../shared/contracts/ir-identity.js";
import type { IrType } from "../../../core/types.js";
import type { IrFuncRef } from "../../../core/value-references.js";
import type { IrJsClassDefinition } from "../../../core/js-class-contracts.js";

import type {
  NativeJsClassValueDomainInput as Input,
  NativeJsClassValueDomainResult as Result,
  NativeJsClassValueDomainProblem as Problem,
  NativeJsClassValueDomainLocation as Location,
  NativeJsClassValueDomainObligation as Obligation,
  NativeJsClassValueDomainReason as Reason,
  NativeJsClassValueDomainTarget as Target,
  NativeJsClassValueDomainHeapCell as Cell,
  NativeJsValueDomain as Domain,
  NativeJsValueRoot as Root,
} from "./contracts.js";
import {
  type Data,
  type ReplayModel as Model,
  joinUnitWorld,
  commitFlow as commitFullFlow,
  canOmitNormalizedWorldJoin,
  createReplayLocation,
  updatePublicHistory,
  mergePhaseModels,
  equationSame,
  orderedObligations,
  fail,
  record,
  array,
  fields,
  identifier,
  integer,
  type Population,
  BOTTOM,
  UNKNOWN,
  stable,
  roots,
  known,
  join,
  same,
  contains,
  numberType,
  unitTarget,
  constant,
  type GlobalState,
  type FunctionState,
  type Call,
  type Edge,
  type World,
  type Flow,
  cellKey,
  mergeCell,
  storeCell,
  mergeGlobal,
  cloneFlow,
  cloneWorld,
  joinWorld,
  worldData,
  combineFlow,
  flowData,
  cycleBlocks,
  propertyWriteIsClosed,
  projectNativeJsClassValueDomains,
} from "./independent-kernel.js";

function commitFlow(model: Model, flow: World): void {
  const before: World = { globals: model.globals, heap: model.heap, roots: model.observedRoots };
  if (!canOmitNormalizedWorldJoin(before, flow)) commitFullFlow(model, flow);
}

interface Context {
  readonly model: Model;
  readonly fn: IrFunction;
  readonly blockOrdinal: number;
  readonly returns: Domain[];
  readonly reads: Set<IrBindingId>;
  readonly writes: Set<IrBindingId>;
  readonly escaped: Root[];
  readonly retained: Root[];
  readonly thrown: Root[];
  mayThrow: boolean;
}
function location(
  fn: IrFunction,
  blockOrdinal: number,
  nestedPath: readonly number[],
  instructionOrdinal: number,
): Location {
  return createReplayLocation(fn.unitId, blockOrdinal, nestedPath, instructionOrdinal);
}
function obligation(
  model: Model,
  where: Location | null,
  unitId: IrFunction["unitId"] | null,
  reason: Reason,
): Obligation {
  const row: Obligation = { location: where, unitId, reason };
  model.obligations.set(stable(row), row);
  return row;
}
function valueKey(unit: string, value: number): string {
  return `${unit}#${value}`;
}
function allocation(
  context: Context,
  instruction: IrInstr,
  view: Extract<Root, { kind: "allocation" }>["view"],
  definitionId: Input["definitions"][number]["bindingId"] | null,
  ordinal: number | null = null,
): Root {
  if (instruction.alloc === undefined) fail("managed graph lacks actual allocation occurrence");
  integer(instruction.alloc);
  return {
    kind: "allocation",
    unitId: context.fn.unitId,
    site: instruction.alloc,
    definitionId,
    view,
    memberOrdinal: ordinal,
  };
}
function mergeValue(model: Model, unit: string, value: number, domain: Domain): void {
  const key = valueKey(unit, value),
    before = model.values.get(key) ?? BOTTOM,
    after = join(before, domain);
  if (!same(before, after)) {
    model.values.set(key, after);
    model.changed = true;
  }
}
function read(flow: Flow, id: unknown): Domain {
  return flow.values.get(integer(id)) ?? BOTTOM;
}
function markEscaped(context: Context, domain: Domain, retained = false): void {
  if (domain.kind !== "known") return;
  context.escaped.push(...domain.roots);
  if (retained) context.retained.push(...domain.roots);
}
function taint(context: Context, flow: Flow, where: Location | null, reason: Reason): void {
  obligation(context.model, where, context.fn.unitId, reason);
  context.mayThrow = true;
  for (const [id, state] of flow.globals)
    flow.globals.set(id, {
      ...state,
      initialization: state.initialization === "initialized" ? "initialized" : "maybe",
      domain: UNKNOWN,
    });
  for (const [id, cell] of flow.heap) flow.heap.set(id, { ...cell, presence: "maybe", valueDomain: UNKNOWN });
  abruptReturn(context, flow);
}
function abruptReturn(context: Context, flow: World): void {
  joinUnitWorld(context.model, context.model.abruptWorlds, context.fn.unitId, flow);
}
function globalId(ref: unknown): IrBindingId {
  return identifier(record(record(ref).binding).bindingId) as IrBindingId;
}
function initialModel(input: Input, complete: Population, phase: Model["phase"], baseline?: World): Model {
  const initialWorld: World = { globals: new Map(), heap: new Map(), roots: new Set() };
  const model: Model = {
    input,
    population: complete,
    phase,
    baseline,
    history: undefined,
    abruptWorlds: new Map(),
    thrown: new Map(),
    parameters: new Map(),
    reachable: new Set(),
    summaries: new Map(),
    retained: new Map(),
    values: new Map(),
    globals: new Map(),
    heap: new Map(),
    observedRoots: new Set(),
    initialWorld,
    entryWorlds: new Map(),
    normalWorlds: new Map(),
    cyclicBlocks: new Map(),
    calls: new Map(),
    edges: new Map(),
    obligations: new Map(),
    completions: new Set(),
    changed: false,
  };
  for (const fn of input.module.functions) {
    model.cyclicBlocks.set(fn.unitId, cycleBlocks(fn));
    model.parameters.set(
      fn.unitId,
      fn.params.map(() => BOTTOM),
    );
    model.summaries.set(fn.unitId, {
      unitId: fn.unitId,
      parameterDomains: fn.params.map(() => BOTTOM),
      normalResultDomains: fn.resultTypes.map(() => BOTTOM),
      normalCompletion: false,
      mayThrow: false,
      readsGlobals: [],
      writesGlobals: [],
      escapedRoots: [],
    });
    for (const value of complete.definitions.get(fn.unitId)!) model.values.set(valueKey(fn.unitId, value), BOTTOM);
  }
  for (const row of input.globals) {
    let domain: Domain = BOTTOM;
    if (row.initial.kind === "unknown") domain = UNKNOWN;
    if (row.initial.kind === "constant") domain = constant(row.initial.value, row.type);
    if (row.initial.kind === "issued-builtin")
      domain = known(["Function"], [{ kind: "external", bindingId: row.ref.binding.bindingId }]);
    const state: GlobalState = {
      bindingId: row.ref.binding.bindingId,
      initialization: row.initial.kind === "uninitialized" ? "uninitialized" : "initialized",
      domain,
    };
    initialWorld.globals.set(globalId(row.ref), state);
    model.globals.set(globalId(row.ref), state);
  }
  return model;
}
function makeReachable(model: Model, unit: string): void {
  if (!model.reachable.has(unit)) {
    model.reachable.add(unit);
    model.changed = true;
  }
}
/** Entry state is transported in program order, never from the report's union. */
function seedRoots(model: Model): void {
  if (model.phase === "startup") {
    let world = model.initialWorld;
    for (const unit of model.input.startupUnits) {
      const fn = model.population.functions.get(unit)!;
      if (fn.params.length) fail("startup invocation requires explicit no-user-argument body");
      makeReachable(model, unit);
      joinUnitWorld(model, model.entryWorlds, unit, world);
      const normal = model.normalWorlds.get(unit);
      if (!model.completions.has(unit) || !normal) return;
      world = normal;
    }
    return;
  }
  if (!model.baseline) return;
  const world = model.history ? joinWorld(model.baseline, model.history) : model.baseline;
  for (const row of model.input.exports) {
    const fn = unitTarget(model.input, row.target)!;
    makeReachable(model, fn.unitId);
    joinUnitWorld(model, model.entryWorlds, fn.unitId, world);
    const previous = model.parameters.get(fn.unitId)!,
      after = previous.map((value) => join(value, UNKNOWN));
    if (!same(previous, after)) {
      model.parameters.set(fn.unitId, after);
      model.changed = true;
    }
  }
}

function definition(model: Model, id: unknown): IrJsClassDefinition {
  const row = model.input.definitions.find((row) => row.bindingId === id);
  if (!row) fail("foreign class descriptor");
  return row.definition;
}
function graphRoot(
  root: Extract<Root, { kind: "allocation" }>,
  view: Extract<Root, { kind: "allocation" }>["view"],
  memberOrdinal: number | null = null,
): Root {
  return { ...root, view, memberOrdinal };
}
function targets(model: Model, domain: Domain, construct: boolean): readonly Target[] {
  if (domain.kind !== "known") return [];
  const result = new Map<string, Target>();
  for (const root of domain.roots) {
    if (root.kind === "external") {
      if (construct) continue;
      const global = model.input.globals.find((row) => row.ref.binding.bindingId === root.bindingId);
      if (global?.initial.kind !== "issued-builtin") continue;
      const fn = unitTarget(model.input, global.initial.target)!;
      result.set(stable(global.initial.target), {
        target: global.initial.target,
        unitId: fn.unitId,
        definitionId: null,
        sourceBodyKind: null,
      });
      continue;
    }
    if (!root.definitionId) continue;
    const descriptor = definition(model, root.definitionId);
    const body =
      construct && root.view === "constructor"
        ? descriptor.constructor
        : !construct && root.view === "method"
          ? descriptor.members.find((member) => member.sourceOrdinal === root.memberOrdinal)?.body
          : undefined;
    if (body)
      result.set(stable(body.target), {
        target: body.target,
        unitId: body.unitId,
        definitionId: root.definitionId,
        sourceBodyKind: body.sourceBodyKind,
      });
  }
  return [...result.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}
function propagate(context: Context, flow: Flow, target: Target, args: readonly Domain[], where: Location): Domain {
  const model = context.model,
    fn = model.population.functions.get(target.unitId);
  if (!fn) fail("callee unit missing");
  if (args.length !== fn.params.length) fail("internal call actual argument census");
  makeReachable(model, fn.unitId);
  joinUnitWorld(model, model.entryWorlds, fn.unitId, flow);
  const before = model.parameters.get(fn.unitId)!,
    after = before.map((value, index) => join(value, args[index]!));
  if (!same(before, after)) {
    model.parameters.set(fn.unitId, after);
    model.changed = true;
  }
  const edge: Edge = {
    fromUnitId: context.fn.unitId,
    fromBlockOrdinal: where.blockOrdinal,
    toUnitId: fn.unitId,
    toBlockOrdinal: 0,
    kind: "call",
  };
  model.edges.set(stable(edge), edge);
  const summary = model.summaries.get(fn.unitId)!;
  context.mayThrow ||= summary.mayThrow;
  const abrupt = model.abruptWorlds.get(fn.unitId);
  if (abrupt) abruptReturn(context, joinWorld(flow, abrupt));
  const thrown = model.thrown.get(fn.unitId) ?? [];
  context.thrown.push(...thrown);
  context.escaped.push(...thrown);
  for (const id of summary.readsGlobals) context.reads.add(id);
  for (const id of summary.writesGlobals) context.writes.add(id);
  // Returning a borrowed self escapes the callee activation, but returning it
  // to its allocating caller does not by itself extend the caller lifetime.
  const retained = model.retained.get(fn.unitId) ?? [];
  context.escaped.push(...retained);
  context.retained.push(...retained);
  const normal = model.normalWorlds.get(fn.unitId);
  if (!summary.normalCompletion || !normal) return BOTTOM;
  Object.assign(flow, joinWorld(flow, normal));
  if (fn.resultTypes.length > 1) {
    obligation(model, where, context.fn.unitId, "unsupported-value");
    return UNKNOWN;
  }
  return fn.resultTypes.length
    ? summary.normalResultDomains[0]!
    : model.completions.has(fn.unitId)
      ? known(["Undefined"])
      : BOTTOM;
}
function hidden(
  context: Context,
  target: Target,
  callable: Domain,
  receiver: Domain,
  newTarget: Domain = UNKNOWN,
): readonly Domain[] {
  const descriptor = definition(context.model, target.definitionId),
    candidate =
      callable.kind === "known"
        ? callable.roots.find((root) => root.kind === "allocation" && root.definitionId === target.definitionId)
        : undefined;
  if (!candidate || candidate.kind !== "allocation") return [UNKNOWN, receiver, UNKNOWN, UNKNOWN];
  const member = descriptor.members.find((member) => member.body.unitId === target.unitId),
    isStatic = member?.static === true;
  return [
    known(["Object"], [graphRoot(candidate, "environment")]),
    receiver,
    known([isStatic ? "Function" : "Object"], [graphRoot(candidate, isStatic ? "constructor" : "prototype")]),
    newTarget,
  ];
}
function closedNoncallable(domain: Domain, construct: boolean): boolean {
  if (domain.kind !== "known") return false;
  if (!domain.families.includes("Function")) return true;
  return (
    domain.roots.length > 0 &&
    domain.roots.every(
      (root) =>
        root.kind === "allocation" &&
        root.definitionId !== null &&
        root.view === (construct ? "method" : "constructor"),
    )
  );
}
function call(context: Context, flow: Flow, item: IrInstr, where: Location): Domain {
  const model = context.model,
    row = item as unknown as Data;
  const direct = item.kind === "call",
    construct = item.kind === "js.class.construct";
  const argumentDomains = array(row.args).map((id) => read(flow, id));
  const calleeDomain: Domain = direct ? UNKNOWN : read(flow, row.callable ?? row.constructor);
  let receiverDomain: Domain | null = direct ? null : construct ? BOTTOM : read(flow, row.receiver);
  let candidates: readonly Target[];
  if (direct) {
    const fn = unitTarget(model.input, row.target as IrFuncRef),
      unit = model.input.units.find((unit) => unit.unitId === fn?.unitId);
    candidates =
      fn && unit
        ? [{ target: unit.target, unitId: fn.unitId, definitionId: null, sourceBodyKind: unit.sourceBodyKind }]
        : [];
  } else candidates = targets(model, calleeDomain, construct);
  const obligations: Obligation[] = [];
  let normal: Domain = BOTTOM;
  let callMayThrow = !direct;
  if (
    (!direct && calleeDomain.kind === "unknown") ||
    (!candidates.length &&
      !closedNoncallable(calleeDomain, construct) &&
      (direct || (calleeDomain.kind === "known" && contains(calleeDomain, "Function"))))
  ) {
    callMayThrow = true;
    normal = UNKNOWN;
    if (direct && model.population.nativeReferenceCalls?.get(context.fn)?.has(item)) {
      context.mayThrow = true;
      abruptReturn(context, flow);
    } else {
      obligations.push(obligation(model, where, context.fn.unitId, "unknown-callee"));
      obligations.push(obligation(model, where, context.fn.unitId, "opaque-effect"));
      if (construct) receiverDomain = UNKNOWN;
      markEscaped(context, calleeDomain, true);
      for (const value of argumentDomains) markEscaped(context, value, true);
      if (receiverDomain) markEscaped(context, receiverDomain, true);
      taint(context, flow, where, "opaque-effect");
    }
  }
  for (const target of candidates) {
    const fn = model.population.functions.get(target.unitId)!;
    if (direct && target.sourceBodyKind !== null) {
      obligations.push(obligation(model, where, context.fn.unitId, "missing-argument-adaptation"));
      normal = UNKNOWN;
      continue;
    }
    let receiver = receiverDomain ?? known(["Undefined"]),
      actualArgs: Domain[] = [];
    if (construct) {
      if (target.definitionId === null) {
        obligations.push(obligation(model, where, context.fn.unitId, "unknown-callee"));
        taint(context, flow, where, "opaque-effect");
        receiverDomain = UNKNOWN;
        normal = UNKNOWN;
        continue;
      }
      const self = allocation(context, item, "object", target.definitionId);
      receiver = known(["Object"], [self]);
      receiverDomain = join(receiverDomain ?? BOTTOM, receiver);
      flow.roots.add(stable(self));
      const descriptor = definition(model, target.definitionId);
      const newTarget = read(flow, row.newTarget),
        prototype = readProperty(context, flow, newTarget, { kind: "literal", value: "prototype" }, where);
      storeCell(
        flow,
        self,
        { kind: "internal", value: "prototype" },
        prototype.kind !== "known" || !prototype.roots.length ? UNKNOWN : BOTTOM,
        "present",
        prototype.kind === "known" ? prototype.roots : [],
      );
      let initializersReturn = true;
      for (const field of descriptor.instanceElements) {
        let value: Domain = known(["Undefined"]);
        if (field.initializer) {
          const initializer: Target = {
            target: field.initializer.target,
            unitId: field.initializer.unitId,
            definitionId: target.definitionId,
            sourceBodyKind: "field-initializer",
          };
          value = propagate(
            context,
            flow,
            initializer,
            hidden(context, { ...target, sourceBodyKind: "field-initializer" }, calleeDomain, receiver, newTarget),
            where,
          );
          if (value.kind === "bottom") {
            initializersReturn = false;
            break;
          }
        }
        storeCell(flow, self, { kind: "literal", value: field.name }, value);
      }
      if (!initializersReturn) continue;
    }
    if (target.definitionId !== null)
      actualArgs.push(
        ...hidden(context, target, calleeDomain, receiver, construct ? read(flow, row.newTarget) : UNKNOWN),
      );
    const prefix = actualArgs.length;
    for (let index = prefix; index < fn.params.length; index++) {
      const value = argumentDomains[index - prefix] ?? known(["Undefined"]),
        type = fn.params[index]!.type;
      if (type.kind !== "dynamic" && target.definitionId !== null) {
        const expected = numberType(type);
        if (
          expected.kind === "unknown" ||
          !same(expected.kind === "known" ? expected.families : [], value.kind === "known" ? value.families : [])
        ) {
          obligations.push(obligation(model, where, context.fn.unitId, "missing-argument-adaptation"));
          actualArgs.push(UNKNOWN);
          continue;
        }
      }
      actualArgs.push(value);
    }
    if (direct && argumentDomains.length !== fn.params.length) {
      obligations.push(obligation(model, where, context.fn.unitId, "missing-argument-adaptation"));
      normal = UNKNOWN;
      continue;
    }
    callMayThrow ||= model.summaries.get(target.unitId)!.mayThrow;
    const returned = propagate(context, flow, target, actualArgs, where);
    if (!construct) normal = join(normal, returned);
    if (construct && returned.kind !== "known") normal = join(normal, returned);
    if (construct && returned.kind === "known") {
      const replacement = known(
        returned.families.filter((f) => f === "Object" || f === "Function"),
        returned.roots,
      );
      normal = join(normal, replacement);
      if (returned.families.some((f) => f !== "Object" && f !== "Function")) normal = join(normal, receiver);
    }
  }
  // Known calls propagate actual callee escapes through their summaries.
  // Opaque calls already taint and expose their actual operands above.
  if (!direct) {
    context.mayThrow = true;
    abruptReturn(context, flow);
  }
  const observed: Call = copyPreparedIrDataObject({
    location: where,
    kind: direct ? "direct" : construct ? "construct" : "invoke",
    calleeDomain,
    receiverDomain,
    argumentDomains,
    targets: candidates,
    normalDomain: normal,
    mayThrow: callMayThrow,
    obligations: orderedObligations(obligations),
  } satisfies Call) as unknown as Call;
  const id = stable(where),
    before = model.calls.get(id);
  if (!before || !same(before, observed)) {
    model.calls.set(id, observed);
    model.changed = true;
  }
  return normal;
}
function readProperty(context: Context, flow: Flow, receiver: Domain, key: Cell["key"], where: Location): Domain {
  if (receiver.kind === "bottom") return BOTTOM;
  if (receiver.kind !== "known" || !receiver.roots.length) {
    if (key.kind !== "internal") taint(context, flow, where, "unknown-property");
    else obligation(context.model, where, context.fn.unitId, "unknown-property");
    return UNKNOWN;
  }
  if (key.kind === "wildcard") {
    taint(context, flow, where, "unknown-property");
    return UNKNOWN;
  }
  const seen = new Set<string>();
  const lookup = (root: Root): Domain => {
    if (root.kind === "external") return UNKNOWN;
    const id = stable(root);
    if (seen.has(id)) return UNKNOWN;
    seen.add(id);
    const cell = flow.heap.get(cellKey(root, key)),
      wildcard = flow.heap.get(cellKey(root, { kind: "wildcard" }));
    if (wildcard?.valueDomain.kind === "unknown") return UNKNOWN;
    let value = cell?.valueDomain ?? BOTTOM;
    if (!cell || cell.presence !== "present") {
      const link = flow.heap.get(cellKey(root, { kind: "internal", value: "prototype" })),
        prototypes = link?.prototypeRoots ?? [];
      if (link?.valueDomain.kind === "unknown") value = UNKNOWN;
      else if (prototypes.length) for (const prototype of prototypes) value = join(value, lookup(prototype));
      else if (link?.valueDomain.kind === "known" && link.valueDomain.families.every((family) => family === "Null"))
        value = join(value, known(["Undefined"]));
      else value = UNKNOWN;
    }
    if (wildcard) value = join(value, wildcard.valueDomain);
    return value;
  };
  let result: Domain = BOTTOM;
  for (const root of receiver.roots) result = join(result, root.kind === "external" ? UNKNOWN : lookup(root));
  if (result.kind === "unknown" && key.kind !== "internal") taint(context, flow, where, "unknown-property");
  return result;
}
function propertyKey(value: unknown): Cell["key"] {
  const key = record(value);
  if (key.kind === "string" && typeof key.value === "string") return { kind: "literal", value: key.value };
  if (key.kind === "computed") return { kind: "wildcard" };
  fail("property key grammar");
}

function graph(context: Context, flow: Flow, item: IrInstr): Domain {
  const data = item as unknown as Data,
    id = data.definition as Input["definitions"][number]["bindingId"],
    descriptor = definition(context.model, id);
  const constructorRoot = allocation(context, item, "constructor", id) as Extract<Root, { kind: "allocation" }>;
  const prototype = graphRoot(constructorRoot, "prototype"),
    environment = graphRoot(constructorRoot, "environment");
  for (const root of [constructorRoot, prototype, environment]) flow.roots.add(stable(root));
  storeCell(flow, constructorRoot, { kind: "literal", value: "prototype" }, known(["Object"], [prototype]));
  storeCell(flow, prototype, { kind: "literal", value: "constructor" }, known(["Function"], [constructorRoot]));
  for (const [root, id] of [
    [constructorRoot, descriptor.realm.functionPrototype],
    [prototype, descriptor.realm.objectPrototype],
  ] as const) {
    // The descriptor identifies the realm storage root, independently of its
    // unknown contents. Following that external prototype still yields UNKNOWN.
    storeCell(flow, root, { kind: "internal", value: "prototype" }, BOTTOM, "present", [
      { kind: "external", bindingId: id },
    ]);
  }
  storeCell(flow, constructorRoot, { kind: "internal", value: "environment" }, known(["Object"], [environment]));
  for (const member of descriptor.members) {
    const method = graphRoot(constructorRoot, "method", member.sourceOrdinal);
    flow.roots.add(stable(method));
    storeCell(flow, method, { kind: "internal", value: "prototype" }, BOTTOM, "present", [
      { kind: "external", bindingId: descriptor.realm.functionPrototype },
    ]);
    storeCell(flow, method, { kind: "internal", value: "environment" }, known(["Object"], [environment]));
    storeCell(
      flow,
      member.static ? constructorRoot : prototype,
      { kind: "literal", value: member.name },
      known(["Function"], [method]),
    );
  }
  const actualCaptures = array(data.captures),
    captures = descriptor.captures.filter((capture) => capture.mode !== "live-global");
  if (actualCaptures.length !== captures.length) fail("definition captured operand census");
  let actualIndex = 0;
  for (const [index, capture] of descriptor.captures.entries())
    if (capture.mode !== "live-global")
      storeCell(
        flow,
        environment,
        { kind: "internal", value: `capture:${index}` },
        read(flow, actualCaptures[actualIndex++]),
      );
  if (descriptor.innerBinding) {
    const cell = graphRoot(constructorRoot, "binding-cell");
    flow.roots.add(stable(cell));
    storeCell(
      flow,
      environment,
      { kind: "internal", value: `capture:${descriptor.captures.length}` },
      known(["Object"], [cell]),
    );
    storeCell(flow, cell, { kind: "internal", value: "binding-value" }, known(["Function"], [constructorRoot]));
  }
  return known(["Function"], [constructorRoot]);
}
function binding(context: Context, flow: Flow, item: IrInstr, where: Location): Domain {
  const row = item as unknown as Data,
    storage = record(row.storage),
    id = identifier(storage.bindingId);
  const descriptor = context.model.input.definitions
    .map((row) => row.definition)
    .find((row) => row.outerBinding?.id === id || row.innerBinding?.id === id);
  const contract = descriptor?.outerBinding?.id === id ? descriptor.outerBinding : descriptor?.innerBinding;
  if (!contract) fail("binding operation lacks original binding contract");
  let state: GlobalState | undefined;
  if (storage.kind === "module") {
    if (!contract.valueGlobal) fail("module binding has no actual value global");
    state = flow.globals.get(globalId(contract.valueGlobal));
  } else if (storage.kind !== "cell") fail("binding storage grammar");
  if (item.kind === "js.class.binding.read") {
    context.mayThrow = true;
    abruptReturn(context, flow);
    if (state) {
      context.reads.add(state.bindingId);
      if (contract.tdzGlobal) context.reads.add(globalId(contract.tdzGlobal));
      if (state.initialization === "maybe") {
        obligation(context.model, where, context.fn.unitId, "mutable-binding-carrier");
        return UNKNOWN;
      }
      return state.initialization === "uninitialized" ? BOTTOM : state.domain;
    }
    return readProperty(context, flow, read(flow, storage.cell), { kind: "internal", value: "binding-value" }, where);
  }
  const value = read(flow, row.value);
  markEscaped(context, value, state !== undefined);
  if (item.kind === "js.class.binding.write") {
    context.mayThrow = true;
    abruptReturn(context, flow);
    if (contract.tdzGlobal) context.reads.add(globalId(contract.tdzGlobal));
    if (!contract.mutable || state?.initialization === "uninitialized") {
      flow.alive = false;
      return BOTTOM;
    }
  }
  if (state) {
    context.writes.add(state.bindingId);
    if (item.kind === "js.class.binding.init" && contract.tdzGlobal) context.writes.add(globalId(contract.tdzGlobal));
    flow.globals.set(state.bindingId, {
      ...state,
      initialization: "initialized",
      domain: join(item.kind === "js.class.binding.init" ? BOTTOM : state.domain, value),
    });
  } else {
    const cells = read(flow, storage.cell);
    if (cells.kind !== "known") {
      taint(context, flow, where, "mutable-binding-carrier");
      return UNKNOWN;
    }
    for (const root of cells.roots) storeCell(flow, root, { kind: "internal", value: "binding-value" }, value);
  }
  return BOTTOM;
}
function frame(context: Context, flow: Flow, item: IrInstr, where: Location): Domain {
  const row = item as unknown as Data;
  if (item.kind === "js.class.frame.new") {
    const root = allocation(context, item, "frame", row.definition as Input["definitions"][number]["bindingId"]),
      values = [
        read(flow, row.environment),
        read(flow, row.thisValue),
        read(flow, row.homeObject),
        read(flow, row.newTarget),
      ];
    flow.roots.add(stable(root));
    for (const [index, key] of ["environment", "this", "home-object", "new-target"].entries())
      storeCell(flow, root, { kind: "internal", value: key }, values[index]!);
    return known(["Object"], [root]);
  }
  const access = record(row.access),
    frames = read(flow, row.frame);
  if (frames.kind !== "known") return frames.kind === "bottom" ? BOTTOM : UNKNOWN;
  let result: Domain = BOTTOM;
  for (const root of frames.roots) {
    if (root.kind !== "allocation" || root.view !== "frame" || !root.definitionId) {
      result = join(result, UNKNOWN);
      continue;
    }
    const captured = ["environment", "this", "home-object", "new-target"].map(
      (value) => flow.heap.get(cellKey(root, { kind: "internal", value }))?.valueDomain ?? BOTTOM,
    );
    const index = ["environment", "this", "home-object", "new-target"].indexOf(access.kind as string);
    if (index >= 0) {
      result = join(result, captured[index]!);
      continue;
    }
    if (access.kind !== "capture") {
      obligation(context.model, where, context.fn.unitId, "unsupported-value");
      result = UNKNOWN;
      continue;
    }
    const descriptor = definition(context.model, root.definitionId),
      body = [
        descriptor.constructor,
        ...descriptor.members.map((member) => member.body),
        ...descriptor.instanceElements.flatMap((field) => (field.initializer ? [field.initializer] : [])),
      ].find((body) => body.unitId === context.fn.unitId);
    const capture = body?.frame.captures[integer(access.index)];
    if (!capture) fail("actual frame capture index");
    if (capture.mode === "live-global") {
      if (!capture.valueGlobal || !capture.tdzGlobal) fail("live global capture target");
      const state = flow.globals.get(globalId(capture.valueGlobal)),
        tdz = flow.globals.get(globalId(capture.tdzGlobal));
      if (!state || !tdz) fail("captured global absent");
      context.reads.add(state.bindingId);
      context.reads.add(tdz.bindingId);
      context.mayThrow = true;
      if (state.initialization === "maybe") {
        obligation(context.model, where, context.fn.unitId, "mutable-binding-carrier");
        result = UNKNOWN;
      } else result = join(result, state.initialization === "uninitialized" ? BOTTOM : state.domain);
    } else {
      const externalIndex = descriptor.captures.findIndex((row) => row.bindingId === capture.bindingId),
        ordinal =
          externalIndex >= 0
            ? externalIndex
            : descriptor.innerBinding?.id === capture.bindingId
              ? descriptor.captures.length
              : -1;
      if (ordinal < 0) fail("capture lacks actual definition environment slot");
      result = join(
        result,
        readProperty(context, flow, captured[0]!, { kind: "internal", value: `capture:${ordinal}` }, where),
      );
    }
  }
  return result;
}
function primitive(context: Context, flow: Flow, item: IrInstr, where: Location): Domain | undefined {
  const row = item as unknown as Data,
    model = context.model;
  if (item.kind === "const") {
    const domain = constant(row.value, item.resultType);
    if (domain.kind === "unknown") obligation(model, where, context.fn.unitId, "unsupported-value");
    return domain;
  }
  if (item.kind === "box") {
    const value = read(flow, row.value),
      target = record(row.toType);
    if (target.kind !== "dynamic") {
      obligation(model, where, context.fn.unitId, "unsupported-value");
      return UNKNOWN;
    }
    const expected =
      target.tag === JS_TAG_IDS.NumberF64 || target.tag === JS_TAG_IDS.NumberI32
        ? "Number"
        : target.tag === JS_TAG_IDS.Boolean
          ? "Boolean"
          : target.tag === JS_TAG_IDS.String
            ? "String"
            : target.tag === JS_TAG_IDS.Object
              ? "Object"
              : target.tag === JS_TAG_IDS.Function
                ? "Function"
                : undefined;
    if (!expected) {
      obligation(model, where, context.fn.unitId, "unsupported-value");
      return UNKNOWN;
    }
    if (value.kind === "bottom") return BOTTOM;
    if (value.kind === "unknown") {
      obligation(model, where, context.fn.unitId, "unsupported-value");
      return UNKNOWN;
    }
    if (value.families.length !== 1 || value.families[0] !== expected) fail("box actual family/tag mismatch");
    return value;
  }
  if (item.kind === "unbox") {
    const source = read(flow, row.value),
      family =
        row.tagId === JS_TAG_IDS.NumberF64 || row.tagId === JS_TAG_IDS.NumberI32
          ? "Number"
          : row.tagId === JS_TAG_IDS.Boolean
            ? "Boolean"
            : row.tagId === JS_TAG_IDS.String
              ? "String"
              : row.tagId === JS_TAG_IDS.Object
                ? "Object"
                : row.tagId === JS_TAG_IDS.Function
                  ? "Function"
                  : undefined;
    if (source.kind === "bottom") return BOTTOM;
    const producer = model.population.occurrences.find(
      (occurrence) => occurrence.fn.unitId === context.fn.unitId && occurrence.instruction.result === row.value,
    )?.instruction;
    if (
      producer?.kind === "box" &&
      producer.toType.kind === "dynamic" &&
      producer.toType.tag === row.tagId &&
      family &&
      source.kind === "known" &&
      source.families.every((value) => value === family)
    )
      return source;
    obligation(model, where, context.fn.unitId, "unsafe-scalar-projection");
    return UNKNOWN;
  }
  if (item.kind === "dyn.eq" && item.loose) {
    const lhs = read(flow, item.lhs),
      rhs = read(flow, item.rhs);
    if (
      [lhs, rhs].some(
        (domain) => domain.kind === "unknown" || contains(domain, "Object") || contains(domain, "Function"),
      )
    )
      taint(context, flow, where, "opaque-effect");
  }
  if (["tag.test", "dyn.truthy", "dyn.eq", "js.class.identity", "js.class.instanceof"].includes(item.kind)) {
    if (directUses(item).some((value) => read(flow, value).kind === "bottom")) return BOTTOM;
    if (item.kind === "js.class.instanceof") taint(context, flow, where, "opaque-effect");
    return known(["Boolean"]);
  }
  if (item.kind === "dyn.to_number") {
    const value = read(flow, row.value);
    if (value.kind === "bottom") return BOTTOM;
    if (value.kind === "unknown" || contains(value, "Object") || contains(value, "Function"))
      taint(context, flow, where, "opaque-effect");
    return known(["Number"]);
  }
  if (item.kind === "string.const") return known(["String"]);
  if (item.kind === "binary" || item.kind === "unary") {
    const operands = item.kind === "binary" ? [read(flow, row.lhs), read(flow, row.rhs)] : [read(flow, row.rand)],
      op = identifier(row.op);
    if (operands.some((value) => value.kind === "bottom")) return BOTTOM;
    if (op === "ref.is_null") return known(["Boolean"]);
    if (operands.some((value) => value.kind === "unknown")) {
      obligation(model, where, context.fn.unitId, "unsafe-scalar-projection");
      return UNKNOWN;
    }
    if (
      operands.some(
        (value) =>
          value.kind === "known" && value.families.some((family) => family !== "Number" && family !== "Boolean"),
      )
    )
      fail("scalar op actual value family");
    const boolean =
      /\.(eq|ne|lt|le|gt|ge|lt_s|lt_u|le_s|le_u|gt_s|gt_u|ge_s|ge_u|eqz)$/.test(op) ||
      ((op === "i32.and" || op === "i32.or") && operands.every((value) => contains(value, "Boolean")));
    return known([boolean ? "Boolean" : "Number"]);
  }
  if (item.kind === "select") return join(read(flow, row.whenTrue), read(flow, row.whenFalse));
  return undefined;
}
function transfer(context: Context, flow: Flow, item: IrInstr, where: Location): Domain {
  const row = item as unknown as Data,
    model = context.model,
    kind = String(row.kind);
  const simple = primitive(context, flow, item, where);
  if (simple !== undefined) return simple;
  if (kind === "call" || kind === "js.class.invoke" || kind === "js.class.construct")
    return call(context, flow, item, where);
  if (kind === "js.class.define") return graph(context, flow, item);
  if (kind === "js.class.frame.new" || kind === "js.class.frame.get") return frame(context, flow, item, where);
  if (kind === "js.class.binding.read" || kind === "js.class.binding.init" || kind === "js.class.binding.write")
    return binding(context, flow, item, where);
  if (kind === "js.class.binding.new") {
    const root = allocation(context, item, "binding-cell", null);
    flow.roots.add(stable(root));
    return known(["Object"], [root]);
  }
  if (kind === "js.class.constructor.complete") {
    const completion = record(row.completion),
      self = read(flow, row.self);
    if (completion.kind === "normal") return self;
    if (completion.kind !== "return") fail("constructor completion grammar");
    const value = read(flow, completion.value);
    if (value.kind !== "known") return value;
    return join(
      known(
        value.families.filter((family) => family === "Object" || family === "Function"),
        value.roots,
      ),
      value.families.some((family) => family !== "Object" && family !== "Function") ? self : BOTTOM,
    );
  }
  if (kind === "js.class.property.get") {
    context.mayThrow = true;
    abruptReturn(context, flow);
    return readProperty(context, flow, read(flow, row.receiver), propertyKey(row.key), where);
  }
  if (kind === "js.class.property.set" || kind === "js.class.property.define") {
    const receiver = read(flow, row.receiver),
      value = read(flow, row.value),
      key = propertyKey(row.key);
    context.mayThrow = true;
    abruptReturn(context, flow);
    // No private freshness proof permits assuming the receiver cannot retain
    // this value beyond the activation, including a borrowed receiver.
    markEscaped(context, value, true);
    if (
      (kind === "js.class.property.set" && !propertyWriteIsClosed(flow, receiver, key)) ||
      (kind === "js.class.property.define" &&
        (record(row.attributes).writable !== true || record(row.attributes).configurable !== true))
    ) {
      taint(context, flow, where, "unknown-property");
      markEscaped(context, receiver, true);
      if (receiver.kind === "known") for (const root of receiver.roots) storeCell(flow, root, key, UNKNOWN, "maybe");
      return BOTTOM;
    }
    if (receiver.kind === "known")
      for (const root of receiver.roots) {
        const id = cellKey(root, key),
          old = flow.heap.get(id);
        if (!old && flow.roots.has(stable(root)))
          flow.heap.set(id, { root, key, presence: "absent", valueDomain: BOTTOM, prototypeRoots: [] });
        storeCell(flow, root, key, value);
        if (key.kind === "wildcard")
          for (const [id, cell] of flow.heap)
            if (same(cell.root, root))
              flow.heap.set(id, { ...cell, presence: "maybe", valueDomain: join(cell.valueDomain, value) });
      }
    else if (receiver.kind !== "bottom") taint(context, flow, where, "unknown-property");
    return BOTTOM;
  }
  if (kind === "global.get") {
    const id = globalId(row.target),
      state = flow.globals.get(id);
    if (!state) fail("global read absent from census");
    context.reads.add(id);
    if (state.initialization === "maybe") {
      obligation(model, where, context.fn.unitId, "mutable-binding-carrier");
      return UNKNOWN;
    }
    if (state.initialization === "uninitialized") {
      context.mayThrow = true;
      abruptReturn(context, flow);
      return BOTTOM;
    }
    return state.domain;
  }
  if (kind === "global.set") {
    const id = globalId(row.target),
      state = flow.globals.get(id),
      contract = model.input.globals.find((global) => global.ref.binding.bindingId === id);
    if (!state || !contract) fail("global write absent");
    if (!contract.mutable) fail("immutable global write");
    context.writes.add(id);
    const value = read(flow, row.value);
    markEscaped(context, value, true);
    flow.globals.set(id, { ...state, initialization: "initialized", domain: join(state.domain, value) });
    return BOTTOM;
  }
  if (kind === "slot.write") {
    flow.slots.set(integer(row.slotIndex), read(flow, row.value));
    return BOTTOM;
  }
  if (kind === "slot.read") return flow.slots.get(integer(row.slotIndex)) ?? UNKNOWN;
  if (kind === "throw" || kind === "throw.runtime" || kind === "unreachable") {
    if (typeof row.value === "number") {
      const value = read(flow, row.value);
      markEscaped(context, value);
      if (value.kind === "known") context.thrown.push(...value.roots);
    }
    context.mayThrow = true;
    abruptReturn(context, flow);
    flow.alive = false;
    return BOTTOM;
  }
  if (kind === "early.return") {
    if (row.value !== null) {
      const value = read(flow, row.value);
      context.returns[0] = join(context.returns[0] ?? BOTTOM, value);
      markEscaped(context, value);
    }
    normalReturn(context, flow);
    flow.alive = false;
    return BOTTOM;
  }
  if (kind === "refcell.new") {
    const root = allocation(context, item, "binding-cell", null);
    flow.roots.add(stable(root));
    storeCell(flow, root, { kind: "internal", value: "binding-value" }, read(flow, row.value));
    return known(["Object"], [root]);
  }
  if (kind === "refcell.get")
    return readProperty(context, flow, read(flow, row.cell), { kind: "internal", value: "binding-value" }, where);
  if (kind === "refcell.set") {
    const receiver = read(flow, row.cell),
      value = read(flow, row.value);
    if (receiver.kind === "known")
      for (const root of receiver.roots) storeCell(flow, root, { kind: "internal", value: "binding-value" }, value);
    else taint(context, flow, where, "opaque-effect");
    return BOTTOM;
  }
  if (kind === "vec.new_fixed" || kind === "object.new") {
    const root = allocation(context, item, "object", null);
    flow.roots.add(stable(root));
    if (kind === "vec.new_fixed")
      for (const [index, id] of array(row.elements).entries())
        storeCell(flow, root, { kind: "literal", value: String(index) }, read(flow, id));
    return known(["Object"], [root]);
  }
  if (kind === "drop" || kind === "nop") return BOTTOM;
  let nested = false;
  forEachNestedBuffer(item, () => {
    nested = true;
  });
  taint(context, flow, where, nested ? "unsupported-control" : "opaque-effect");
  obligation(model, where, context.fn.unitId, "unsupported-value");
  for (const operand of directUses(item)) markEscaped(context, read(flow, operand));
  return UNKNOWN;
}

function execute(context: Context, flow: Flow, instructions: readonly IrInstr[], path: readonly number[]): Flow {
  for (const [ordinal, item] of instructions.entries()) {
    const where = location(context.fn, context.blockOrdinal, path, ordinal);
    if (!flow.alive) continue;
    let result: Domain;
    if (item.kind === "if" || item.kind === "if.stmt") {
      const before = cloneFlow(flow),
        a = execute(context, cloneFlow(before), item.then, [...path, 0, ordinal]),
        b = execute(context, cloneFlow(before), item.else, [...path, 1, ordinal]);
      result =
        item.kind === "if"
          ? join(a.alive ? read(a, item.thenValue) : BOTTOM, b.alive ? read(b, item.elseValue) : BOTTOM)
          : BOTTOM;
      flow = combineFlow(a, b);
    } else {
      result = transfer(context, flow, item, where);
      let child = 0;
      forEachNestedBuffer(item, (buffer) => {
        const branch = cloneFlow(flow);
        execute(context, branch, buffer, [...path, child++, ordinal]);
        flow = combineFlow(flow, branch);
      });
    }
    if (item.result !== null) {
      flow.values.set(item.result, result);
      mergeValue(context.model, context.fn.unitId, item.result, result);
    }
    // Includes writes/frames before abrupt completion, without making them entries.
    commitFlow(context.model, flow);
    if (
      result.kind === "bottom" &&
      (item.result !== null ||
        item.kind === "call" ||
        item.kind === "js.class.invoke" ||
        item.kind === "js.class.construct")
    )
      flow.alive = false;
  }
  return flow;
}
function normalReturn(context: Context, flow: Flow): void {
  const model = context.model;
  if (!model.completions.has(context.fn.unitId)) {
    model.completions.add(context.fn.unitId);
    model.changed = true;
  }
  joinUnitWorld(model, model.normalWorlds, context.fn.unitId, flow);
}
function functionReplay(model: Model, fn: IrFunction): void {
  if (!model.reachable.has(fn.unitId)) return;
  const params = model.parameters.get(fn.unitId)!,
    returns = fn.resultTypes.map(() => BOTTOM),
    reads = new Set<IrBindingId>(),
    writes = new Set<IrBindingId>(),
    escaped: Root[] = [],
    retained: Root[] = [],
    thrown: Root[] = [];
  const world = model.entryWorlds.get(fn.unitId);
  if (!world) return;
  const entry: Flow = {
    ...cloneWorld(world),
    alive: true,
    values: new Map(fn.params.map((parameter, index) => [parameter.value, params[index]!])),
    slots: new Map(),
  };
  for (const [index, parameter] of fn.params.entries()) mergeValue(model, fn.unitId, parameter.value, params[index]!);
  if (fn.blocks[0]!.blockArgs.length) fail("entry block arguments lack actual incoming edge");
  const entries = new Map<number, Flow>([[0, entry]]),
    pending = [0];
  let mayThrow = false;
  while (pending.length) {
    const index = pending.shift()!,
      block = fn.blocks[index]!,
      incoming = entries.get(index)!;
    const context: Context = {
      model,
      fn,
      blockOrdinal: index,
      returns,
      reads,
      writes,
      escaped,
      retained,
      thrown,
      mayThrow,
    };
    for (const value of block.blockArgs) mergeValue(model, fn.unitId, value, read(incoming, value));
    const working = cloneFlow(incoming);
    if (model.cyclicBlocks.get(fn.unitId)?.has(index)) taint(context, working, null, "unsupported-control");
    const flow = execute(context, working, block.instrs, []);
    mayThrow ||= context.mayThrow;
    commitFlow(model, flow);
    if (!flow.alive) continue;
    const branch = (edge: { readonly target: number; readonly args: readonly number[] }) => {
      const target = fn.blocks.findIndex((block) => block.id === edge.target);
      if (target < 0) fail("CFG target missing");
      const after = cloneFlow(flow),
        destination = fn.blocks[target]!;
      for (const [i, value] of destination.blockArgs.entries()) after.values.set(value, read(flow, edge.args[i]));
      const old = entries.get(target),
        next = old ? combineFlow(old, after) : after;
      const row: Edge = {
        fromUnitId: fn.unitId,
        fromBlockOrdinal: index,
        toUnitId: fn.unitId,
        toBlockOrdinal: target,
        kind: "cfg",
      };
      model.edges.set(stable(row), row);
      if (!old || !same(flowData(old), flowData(next))) {
        entries.set(target, next);
        if (!pending.includes(target)) pending.push(target);
      }
    };
    const end = block.terminator;
    if (end.kind === "return") {
      for (const [i, value] of end.values.entries()) {
        returns[i] = join(returns[i]!, read(flow, value));
        markEscaped(context, read(flow, value));
      }
      normalReturn(context, flow);
    } else if (end.kind === "br") branch(end.branch);
    else if (end.kind === "br_if") {
      branch(end.ifTrue);
      branch(end.ifFalse);
    } else {
      mayThrow = true;
      abruptReturn(context, flow);
    }
  }
  const oldThrown = model.thrown.get(fn.unitId) ?? [],
    newThrown = roots([...oldThrown, ...thrown]);
  if (!same(oldThrown, newThrown)) {
    model.thrown.set(fn.unitId, newThrown);
    model.changed = true;
  }
  const previousRetained = model.retained.get(fn.unitId) ?? [],
    nextRetained = roots([...previousRetained, ...retained]);
  if (!same(previousRetained, nextRetained)) {
    model.retained.set(fn.unitId, nextRetained);
    model.changed = true;
  }
  const previous = model.summaries.get(fn.unitId)!;
  const unsupported = [...model.obligations.values()].some(
    (row) => row.unitId === fn.unitId && row.reason === "unsupported-control",
  );
  const next: FunctionState = copyPreparedIrDataObject({
    unitId: fn.unitId,
    parameterDomains: params,
    normalResultDomains: returns.map((value, index) => {
      const domain = join(previous.normalResultDomains[index]!, value);
      return unsupported && domain.kind !== "bottom" ? UNKNOWN : domain;
    }),
    normalCompletion: model.completions.has(fn.unitId),
    mayThrow: previous.mayThrow || mayThrow,
    readsGlobals: [...new Set([...previous.readsGlobals, ...reads])].sort(),
    writesGlobals: [...new Set([...previous.writesGlobals, ...writes])].sort(),
    escapedRoots: roots([...previous.escapedRoots, ...escaped]),
  } satisfies FunctionState) as unknown as FunctionState;
  if (!same(previous, next)) {
    model.summaries.set(fn.unitId, next);
    model.changed = true;
  }
}
function solvePhase(input: Input, complete: Population, phase: Model["phase"], baseline?: World): Model {
  const model = initialModel(input, complete, phase, baseline);
  for (const fn of input.module.functions)
    for (const [index, block] of fn.blocks.entries()) {
      const end = block.terminator,
        branches = end.kind === "br" ? [end.branch] : end.kind === "br_if" ? [end.ifTrue, end.ifFalse] : [];
      for (const branch of branches) {
        const row: Edge = {
          fromUnitId: fn.unitId,
          fromBlockOrdinal: index,
          toUnitId: fn.unitId,
          toBlockOrdinal: fn.blocks.findIndex((block) => block.id === branch.target),
          kind: "cfg",
        };
        model.edges.set(stable(row), row);
      }
    }
  for (let index = 1; index < input.startupUnits.length; index++) {
    const row: Edge = {
      fromUnitId: input.startupUnits[index - 1]!,
      fromBlockOrdinal: 0,
      toUnitId: input.startupUnits[index]!,
      toBlockOrdinal: 0,
      kind: "startup",
    };
    model.edges.set(stable(row), row);
  }
  const last = input.startupUnits.at(-1);
  if (last)
    for (const entry of input.exports) {
      const fn = unitTarget(input, entry.target)!;
      const row: Edge = {
        fromUnitId: last,
        fromBlockOrdinal: 0,
        toUnitId: fn.unitId,
        toBlockOrdinal: 0,
        kind: "startup",
      };
      model.edges.set(stable(row), row);
    }
  // Finite family/root/key universe and monotone unions. Never terminate by a
  // guessed iteration count or turn a truncated target list into a proof.
  do {
    model.changed = false;
    seedRoots(model);
    for (const unit of input.startupUnits) functionReplay(model, complete.functions.get(unit)!);
    for (const fn of input.module.functions) if (!input.startupUnits.includes(fn.unitId)) functionReplay(model, fn);
    updatePublicHistory(model);
  } while (model.changed);
  return model;
}
function leastFixedPoint(input: Input, complete: Population): Model {
  const startup = solvePhase(input, complete, "startup"),
    last = input.startupUnits.at(-1);
  const baseline = last ? startup.normalWorlds.get(last) : startup.initialWorld;
  const ready = input.startupUnits.every((unit) => startup.completions.has(unit));
  return mergePhaseModels(startup, solvePhase(input, complete, "public", ready ? baseline : undefined));
}
function resultRows(model: Model): Result {
  const input = model.input,
    complete = model.population;
  const values: Result["values"][number][] = [];
  for (const fn of input.module.functions)
    for (const value of complete.definitions.get(fn.unitId)!)
      values.push({
        unitId: fn.unitId,
        value: value as Result["values"][number]["value"],
        domain: model.values.get(valueKey(fn.unitId, value)) ?? BOTTOM,
      });
  values.sort((a, b) => a.unitId.localeCompare(b.unitId) || a.value - b.value);
  for (const occurrence of complete.occurrences) {
    const item = occurrence.instruction;
    if (item.kind !== "call" && item.kind !== "js.class.invoke" && item.kind !== "js.class.construct") continue;
    const where = location(
        occurrence.fn,
        occurrence.blockOrdinal,
        occurrence.nestedPath,
        occurrence.instructionOrdinal,
      ),
      key = stable(where);
    if (!model.calls.has(key))
      model.calls.set(key, {
        location: where,
        kind: item.kind === "call" ? "direct" : item.kind === "js.class.invoke" ? "invoke" : "construct",
        calleeDomain: BOTTOM,
        receiverDomain: item.kind === "call" ? null : BOTTOM,
        argumentDomains: item.args.map(() => BOTTOM),
        targets: [],
        normalDomain: BOTTOM,
        mayThrow: false,
        obligations: [],
      });
  }
  const obligations = [...model.obligations].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  const projected = projectNativeJsClassValueDomains(
    input,
    model.projectionSummaries ?? model.summaries,
    [...model.edges.values()],
    obligations,
  );
  return {
    schema: "native-js-class-value-domain-result-v1",
    namespace: input.namespace,
    census: complete.census,
    values,
    calls: [...model.calls].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    functions: [...model.summaries].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    globals: [...model.globals].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    heap: [...model.heap].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    edges: [...model.edges].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    projections: projected.projections,
    obligations: projected.obligations,
  };
}

function outputPopulation(proposed: unknown): Result {
  const row = record(proposed);
  fields(row, [
    "schema",
    "namespace",
    "census",
    "values",
    "calls",
    "functions",
    "globals",
    "heap",
    "edges",
    "projections",
    "obligations",
  ]);
  if (
    row.schema !== "native-js-class-value-domain-result-v1" ||
    !["original", "selected"].includes(row.namespace as string)
  )
    fail("output schema/namespace");
  fields(record(row.census), [
    "functions",
    "instructions",
    "parameters",
    "blockArguments",
    "definitions",
    "globals",
    "invokes",
    "constructs",
  ]);
  for (const value of Object.values(record(row.census))) integer(value);
  for (const key of ["values", "calls", "functions", "globals", "heap", "edges", "projections", "obligations"])
    array(row[key]);
  return proposed as Result;
}

function rowEquations(
  expected: readonly unknown[],
  proposed: readonly unknown[],
  key: (row: Data) => string,
  group: string,
  reason: Problem["reason"],
): readonly Problem[] {
  const actual = new Map<string, Data>(),
    problems: Problem[] = [];
  for (const item of proposed) {
    const row = record(item),
      id = key(row);
    if (actual.has(id)) fail(`duplicate ${group} row`);
    actual.set(id, row);
  }
  if (actual.size !== expected.length)
    problems.push({ reason: "population", unitId: null, detail: `complete ${group} row denominator` });
  for (const item of expected) {
    const equation = record(item),
      id = key(equation),
      row = actual.get(id);
    if (!row) {
      problems.push({ reason: "population", unitId: null, detail: `missing ${group} equation ${id}` });
      continue;
    }
    fields(row, Object.keys(equation));
    for (const field of Object.keys(equation)) {
      if (!equationSame(equation[field], row[field]))
        problems.push({
          reason,
          unitId: null,
          detail: `${group} ${id}.${field} current transfer/fixed-point equation`,
        });
    }
    actual.delete(id);
  }
  if (actual.size) problems.push({ reason: "population", unitId: null, detail: `foreign ${group} rows` });
  return problems;
}
function equations(expected: Result, proposed: Result): readonly Problem[] {
  const problems: Problem[] = [];
  if (expected.namespace !== proposed.namespace)
    problems.push({ reason: "population", unitId: null, detail: "separate original/selected namespace mismatch" });
  for (const [field, count] of Object.entries(expected.census))
    if ((proposed.census as unknown as Data)[field] !== count)
      problems.push({ reason: "population", unitId: null, detail: `actual ${field} census` });
  const byUnit = (row: Data) => identifier(row.unitId);
  problems.push(
    ...rowEquations(
      expected.values,
      proposed.values,
      (row) => `${identifier(row.unitId)}#${integer(row.value)}`,
      "SSA value",
      "equation",
    ),
  );
  problems.push(
    ...rowEquations(expected.calls, proposed.calls, (row) => stable(record(row.location)), "call", "equation"),
  );
  problems.push(...rowEquations(expected.functions, proposed.functions, byUnit, "function summary", "equation"));
  problems.push(
    ...rowEquations(expected.globals, proposed.globals, (row) => identifier(row.bindingId), "global", "equation"),
  );
  problems.push(
    ...rowEquations(
      expected.heap,
      proposed.heap,
      (row) => `${stable(row.root)}:${stable(row.key)}`,
      "heap cell",
      "equation",
    ),
  );
  problems.push(
    ...rowEquations(expected.edges, proposed.edges, (row) => stable(row), "CFG/call/startup edge", "equation"),
  );
  problems.push(
    ...rowEquations(expected.obligations, proposed.obligations, (row) => stable(row), "obligation", "equation"),
  );
  problems.push(
    ...rowEquations(
      expected.projections,
      proposed.projections,
      (row) => identifier(row.externalName),
      "actual export projection",
      "projection",
    ),
  );
  return Object.freeze(problems.map((problem) => Object.freeze(problem)));
}

/** Fresh independent replay; the caller-proposed description never grants authority. */
export function replayNativeJsClassValueDomains(input: Input, proposed: unknown): readonly Problem[] {
  let phase: Problem["reason"] = "invalid-input";
  try {
    // Guard and compute authentic current input before inspecting proposed DATA.
    // No caller getter/callback is invoked and no stale report is cached.
    assertPreparedIrData(input);
    const complete = inputPopulation(input),
      expected = resultRows(leastFixedPoint(input, complete));
    phase = "invalid-output";
    assertPreparedIrData(proposed);
    return equations(expected, outputPopulation(proposed));
  } catch (error) {
    return Object.freeze([
      Object.freeze({
        reason: phase,
        unitId: null,
        detail: error instanceof Error ? error.message : "unreadable value-domain input/output",
      }),
    ]);
  }
}
