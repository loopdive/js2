// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  directUses,
  forEachNestedBuffer,
  type IrModule,
  type IrFunction,
  type IrInstr,
  type IrValueId,
  type AllocSiteId,
} from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import { irGlobalBindingKey } from "../../core/global-binding-keys.js";
import { irRuntimeFuncRef, irCallableBindingKey } from "../../core/callable-bindings.js";
import type { AllocRegistrySnapshot, EscapeClass } from "../contracts/allocations.js";
import { ALLOC_NAMESPACES } from "../contracts/allocations.js";
import { createVerifiedAllocationSnapshot } from "../allocations/snapshot.js";
import {
  nativeJsClassEffects,
  type NativeJsClassValueAliases,
  type NativeJsClassEvidenceDomain,
} from "./native-js-class-effects.js";
import { indexRegistryEvidence, checkRegistryEvidenceMetadataDomain } from "./metadata.js";
import type { AllocationEvidenceCheck } from "./contracts.js";
import {
  assertPreparedIrData,
  copyPreparedIrDataObject,
  freezePreparedIrValue,
  preparedIrDataMismatch,
} from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";

type Representable = {
  readonly kind: "representable";
  readonly aliases: readonly NativeJsClassValueAliases[];
} & Omit<Extract<AllocationEvidenceCheck, { kind: "verified" }>, "kind" | "profile">;
type Report = Exclude<AllocationEvidenceCheck, { kind: "verified" }> | Representable | undefined;
const ordinary = new Set([
  "const",
  "binary",
  "unary",
  "select",
  "tag.test",
  "dyn.to_number",
  "dyn.eq",
  "dyn.truthy",
  "unbox",
  "box",
  "vec.new_fixed",
  "vec.get",
  "vec.len",
  "vec.set",
  "refcell.new",
  "refcell.get",
  "refcell.set",
  "closure.new",
  "call",
  "slot.read",
  "slot.write",
  "if",
  "if.stmt",
  "early.return",
]);
const order: readonly EscapeClass[] = ["local", "returned", "stored", "captured", "opaque"];
const ops = ["read", "write", "mutate", "identity", "escape"] as const;
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class replay: ${detail}`);
}
function unsupported(detail: string): never {
  throw new IrUnsupportedError("class-member-unsupported", "build", `native JS class replay: ${detail}`);
}
const reference = (type: IrType | null) => type !== null && type.kind !== "val";
// This native replay permits only forgetting a dynamic tag refinement. It does
// not reinterpret payloads, add managed coercions or change the generic typer.
function resultFits(actual: IrType | undefined, expected: IrType | null | undefined): boolean {
  return (
    preparedIrDataMismatch(actual, expected) === undefined ||
    (actual?.kind === "dynamic" && expected?.kind === "dynamic" && expected.tag === undefined)
  );
}

/** Exact semantic declarations, not permission from a global name or opcode. */
function createExpectedOperationOperands() {
  const externType = { kind: "val", val: { kind: "externref" } };
  const expected = {
    referenceTarget: irRuntimeFuncRef("__new_ReferenceError"),
    externType,
    referenceParams: [externType],
    referenceResults: [externType],
    referenceSignature: {
      params: [`externref:${JSON.stringify(externType)}`],
      results: [`externref:${JSON.stringify(externType)}`],
    },
  };
  return freezePreparedIrValue(expected) as typeof expected;
}
type ExpectedOperationOperands = ReturnType<typeof createExpectedOperationOperands>;
function checkGlobalAndErrorOperation(
  instruction: IrInstr,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  domain: NativeJsClassEvidenceDomain,
  expected: ExpectedOperationOperands,
): boolean {
  if (instruction.kind === "global.get" || instruction.kind === "global.set") {
    const ref = instruction.target;
    if (ref.binding.kind !== "source") unsupported("non-source global transport");
    const entries = domain.programData?.abiEntries as
      | readonly {
          plan: {
            id: string;
            slotPolicy: string;
            slotSpace?: string;
            structuralReferenceKey?: string;
            intent: { kind: string; valueType?: string; mutable?: boolean };
          };
          contract: { kind: string; ref?: unknown; type?: IrType; mutable?: boolean };
        }[]
      | undefined;
    const matches = entries?.filter((entry) => entry.plan.structuralReferenceKey === irGlobalBindingKey(ref.binding));
    if (matches?.length !== 1) invalid("global operation lacks its complete actual ABI declaration");
    const entry = matches[0]!,
      type = entry.contract.type;
    if (!type || type.kind !== "val" || !["i32", "f64"].includes(type.val.kind))
      unsupported("non-scalar global transport");
    if (
      entry.contract.kind !== "global" ||
      entry.plan.id !== ref.binding.bindingId ||
      entry.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "global" ||
      entry.plan.intent.kind !== "global" ||
      entry.plan.intent.valueType !==
        `${type.val.kind}:${JSON.stringify({ kind: "val", val: Object.fromEntries(Object.entries(type.val).sort(([a], [b]) => a.localeCompare(b))) })}` ||
      entry.plan.intent.mutable !== entry.contract.mutable ||
      preparedIrDataMismatch(entry.contract.ref, ref) !== undefined
    )
      invalid("global operation has contradictory actual ABI");
    if (instruction.kind === "global.get") {
      if (preparedIrDataMismatch(instruction.resultType, type) !== undefined) invalid("global read type");
    } else if (!entry.contract.mutable || preparedIrDataMismatch(types.get(instruction.value), type) !== undefined)
      invalid("global write mutability/type");
    return true;
  }
  if (instruction.kind === "call" && instruction.target.binding.kind !== "unit") {
    const canonical = expected.referenceTarget;
    if (preparedIrDataMismatch(instruction.target, canonical) !== undefined) unsupported("foreign runtime call");
    const extern = expected.externType;
    const entries = domain.programData?.abiEntries as
      | readonly {
          plan: {
            structuralReferenceKey?: string;
            slotPolicy: string;
            slotSpace?: string;
            intent: { kind: string; origin?: string; signature?: unknown };
          };
          contract: { kind: string; ref?: unknown; params?: unknown; results?: unknown };
        }[]
      | undefined;
    const matches = entries?.filter(
      (entry) => entry.plan.structuralReferenceKey === irCallableBindingKey(canonical.binding),
    );
    if (matches?.length !== 1) invalid("ReferenceError call lacks its complete actual ABI");
    const entry = matches[0]!;
    if (
      entry.contract.kind !== "callable" ||
      entry.plan.intent.kind !== "callable" ||
      entry.plan.intent.origin !== "runtime" ||
      entry.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "function" ||
      preparedIrDataMismatch(entry.contract.ref, canonical) !== undefined ||
      preparedIrDataMismatch(entry.contract.params, expected.referenceParams) !== undefined ||
      preparedIrDataMismatch(entry.contract.results, expected.referenceResults) !== undefined ||
      preparedIrDataMismatch(entry.plan.intent.signature, expected.referenceSignature) !== undefined
    )
      invalid("ReferenceError callable ABI");
    const payload = definitions.get(instruction.args[0]!);
    if (
      instruction.args.length !== 1 ||
      payload?.kind !== "const" ||
      payload.value.kind !== "null" ||
      preparedIrDataMismatch(payload.resultType, extern) !== undefined ||
      preparedIrDataMismatch(instruction.resultType, extern) !== undefined
    )
      unsupported("ReferenceError requires its actual null message and extern result");
    return true;
  }
  if (instruction.kind === "coerce.to_externref") {
    if (
      types.get(instruction.value)?.kind !== "dynamic" ||
      preparedIrDataMismatch(instruction.resultType, expected.externType) !== undefined
    )
      unsupported("exception conversion requires an actual tagged JSValue and externref result");
    return true;
  }
  if (instruction.kind === "throw") {
    const producer = definitions.get(instruction.value);
    if (producer?.kind === "coerce.to_externref") {
      checkGlobalAndErrorOperation(producer, types, definitions, domain, expected);
      return true;
    }
    if (producer?.kind !== "call" || preparedIrDataMismatch(producer.target, expected.referenceTarget) !== undefined)
      unsupported("noncanonical error throw transport");
    checkGlobalAndErrorOperation(producer, types, definitions, domain, expected);
    return true;
  }
  return false;
}
/** Independently validate the complete lexical body and construct its alias constraints. */
function nativeJsClassLexicalGraph(
  fn: IrFunction,
  universe: readonly AllocSiteId[],
  domain: NativeJsClassEvidenceDomain,
  classBodyUnits: ReadonlySet<string>,
  expected: ExpectedOperationOperands,
) {
  if (fn.blocks.length !== 1 || fn.asyncPlan) unsupported("nonclosed control or async body");
  if (!Number.isSafeInteger(fn.valueCount) || fn.valueCount < 0) invalid("invalid value denominator");
  const valueRoots = new Map<IrValueId, Set<AllocSiteId>>(),
    edges = new Map<IrValueId, Set<IrValueId>>();
  const external = new Set<IrValueId>();
  const defined = new Set<IrValueId>(),
    parameterTypes = new Map<IrValueId, IrType>();
  const add = (id: IrValueId, type: IrType) => {
    if (!Number.isSafeInteger(id) || id < 0 || id >= fn.valueCount || defined.has(id))
      invalid("duplicate/invalid SSA definition");
    defined.add(id);
    parameterTypes.set(id, type);
  };
  for (const parameter of fn.params) {
    add(parameter.value, parameter.type);
    if (reference(parameter.type)) {
      valueRoots.set(parameter.value, new Set(universe));
      external.add(parameter.value);
    }
  }
  if (fn.blocks[0]!.blockArgs.length !== 0 || fn.blocks[0]!.blockArgTypes.length !== 0)
    unsupported("entry block arguments");
  const localInstructions: IrInstr[] = [];
  const actualDefinitions = new Map<IrValueId, IrInstr>();
  const localCensus = (buffer: readonly IrInstr[]) => {
    for (const item of buffer) {
      localInstructions.push(item);
      if (item.result !== null) actualDefinitions.set(item.result, item);
      forEachNestedBuffer(item, localCensus);
    }
  };
  localCensus(fn.blocks[0]!.instrs);
  const lexical = (buffer: readonly IrInstr[], available: Map<IrValueId, IrType>): Map<IrValueId, IrType> => {
    for (const instruction of buffer) {
      const effect = nativeJsClassEffects(instruction);
      const uses = effect
        ? [...effect.reads, ...effect.writes, ...effect.identities]
        : instruction.kind === "if"
          ? [instruction.cond]
          : directUses(instruction);
      for (const use of uses) if (!available.has(use)) invalid("lexical SSA operand");
      checkGlobalAndErrorOperation(instruction, available, actualDefinitions, domain, expected);
      if (
        instruction.kind === "js.class.property.get" &&
        (instruction.resultType?.kind !== "dynamic" || instruction.resultType.tag !== undefined)
      )
        unsupported("mutable property read requires an unrefined JSValue");
      if (
        (instruction.kind === "js.class.property.set" || instruction.kind === "js.class.property.define") &&
        available.get(instruction.value)?.kind !== "dynamic"
      )
        unsupported("stored property requires an existing immutable JSValue");
      if (instruction.kind === "if" || instruction.kind === "if.stmt") {
        const a = lexical(instruction.then, new Map(available)),
          b = lexical(instruction.else, new Map(available));
        if (instruction.kind === "if") {
          if (
            !a.has(instruction.thenValue) ||
            !b.has(instruction.elseValue) ||
            !resultFits(a.get(instruction.thenValue), instruction.resultType) ||
            !resultFits(b.get(instruction.elseValue), instruction.resultType)
          )
            invalid("conditional value join");
          if (instruction.result !== null)
            edges.set(instruction.result, new Set([instruction.thenValue, instruction.elseValue]));
        }
      }
      if (instruction.result !== null) {
        if (instruction.resultType === null) invalid("result without type");
        add(instruction.result, instruction.resultType);
        available.set(instruction.result, instruction.resultType);
        if (instruction.alloc !== undefined) valueRoots.set(instruction.result, new Set([instruction.alloc]));
        if (
          reference(instruction.resultType) &&
          (instruction.alloc === undefined || (instruction.kind as string) === "js.class.construct") &&
          instruction.kind !== "if" &&
          instruction.kind !== "slot.read"
        ) {
          valueRoots.set(instruction.result, new Set(universe));
          external.add(instruction.result);
        }
      } else if (instruction.resultType !== null) invalid("type without result");
      if (instruction.kind === "coerce.to_externref" && instruction.result !== null)
        edges.set(instruction.result, new Set([instruction.value]));
      if (instruction.kind === "slot.read" && instruction.result !== null && reference(instruction.resultType)) {
        const predecessors = new Set<IrValueId>();
        for (const candidate of localInstructions)
          if (candidate.kind === "slot.write" && candidate.slotIndex === instruction.slotIndex)
            predecessors.add(candidate.value);
        edges.set(instruction.result, predecessors);
      }
      if (instruction.kind === "call") {
        const target = instruction.target.binding;
        if (!target) unsupported("foreign callable");
        if (target.kind === "unit") {
          if (!domain.unitIds.includes(target.unitId)) unsupported("foreign callable");
          if (classBodyUnits.has(target.unitId)) unsupported("class-owned callable requires its explicit protocol");
        } else checkGlobalAndErrorOperation(instruction, available, actualDefinitions, domain, expected);
      }
      if (
        instruction.kind === "const" &&
        instruction.resultType?.kind === "val" &&
        !["i32", "f64"].includes(instruction.resultType.val.kind) &&
        !(instruction.value.kind === "null" && instruction.resultType.val.kind === "externref")
      )
        unsupported("nonprimitive numeric constant");
    }
    return available;
  };
  const final = lexical(fn.blocks[0]!.instrs, new Map(parameterTypes));
  const terminal = fn.blocks[0]!.terminator;
  if (terminal.kind !== "return") unsupported("nonreturn terminal");
  if (terminal.values.length !== fn.resultTypes.length) invalid("return arity");
  for (const [i, id] of terminal.values.entries())
    if (!final.has(id) || !resultFits(final.get(id), fn.resultTypes[i])) invalid("return type/lexical value");
  return { valueRoots, edges, external, terminal };
}

/** The replay uses value-dependency constraints, not producer annotations or its root-map implementation. */
export function inspectNativeJsClassNamespaces(
  module: IrModule,
  registry: AllocRegistrySnapshot,
  domain: NativeJsClassEvidenceDomain | undefined,
): Report {
  try {
    assertPreparedIrData(module);
    assertPreparedIrData(registry);
    if (domain !== undefined) assertPreparedIrData(domain);
    let selected = domain !== undefined && domain.definitions.length > 0;
    const census = {
      functions: module.functions.length,
      buffers: 0,
      instructions: 0,
      allocations: 0,
      vectorReads: 0,
      vectorWrites: 0,
      registrySlots: registry.size,
    };
    const all: IrInstr[] = [];
    const enumerate = (buffer: readonly IrInstr[]) => {
      census.buffers++;
      for (const instruction of buffer) {
        census.instructions++;
        all.push(instruction);
        if ((instruction.kind as string).startsWith("js.class.")) selected = true;
        if (instruction.kind === "vec.get" || instruction.kind === "vec.len") census.vectorReads++;
        if (instruction.kind === "vec.set") census.vectorWrites++;
        forEachNestedBuffer(instruction, enumerate);
      }
    };
    for (const fn of module.functions) for (const block of fn.blocks) enumerate(block.instrs);
    if (!selected) return undefined;
    if (!domain) invalid("selected population has no definition domain");
    assertPreparedIrData(domain);
    const expected = createExpectedOperationOperands();
    if (
      preparedIrDataMismatch(
        domain.unitIds,
        module.functions.map((fn) => fn.unitId),
      ) !== undefined
    )
      invalid("unit census changed");
    const definitions = new Set(domain.definitions.map((item) => item.id));
    const classBodyUnits = new Set(
      domain.definitions.flatMap(({ definition }) => [
        definition.constructor.unitId,
        ...definition.members.map((member) => member.body.unitId),
        ...definition.instanceElements.flatMap((element) => (element.initializer ? [element.initializer.unitId] : [])),
      ]),
    );
    if (!definitions.size || definitions.size !== domain.definitions.length) invalid("definition census changed");
    const index = indexRegistryEvidence(registry);
    const namespaceDomain = checkRegistryEvidenceMetadataDomain(index);
    if (namespaceDomain) return namespaceDomain;
    for (const row of registry.metadata)
      for (const [namespace] of row.entries)
        if (
          namespace !== ALLOC_NAMESPACES.ownership &&
          namespace !== ALLOC_NAMESPACES.escape &&
          namespace !== ALLOC_NAMESPACES.encoding
        )
          return {
            kind: "invalid",
            code: "namespace-presence",
            at: { kind: "site", site: row.id },
          };
    const occurrences = new Map<string, number>();
    for (const instruction of all)
      if (instruction.kind === "js.class.define")
        occurrences.set(instruction.definition, (occurrences.get(instruction.definition) ?? 0) + 1);
    for (const id of definitions) if (occurrences.get(id) !== 1) invalid("definition occurrence census");
    const lookup = createVerifiedAllocationSnapshot(registry);
    const sites = new Map<
      AllocSiteId,
      {
        instructions: IrInstr[];
        operations: Set<string>;
        escape: EscapeClass;
        shared: boolean;
      }
    >();
    for (const instruction of all) {
      const effect = nativeJsClassEffects(instruction);
      if (effect?.definition && !definitions.has(effect.definition)) invalid("foreign definition");
      if (
        !effect &&
        !ordinary.has(instruction.kind) &&
        !["global.get", "global.set", "throw", "coerce.to_externref"].includes(instruction.kind)
      )
        unsupported(`instruction ${instruction.kind}`);
      if (instruction.alloc === undefined) continue;
      const allocation = lookup.resolve(instruction.alloc);
      if (!allocation || allocation.id !== instruction.alloc || sites.has(allocation.id))
        invalid("allocation occurrence/provenance");
      if (
        instruction.result === null ||
        instruction.resultType === null ||
        preparedIrDataMismatch(allocation.type, instruction.resultType) !== undefined ||
        preparedIrDataMismatch(allocation.origin, instruction.site) !== undefined
      )
        invalid("allocation type/origin");
      const expected =
        effect?.allocationKind ??
        (instruction.kind === "box"
          ? "box"
          : instruction.kind === "vec.new_fixed"
            ? "array"
            : instruction.kind === "refcell.new"
              ? "refcell"
              : instruction.kind === "closure.new"
                ? "closure"
                : undefined);
      if (expected === undefined || allocation.kind !== expected) invalid("allocation kind");
      sites.set(allocation.id, {
        instructions: [instruction],
        operations: new Set(),
        escape: "local",
        shared: false,
      });
    }
    const universe = [...sites.keys()];
    const aliases: NativeJsClassValueAliases[] = [];
    const unitIds = new Set<string>();
    for (const fn of module.functions) {
      if (unitIds.has(fn.unitId)) invalid("duplicate function");
      unitIds.add(fn.unitId);
      const { valueRoots, edges, external, terminal } = nativeJsClassLexicalGraph(
        fn,
        universe,
        domain,
        classBodyUnits,
        expected,
      );
      // Solve the independent dependency graph. No producer root-map or report participates.
      for (let changed = true; changed; ) {
        changed = false;
        for (const [target, incoming] of edges) {
          const roots = valueRoots.get(target) ?? new Set<AllocSiteId>();
          valueRoots.set(target, roots);
          for (const source of incoming)
            if (external.has(source) && !external.has(target)) {
              external.add(target);
              changed = true;
            }
          for (const source of incoming)
            for (const site of valueRoots.get(source) ?? [])
              if (!roots.has(site)) {
                roots.add(site);
                changed = true;
              }
        }
      }
      for (const [value, roots] of valueRoots)
        aliases.push(
          Object.freeze({
            unitId: fn.unitId,
            value,
            possibleSites: Object.freeze([...roots].sort((a, b) => a - b)),
            mayReferenceExternalRoot: external.has(value),
          }),
        );
      const apply = (values: readonly IrValueId[], operation: string, classification?: EscapeClass) => {
        const roots = new Set(values.flatMap((value) => [...(valueRoots.get(value) ?? [])]));
        for (const id of roots) {
          const site = sites.get(id)!;
          site.operations.add(operation);
          site.shared ||= roots.size > 1;
          if (classification && order.indexOf(classification) > order.indexOf(site.escape))
            site.escape = classification;
        }
      };
      const replay = (buffer: readonly IrInstr[]) => {
        for (const instruction of buffer) {
          const effect = nativeJsClassEffects(instruction);
          if (effect) {
            apply(effect.reads, "read");
            apply(effect.writes, "write");
            apply(effect.identities, "identity");
            apply(effect.captured, "escape", "captured");
            apply(effect.stored, "escape", "stored");
            apply(effect.opaque, "escape", "opaque");
            if ((instruction.kind as string) === "js.class.construct" && instruction.result !== null)
              apply([instruction.result], "escape", "opaque");
          } else {
            apply(directUses(instruction), "read");
            if (instruction.kind === "call" || instruction.kind === "closure.new")
              apply(directUses(instruction), "escape", instruction.kind === "call" ? "opaque" : "captured");
            if (instruction.kind === "vec.set" || instruction.kind === "refcell.set") {
              apply(directUses(instruction), "write");
              apply([instruction.kind === "vec.set" ? instruction.newValue : instruction.value], "escape", "stored");
            }
            if (instruction.kind === "early.return" && instruction.value !== null)
              apply([instruction.value], "escape", "returned");
            if (instruction.kind === "throw") apply([instruction.value], "escape", "opaque");
          }
          forEachNestedBuffer(instruction, replay);
        }
      };
      replay(fn.blocks[0]!.instrs);
      apply(terminal.values, "escape", "returned");
    }
    for (const entry of registry.entries)
      if (entry.state === "live" && !sites.has(entry.site.id))
        return {
          kind: "invalid",
          code: "unused-site-evidence",
          at: { kind: "site", site: entry.site.id },
        };
    for (const row of registry.metadata) {
      if (!sites.has(row.id) && row.entries.length)
        return {
          kind: "invalid",
          code: "unused-site-evidence",
          at: { kind: "site", site: row.id },
        };
    }
    for (const [id, expected] of sites) {
      const row = index.rows.get(id),
        at = { kind: "site" as const, site: id };
      if (row?.has(ALLOC_NAMESPACES.encoding)) return { kind: "invalid", code: "namespace-presence", at };
      const facts = [
        [
          ALLOC_NAMESPACES.ownership,
          copyPreparedIrDataObject({
            state: expected.escape !== "local" ? "escaped" : expected.shared ? "shared" : "owned",
            ops: ops.filter((op) => expected.operations.has(op)),
          }),
        ],
        [
          ALLOC_NAMESPACES.escape,
          copyPreparedIrDataObject({
            classification: expected.escape,
            stackAllocatable: expected.escape === "local",
          }),
        ],
      ] as const;
      for (const [namespace, value] of facts) {
        if (!row?.has(namespace)) return { kind: "invalid", code: "namespace-presence", at };
        if (preparedIrDataMismatch(row.get(namespace), value) !== undefined)
          return { kind: "invalid", code: "namespace-value", at };
      }
    }
    census.allocations = sites.size;
    return {
      kind: "representable",
      namespaces: index.mode,
      census,
      aliases: Object.freeze(aliases),
    };
  } catch (error) {
    if (error instanceof IrUnsupportedError)
      return {
        kind: "not-covered",
        reason: "reference-carrier",
        at: { kind: "module" },
      };
    if (error instanceof PreparedIrProgramInvariantError || error instanceof TypeError || error instanceof Error)
      return {
        kind: "invalid",
        code: "lexical-definition",
        at: { kind: "module" },
      };
    throw error;
  }
}
