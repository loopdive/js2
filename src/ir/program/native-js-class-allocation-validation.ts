// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrModule, type IrInstr, type AllocSiteId, type IrValueId } from "../core/nodes.js";
import { irSupportRef } from "../core/types.js";
import { irTypeBindingKey } from "../core/type-binding-keys.js";
import { preparedIrTypeKey } from "./abi-signatures.js";
import type { NativeJsClassEvidenceDomain } from "../analysis/allocation-evidence/native-js-class-effects.js";
import {
  nativeJsClassEffects,
  type NativeJsClassValueAliases,
} from "../analysis/allocation-evidence/native-js-class-effects.js";
import { inspectNativeJsClassNamespaces } from "../analysis/allocation-evidence/native-js-class-profile.js";
import { ALLOC_NAMESPACES } from "../analysis/contracts/allocations.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { AllocationEvidenceCheck } from "../analysis/allocation-evidence/contracts.js";
import { verifyNativeJsClassEvidence } from "../runtime/native-js-class-profile.js";
import {
  assertPreparedIrData,
  preparedIrDataMismatch,
  freezePreparedIrValue,
} from "../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-invariant-error.js";
import {
  collectNativeJsClassErrorDemands,
  type NativeJsClassErrorDemand,
} from "../runtime/native-js-class-error-callables.js";
import type { PreparedIrProgram } from "./prepared-contracts.js";
import { preparedIrJsClassDefinitions, assertPreparedIrJsClassDefinitions } from "./js-class-definition.js";
import { irRuntimeSupportFunctions } from "./runtime-support.js";

export type NativeJsClassAllocationContext = Pick<PreparedIrProgram, "ir" | "allocations" | "runtimeSupport"> &
  Partial<Pick<PreparedIrProgram, "abi" | "inventory" | "startup" | "runtime" | "derivedUnits">>;
export type NativeJsClassDomainContext = Pick<PreparedIrProgram, "abi" | "inventory" | "startup">;

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class allocation domain: ${detail}`);
}
function own(value: object, key: string, required = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (required) invalid(`missing ${key}`);
    return undefined;
  }
  if (!("value" in descriptor)) invalid(`accessor ${key}`);
  return descriptor.value;
}
function hasClass(module: IrModule): boolean {
  assertPreparedIrData(module);
  let found = false;
  for (const fn of module.functions)
    for (const block of fn.blocks)
      for (const instruction of block.instrs)
        forEachInstrDeep(instruction, (item) => {
          found ||= item.kind.startsWith("js.class.");
        });
  return found;
}

/** Rebuild from the actual full ABI and original inventory; never accept caller-authored reports. */
export function nativeJsClassEvidenceDomainFromProgram(
  context: Partial<NativeJsClassDomainContext> & Partial<Pick<PreparedIrProgram, "runtime">>,
  module: IrModule,
  phase: "source" | "sealed" = "sealed",
): NativeJsClassEvidenceDomain | undefined {
  const selected = hasClass(module);
  const abi = own(context, "abi") as PreparedIrProgram["abi"] | undefined;
  if (abi === undefined) {
    if (selected) invalid("selected bodies lack a full ABI");
    return undefined;
  }
  assertPreparedIrData(abi);
  const definitions = preparedIrJsClassDefinitions(abi.entries);
  if (!definitions.length) {
    if (selected) invalid("selected bodies lack canonical definitions");
    return undefined;
  }
  const inventory = own(context, "inventory", true) as PreparedIrProgram["inventory"];
  assertPreparedIrData(inventory);
  assertPreparedIrJsClassDefinitions(
    inventory,
    definitions.map((row) => row.definition),
    module,
  );
  const ids = new Set(abi.entries.map((entry) => entry.plan.id));
  if (ids.size !== abi.entries.length) invalid("duplicate ABI binding");
  for (const { definition } of definitions) {
    for (const role of Object.values(definition.roles)) {
      const entry = abi.entries.find((candidate) => candidate.plan.id === role.binding.bindingId);
      if (
        !entry ||
        entry.contract.kind !== "type" ||
        entry.plan.slotPolicy !== "none" ||
        Object.hasOwn(entry.plan, "slotSpace") ||
        Object.hasOwn(entry.plan, "aliasOf") ||
        entry.plan.structuralReferenceKey !== irTypeBindingKey(role.binding) ||
        entry.plan.intent.kind !== "type" ||
        entry.plan.intent.shapeKey !== preparedIrTypeKey(irSupportRef(role, false)) ||
        preparedIrDataMismatch(entry.contract.ref, role) !== undefined ||
        preparedIrDataMismatch(entry.contract.type, irSupportRef(role, false)) !== undefined
      )
        invalid("managed class role lacks its genuine logical type ABI");
    }
    const bindings = [definition.outerBinding, definition.innerBinding].filter((binding) => binding !== null);
    for (const binding of bindings) {
      if (binding.storage !== "module") continue;
      for (const [ref, type] of [
        [binding.valueGlobal, binding.valueType],
        [binding.tdzGlobal, { kind: "val", val: { kind: "i32" } }],
      ] as const) {
        if (!ref) invalid("module binding lacks actual globals");
        const entry = abi.entries.find((candidate) => candidate.plan.id === ref.binding.bindingId);
        if (
          !entry ||
          entry.contract.kind !== "global" ||
          !entry.contract.mutable ||
          entry.plan.slotPolicy !== "required" ||
          entry.plan.slotSpace !== "global" ||
          preparedIrDataMismatch(entry.contract.ref, ref) !== undefined ||
          preparedIrDataMismatch(entry.contract.type, type) !== undefined
        )
          invalid("module binding global/TDZ ABI");
      }
    }
  }
  if (phase === "sealed") {
    const startup = own(context, "startup", true) as PreparedIrProgram["startup"];
    assertPreparedIrData(startup);
    const observed = new Set<string>();
    for (const plan of startup) {
      const projection = own(plan, "jsClassStartup");
      if (projection === undefined) continue;
      assertPreparedIrData(projection);
      const row = projection as {
        schema?: unknown;
        definitions?: readonly {
          definitionId: string;
          sourceClassId: string;
          statementOrdinal: number;
          span: { start: number; end: number };
        }[];
      };
      if (row.schema !== "native-js-class-startup-v1" || !Array.isArray(row.definitions))
        invalid("startup projection shape");
      let ordinal = -1,
        lastStart = -1;
      for (const item of row.definitions) {
        const original = definitions.find((candidate) => candidate.bindingId === item.definitionId);
        if (
          !original ||
          observed.has(item.definitionId) ||
          original.definition.sourceClassId !== item.sourceClassId ||
          original.definition.sourceId !== plan.sourceId ||
          original.definition.evaluationOwnerUnitId !== plan.unitId ||
          preparedIrDataMismatch(original.definition.span, item.span) !== undefined ||
          !Number.isSafeInteger(item.statementOrdinal) ||
          item.statementOrdinal < ordinal ||
          (item.statementOrdinal === ordinal && item.span.start <= lastStart)
        )
          invalid("startup definition owner/order/span");
        ordinal = item.statementOrdinal;
        lastStart = item.span.start;
        observed.add(item.definitionId);
      }
    }
    for (const { bindingId, definition } of definitions)
      if (startup.some((plan) => plan.unitId === definition.evaluationOwnerUnitId) && !observed.has(bindingId))
        invalid("original module definition missing from startup");
  }
  const runtime = own(context, "runtime") as PreparedIrProgram["runtime"] | undefined;
  if (runtime !== undefined) {
    assertPreparedIrData(runtime);
    if (!Array.isArray(runtime)) invalid("runtime manifest projection array");
  }
  return Object.freeze({
    definitions: Object.freeze(
      definitions.map(({ bindingId, definition }) => Object.freeze({ id: bindingId, definition })),
    ),
    unitIds: Object.freeze(module.functions.map((fn) => fn.unitId)),
    programData: freezePreparedIrValue({
      inventory,
      abiEntries: abi.entries,
      startup: own(context, "startup") ?? null,
      phase,
      ...(runtime === undefined
        ? {}
        : {
            runtimeManifests: runtime.map((view) => ({
              backend: view.backend,
              target: view.target,
              manifest: view.prepared.manifest,
            })),
          }),
    }) as NonNullable<NativeJsClassEvidenceDomain["programData"]>,
  });
}

export function nativeJsClassProgramEvidence(
  program: NativeJsClassAllocationContext,
  module: IrModule,
): AllocationEvidenceCheck | undefined {
  const domain = nativeJsClassEvidenceDomainFromProgram(program, module);
  return verifyNativeJsClassEvidence(module, program.allocations, domain);
}

/** Every original, selected and support view is checked before any coverage decision. */
export function assertNativeJsClassAllocations(program: NativeJsClassAllocationContext): boolean {
  const ir = own(program, "ir", true) as IrModule;
  const allocations = own(program, "allocations", true) as PreparedIrProgram["allocations"];
  assertPreparedIrData(allocations);
  const supportInput = own(program, "runtimeSupport") as PreparedIrProgram["runtimeSupport"];
  if (supportInput !== undefined) assertPreparedIrData(supportInput);
  const support = irRuntimeSupportFunctions(supportInput);
  const runtime = own(program, "runtime") as PreparedIrProgram["runtime"] | undefined;
  assertPreparedIrData(ir);
  const modules: IrModule[] = [ir];
  if (runtime !== undefined) {
    if (!Array.isArray(runtime)) invalid("runtime projection array");
    for (const view of runtime) {
      const prepared = own(view, "prepared", true) as { functions: IrModule["functions"] };
      const functions = own(prepared, "functions", true) as IrModule["functions"];
      assertPreparedIrData(functions);
      modules.push({ ...ir, functions });
    }
  }
  const views = modules.map((view) => ({ ...ir, functions: [...view.functions, ...support] }));
  const reports = views.map((view) => nativeJsClassProgramEvidence(program, view));
  if (reports.every((report) => report === undefined)) return false;
  for (const report of reports) if (report?.kind === "invalid") invalid(`semantic replay ${report.code}`);
  for (const report of reports)
    if (report?.kind !== "verified" || report.namespaces !== "ownership-and-escape")
      invalid("every original/selected body requires complete canonical class evidence");
  return true;
}

export interface NativeJsClassAllocationTopology {
  readonly implicitErrorAllocations: readonly NativeJsClassErrorDemand[];
  readonly roots: readonly {
    readonly unitId: IrUnitId;
    readonly site: AllocSiteId;
    readonly value: IrValueId;
    /** Exact current occurrence, not a reconstructed instruction or invented source location. */
    readonly instruction: IrInstr;
    readonly role: "definition" | "instance" | "binding-cell" | "activation-frame" | "primitive-box" | "ordinary";
    /** These share the one actual recipe lifetime; they are not child AllocSites. */
    readonly aggregateChildren: readonly string[];
    readonly referencedValues: readonly IrValueId[];
    readonly ownership: unknown;
    readonly escape: unknown;
  }[];
  readonly aliases: readonly NativeJsClassValueAliases[];
  /** Union of actual original/all-selected literal-key occurrences, never caller supplied. */
  readonly literalPropertyKeys: readonly string[];
  readonly propertyOccurrences: readonly {
    readonly unitId: IrUnitId;
    readonly instruction: IrInstr;
    readonly key: string | null;
  }[];
  /** Materializers must preserve old primitive reads across later property writes. */
  readonly primitivePropertyStorage: "immutable-existing-carrier";
  readonly constructorReplacement: "existing-replacement-root-or-fresh-self";
}

/** Descriptive DATA only. Physical authority must independently replay this current program on every use. */
export function nativeJsClassAllocationTopology(
  program: NativeJsClassAllocationContext,
  module: IrModule,
): NativeJsClassAllocationTopology | undefined {
  if (!assertNativeJsClassAllocations(program)) return undefined;
  assertPreparedIrData(module);
  const support = irRuntimeSupportFunctions(program.runtimeSupport);
  const views = [
    program.ir,
    ...(program.runtime ?? []).map((view) => ({ ...program.ir, functions: view.prepared.functions })),
  ].map((view) => ({ ...program.ir, functions: [...view.functions, ...support] }));
  if (
    !views.some(
      (view) =>
        preparedIrDataMismatch(view, module) === undefined &&
        view.functions.every((fn, index) => fn === module.functions[index]),
    )
  )
    invalid("topology module is not an exact current complete view");
  const domain = nativeJsClassEvidenceDomainFromProgram(program, module);
  if (!domain || verifyNativeJsClassEvidence(module, program.allocations, domain)?.kind !== "verified")
    invalid("topology canonical replay");
  const inspected = inspectNativeJsClassNamespaces(module, program.allocations, domain);
  if (inspected?.kind !== "representable") invalid("topology independent alias replay");
  const metadata = new Map(program.allocations.metadata.map((row) => [row.id, new Map(row.entries)]));
  const literalKeys = new Set<string>(),
    properties: NativeJsClassAllocationTopology["propertyOccurrences"][number][] = [],
    seenProperty = new Set<IrInstr>();
  for (const view of views)
    for (const fn of view.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (
              instruction.kind !== "js.class.property.get" &&
              instruction.kind !== "js.class.property.set" &&
              instruction.kind !== "js.class.property.define"
            )
              return;
            if (seenProperty.has(instruction)) return;
            seenProperty.add(instruction);
            const key = instruction.key.kind === "string" ? instruction.key.value : null;
            if (key !== null) literalKeys.add(key);
            properties.push(Object.freeze({ unitId: fn.unitId, instruction, key }));
          });
  const roots: NativeJsClassAllocationTopology["roots"][number][] = [];
  for (const fn of module.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.alloc === undefined || instruction.result === null) return;
          const role =
            instruction.kind === "js.class.define"
              ? "definition"
              : instruction.kind === "js.class.construct"
                ? "instance"
                : instruction.kind === "js.class.binding.new"
                  ? "binding-cell"
                  : instruction.kind === "js.class.frame.new"
                    ? "activation-frame"
                    : instruction.kind === "box"
                      ? "primitive-box"
                      : "ordinary";
          const children: string[] = [];
          if (instruction.kind === "js.class.define") {
            const descriptor = domain.definitions.find((row) => row.id === instruction.definition)!.definition;
            children.push(
              "constructor",
              "prototype",
              "environment",
              ...descriptor.members.map((member) => `method:${member.sourceOrdinal}`),
            );
            if (descriptor.innerBinding?.storage === "cell") children.push("inner-name-cell");
            if (literalKeys.has("prototype")) children.push("prototype-object-carrier");
            if (literalKeys.has("constructor")) children.push("constructor-function-carrier");
            for (const member of descriptor.members)
              if (literalKeys.has(member.name)) children.push(`method-function-carrier:${member.sourceOrdinal}`);
          }
          const evidence = metadata.get(instruction.alloc)!;
          roots.push(
            Object.freeze({
              unitId: fn.unitId,
              site: instruction.alloc,
              value: instruction.result,
              instruction,
              role,
              aggregateChildren: Object.freeze(children),
              referencedValues: Object.freeze([...(nativeJsClassEffects(instruction)?.reads ?? [])]),
              ownership: freezePreparedIrValue(evidence.get(ALLOC_NAMESPACES.ownership)),
              escape: freezePreparedIrValue(evidence.get(ALLOC_NAMESPACES.escape)),
            }),
          );
        });
  return Object.freeze({
    implicitErrorAllocations: collectNativeJsClassErrorDemands(module.functions),
    roots: Object.freeze(roots),
    aliases: inspected.aliases,
    literalPropertyKeys: Object.freeze([...literalKeys].sort()),
    propertyOccurrences: Object.freeze(properties),
    primitivePropertyStorage: "immutable-existing-carrier",
    constructorReplacement: "existing-replacement-root-or-fresh-self",
  });
}
