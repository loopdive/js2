import { normalizeNativeClassValues } from "./native-js-class-values.js";
import { analyzeNativeJsClassValueDomains } from "../analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../analysis/allocation-evidence/js-class-value-domains/independent.js";
import { indexNativeJsClassValueDomainInput } from "../analysis/allocation-evidence/js-class-value-domains/input.js";
import type {
  NativeJsValueDomain,
  NativeJsValueRoot,
} from "../analysis/allocation-evidence/js-class-value-domains/contracts.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import { assertPreparedIrProgram } from "./validation.js";
import { preparedIrProgramCallableResults } from "./callable-results.js";
import {
  collectNativeJsClassRequirements,
  assertNativeJsClassRequirementsCurrent,
  describeNativeJsClassPhysicalRequirements,
  type NativeJsClassRequirements,
} from "./native-js-class-requirements.js";
import { irRuntimeSupportFunctions } from "./runtime-support.js";
import { forEachInstrDeep, forEachNestedBuffer, type IrFunction, type IrInstr, type IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { IrGlobalRef } from "../core/value-references.js";
import { irUnitCallableBindingId, irCallableBindingKey, irRuntimeFuncRef } from "../core/callable-bindings.js";
import { irModuleGlobalBindingId, irModuleTdzGlobalBindingId } from "../core/binding-references.js";
import { irGlobalBindingKey } from "../core/global-binding-keys.js";
import { createNativeJsClassRepresentability } from "../analysis/allocation-evidence/native-js-class-legality.js";
import type { IrBindingId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import {
  assertPreparedIrData,
  copyPreparedIrDataObject,
  preparedIrDataMismatch,
  freezePreparedIrValue,
} from "../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-invariant-error.js";
import { collectNativeStringValueDemands } from "./native-string-value-demands.js";
import {
  deriveNativeStringOutputRequirements,
  type NativeStringOutputOptions,
} from "./native-string-output-requirements.js";
import { deriveNativeValueResourcePlan } from "./native-value-resources.js";
import {
  planNativeInvocationRequirements,
  assertNativeInvocationRequirementsCurrent,
  type NativeInvocationRequirements,
} from "./native-invocation-requirements.js";
import { assertNativeRealmRequirementsCurrent, type NativeRealmRequirements } from "./native-realm-requirements.js";
import { deriveNativeVectorResourcePlan, type NativeVectorResourcePlan } from "./native-vector-resources.js";

interface ClassOwner {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
}
const classes = new WeakMap<NativeJsClassRequirements, ClassOwner>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native class physical owner: " + detail);
}
/** Full canonical preparation is mandatory before logical acquisition, including absence. */
export function collectNativeProgramClassRequirements(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
) {
  assertPreparedIrData(copyPreparedIrDataObject({ program, projection }));
  assertPreparedIrProgram(program);
  const result = collectNativeJsClassRequirements(program, projection);
  if (result) classes.set(result, { program, projection });
  return result;
}
export function assertNativeProgramClassRequirementsCurrent(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): void {
  const owner = classes.get(requirements);
  if (!owner || owner.program !== program || owner.projection !== projection) invalid("unissued logical acquisition");
  assertPreparedIrData(copyPreparedIrDataObject({ program, projection }));
  assertPreparedIrProgram(program);
  assertNativeJsClassRequirementsCurrent(requirements, program, projection);
}
export function describeNativeProgramClassPhysicalRequirements(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
) {
  assertNativeProgramClassRequirementsCurrent(requirements, program, projection);
  return describeNativeJsClassPhysicalRequirements(requirements, program, projection);
}
export interface NativeProgramClassView {
  readonly units: readonly {
    readonly fn: IrFunction;
    readonly bindingId: IrBindingId;
    readonly referenceKey: string;
  }[];
  readonly globals: readonly { readonly ref: IrGlobalRef; readonly key: string }[];
  readonly types: readonly IrType[];
  readonly routedFunctions: readonly IrFunction[];
}
/** Reconstructed DATA from original source identities; no physical indices or emission verdict. */
export function nativeProgramClassView(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeProgramClassView {
  assertNativeProgramClassRequirementsCurrent(requirements, program, projection);
  const units: NativeProgramClassView["units"][number][] = [],
    types: IrType[] = [],
    routedFunctions: IrFunction[] = [];
  for (const fn of projection.prepared.functions) {
    const own = requirements.domain.unitIds.includes(fn.unitId);
    const functionTypes = [...fn.params.map((row) => row.type), ...fn.resultTypes];
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.resultType !== null) functionTypes.push(instruction.resultType);
        });
    types.push(...functionTypes);
    const operation =
      requirements.occurrences.some((row) => row.unitId === fn.unitId) ||
      requirements.boxes.some((row) => row.unitId === fn.unitId);
    const managed = functionTypes.some(
      (type) =>
        type.kind === "dynamic" ||
        (type.kind === "support-ref" &&
          requirements.domain.definitions.some(({ definition }) =>
            Object.values(definition.roles).some((ref) => preparedIrDataMismatch(ref, type.ref) === undefined),
          )),
    );
    // Module-init and ordinary exported/helper functions are selected by their actual census.
    if (operation || (own && managed)) {
      if (!own) invalid("class occurrence/type lacks a canonical original unit");
      routedFunctions.push(fn);
    }
    if (!own) continue;
    const bindingId = irUnitCallableBindingId(fn.unitId),
      entry = program.abi.entries.find((row) => row.plan.id === bindingId);
    if (
      !entry ||
      entry.contract.kind !== "callable" ||
      entry.contract.ref.binding.kind !== "unit" ||
      entry.contract.ref.binding.unitId !== fn.unitId ||
      entry.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "function" ||
      preparedIrDataMismatch(
        entry.contract.params,
        fn.params.map((parameter) => parameter.type),
      ) !== undefined ||
      preparedIrDataMismatch(entry.contract.results, preparedIrProgramCallableResults(fn)) !== undefined
    )
      invalid("class unit ABI does not match actual current body");
    units.push(Object.freeze({ fn, bindingId, referenceKey: irCallableBindingKey(entry.contract.ref.binding) }));
  }
  const globals = program.abi.entries.flatMap((entry) =>
    entry.contract.kind === "global"
      ? [Object.freeze({ ref: entry.contract.ref, key: irGlobalBindingKey(entry.contract.ref.binding) })]
      : [],
  );
  return Object.freeze({
    units: Object.freeze(units),
    globals: Object.freeze(globals),
    types: Object.freeze(types),
    routedFunctions: Object.freeze(routedFunctions),
  });
}
/** Neutral representability is separate from the physical owner's live resource conjunction. */
export function nativeProgramClassLegality(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  fn: IrFunction,
) {
  const checked = collectNativeProgramClassRequirements(program, projection);
  if (!projection.prepared.functions.includes(fn)) invalid("foreign legality function");
  if (!checked || !checked.domain.unitIds.includes(fn.unitId)) return undefined;
  if (projection.backend !== "wasmgc" && projection.backend !== "linear") invalid("foreign class backend");
  const module = {
    ...program.ir,
    functions: [...projection.prepared.functions, ...irRuntimeSupportFunctions(program.runtimeSupport)],
  };
  const use = createNativeJsClassRepresentability(
    Object.freeze({
      original: program.ir,
      selected: module,
      registry: program.allocations,
      domain: checked.domain,
      function: fn,
      backend: projection.backend,
    }),
  );
  assertNativeProgramClassRequirementsCurrent(checked, program, projection);
  return use;
}

interface StringSemanticOwner {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly options: { readonly utf8Storage?: boolean; readonly stringConcatEmptyIdentity?: boolean };
  readonly invocation?: NativeInvocationRequirements;
  readonly realm?: NativeRealmRequirements;
  readonly snapshot: unknown;
}
const strings = new WeakMap<object, StringSemanticOwner>();
/** Logical preparation retains the old derivation order; backend string planning remains backend-owned. */
export function collectNativeProgramStringSemantics(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  options: { readonly utf8Storage?: boolean; readonly stringConcatEmptyIdentity?: boolean },
  invocationRequirements?: NativeInvocationRequirements,
  realmRequirements?: NativeRealmRequirements,
) {
  assertPreparedIrData({ program, projection, options, invocationRequirements, realmRequirements });
  assertPreparedIrProgram(program);
  if (!program.runtime.includes(projection)) invalid("foreign string projection");
  if (realmRequirements) {
    assertNativeRealmRequirementsCurrent(realmRequirements);
    if (realmRequirements.program !== program || realmRequirements.projection !== projection)
      invalid("borrowed realm acquisition");
  }
  if (
    invocationRequirements &&
    (invocationRequirements.source.demands.program !== program ||
      invocationRequirements.source.demands.projection !== projection)
  )
    invalid("borrowed invocation acquisition");
  const demands = collectNativeStringValueDemands(program, projection);
  if (invocationRequirements !== undefined) assertNativeInvocationRequirementsCurrent(invocationRequirements);
  const invocation =
    invocationRequirements ??
    (realmRequirements?.source
      ? planNativeInvocationRequirements(realmRequirements.source, { utf8Storage: options.utf8Storage === true })
      : undefined);
  const result = Object.freeze({ demands, invocation });
  strings.set(result, {
    program,
    projection,
    options,
    invocation: invocationRequirements,
    realm: realmRequirements,
    snapshot: freezePreparedIrValue({
      program,
      projection,
      options,
      invocationRequirements,
      realmRequirements,
      semantic: result,
    }),
  });
  return result;
}
export function completeNativeProgramStringSemantics(
  semantic: ReturnType<typeof collectNativeProgramStringSemantics>,
  outputOptions: NativeStringOutputOptions | undefined,
  requireValues: boolean,
) {
  const owner = strings.get(semantic);
  if (!owner) invalid("unissued string semantic acquisition");
  assertPreparedIrData({
    program: owner.program,
    projection: owner.projection,
    options: owner.options,
    invocationRequirements: owner.invocation,
    realmRequirements: owner.realm,
    semantic,
    outputOptions,
  });
  if (
    preparedIrDataMismatch(owner.snapshot, {
      program: owner.program,
      projection: owner.projection,
      options: owner.options,
      invocationRequirements: owner.invocation,
      realmRequirements: owner.realm,
      semantic,
    }) !== undefined
  )
    invalid("changed string semantic acquisition");
  assertPreparedIrProgram(owner.program);
  if (
    !owner.program.runtime.includes(owner.projection) ||
    semantic.demands.program !== owner.program ||
    semantic.demands.projection !== owner.projection
  )
    invalid("foreign current string projection");
  if (semantic.invocation) assertNativeInvocationRequirementsCurrent(semantic.invocation);
  if (owner.invocation) {
    assertNativeInvocationRequirementsCurrent(owner.invocation);
    if (
      owner.invocation.source.demands.program !== owner.program ||
      owner.invocation.source.demands.projection !== owner.projection
    )
      invalid("borrowed current invocation");
  }
  if (owner.realm) {
    assertNativeRealmRequirementsCurrent(owner.realm);
    if (owner.realm.program !== owner.program || owner.realm.projection !== owner.projection)
      invalid("borrowed current realm");
  }
  if (typeof requireValues !== "boolean") invalid("invalid value requirement mode");
  if (
    outputOptions &&
    preparedIrDataMismatch(outputOptions, { emptyIdentity: owner.options.stringConcatEmptyIdentity ?? true }) !==
      undefined
  )
    invalid("foreign string output options");
  const outputRequirements = outputOptions
    ? deriveNativeStringOutputRequirements(semantic.demands, outputOptions)
    : undefined;
  if (outputRequirements && "kind" in outputRequirements) return outputRequirements;
  const valueRequirements = requireValues
    ? deriveNativeValueResourcePlan(owner.program, owner.projection, "native-string")
    : undefined;
  return Object.freeze({ outputRequirements, valueRequirements });
}
export function assertNativeProgramRealmRequirements(requirements: NativeRealmRequirements): void {
  assertNativeRealmRequirementsCurrent(requirements);
}
/** Complete independent vector association, not acceptance of a detached plan or caller verdict. */
export function assertNativeProgramFoundationVectors(
  input: {
    readonly demands: { readonly program: PreparedIrProgram; readonly projection: PreparedIrProgramRuntimeProjection };
  },
  plan: NativeVectorResourcePlan,
): void {
  const { program, projection } = input.demands;
  const anchor = program.inventory.sources.find((row) => row.kind === "entry");
  if (!anchor) throw Error("native realm composition: missing vector entry anchor");
  const expected = deriveNativeVectorResourcePlan({
    anchor: anchor.id,
    functions: program.ir.functions,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: projection.backend,
    target: projection.target,
  });
  if (preparedIrDataMismatch(plan, expected) !== undefined)
    throw Error("native realm composition: vector plan differs from selected program/projection");
}

/** Complete current class catalogue, returned as descriptive DATA. */
export function describeNativeProgramClassPreflight(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
) {
  const gaps: { detail: string; unitId?: IrUnitId }[] = [];
  const add = (detail: string, unitId?: IrUnitId): void => {
    gaps.push(unitId === undefined ? { detail } : { detail, unitId });
  };
  const nativeJsClass = collectNativeProgramClassRequirements(program, projection);
  const classDescription =
    nativeJsClass && describeNativeProgramClassPhysicalRequirements(nativeJsClass, program, projection);
  if (nativeJsClass) {
    const construction = nativeProgramClassConstruction(nativeJsClass, program, projection);
    if (projection.backend !== "wasmgc") add("native class Linear physical catalogue is not yet issued");
    for (const fn of projection.prepared.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (
              instruction.kind.startsWith("dyn.") ||
              instruction.kind === "tag.test" ||
              instruction.kind === "unbox" ||
              (instruction.kind === "const" && instruction.resultType?.kind === "dynamic")
            )
              add("native class tagged physical recipe is not yet issued for " + instruction.kind, fn.unitId);
          });
    for (const row of nativeJsClass.occurrences) {
      const instruction = row.instruction;
      if (instruction.kind === "js.class.construct") {
        const recipe = construction.find((item) => item.instruction === instruction);
        if (!recipe || recipe.gap) add(recipe?.gap ?? "missing actual constructor candidate closure", row.unitId);
        continue;
      }
      if (
        !(
          instruction.kind === "js.class.frame.new" ||
          (instruction.kind === "js.class.binding.read" && instruction.storage.kind === "module") ||
          instruction.kind === "js.class.frame.get" ||
          (instruction.kind === "js.class.define" && instruction.captures.length === 0) ||
          (instruction.kind === "js.class.binding.init" && instruction.storage.kind === "module") ||
          (instruction.kind === "js.class.constructor.complete" && instruction.completion.kind === "normal")
        )
      )
        add("native class physical recipe is not yet issued for " + instruction.kind, row.unitId);
    }
  }

  return {
    requirements: nativeJsClass,
    description: classDescription,
    gaps,
    exceptionRequired: (nativeJsClass?.errors.length ?? 0) !== 0,
  };
}

export interface NativeProgramClassConstruction {
  readonly instruction: Extract<IrInstr, { kind: "js.class.construct" }>;
  readonly unitId: IrUnitId;
  readonly targets: readonly { readonly definitionId: IrBindingId; readonly fn: IrFunction }[];
  readonly newTargets: readonly IrBindingId[];
  readonly gap?: string;
}
/** Every actual construction use derives fresh candidates after complete canonical currentness. */
export function nativeProgramClassConstruction(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): readonly NativeProgramClassConstruction[] {
  assertNativeProgramClassRequirementsCurrent(requirements, program, projection);
  return constructionCatalogue(requirements, program, projection);
}
/** Reconstruct conditional DATA afresh; this is neither a physical token nor a report input. */
function constructionCatalogue(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): readonly NativeProgramClassConstruction[] {
  const module = constructionModule(program, projection.prepared.functions);
  const actual = module.functions.flatMap((fn) => {
    const rows: { fn: IrFunction; instruction: Extract<IrInstr, { kind: "js.class.construct" }> }[] = [];
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "js.class.construct") rows.push({ fn, instruction });
        });
    return rows;
  });
  if (!actual.length) return [];
  const mutationGap = [program.ir.functions, ...program.runtime.map((view) => view.prepared.functions)]
    .map((functions) => constructionOperationGap(requirements, program, constructionModule(program, functions)))
    .find((gap) => gap !== undefined);
  if (mutationGap)
    return actual.map(({ fn, instruction }) => ({
      instruction,
      unitId: fn.unitId,
      targets: [],
      newTargets: [],
      gap: mutationGap,
    }));
  const normalized = normalizeNativeClassValues(program, module, "selected");
  if (normalized.kind !== "normalized")
    return actual.map(({ fn, instruction }) => ({
      instruction,
      unitId: fn.unitId,
      targets: [],
      newTargets: [],
      gap: "constructor value context is not represented",
    }));
  const input = normalized.input,
    result = analyzeNativeJsClassValueDomains(input);
  if (replayNativeJsClassValueDomains(input, result).length) invalid("constructor value equations disagree");
  if (preparedIrDataMismatch(input.module, module) !== undefined) invalid("normalized constructor body DATA differs");
  const indexed = indexNativeJsClassValueDomainInput({ ...input, module });
  const same = (a: unknown, b: unknown) => preparedIrDataMismatch(a, b) === undefined;
  type Root = Extract<NativeJsValueRoot, { kind: "allocation" }>;
  const roots = (domain: NativeJsValueDomain): readonly Root[] | undefined => {
    if (
      domain.kind !== "known" ||
      domain.families.length !== 1 ||
      domain.families[0] !== "Function" ||
      !domain.roots.length
    )
      return undefined;
    const found: Root[] = [];
    for (const root of domain.roots) {
      if (
        root.kind !== "allocation" ||
        root.view !== "constructor" ||
        root.definitionId === null ||
        root.memberOrdinal !== null
      )
        return undefined;
      const entry = input.definitions.find((row) => row.bindingId === root.definitionId);
      const definition = indexed
        .get(root.unitId)
        ?.occurrences.find(({ instr }) => instr.kind === "js.class.define" && instr.alloc === root.site)?.instr;
      if (
        !entry ||
        definition?.kind !== "js.class.define" ||
        definition.definition !== root.definitionId ||
        definition.result === null
      )
        return undefined;
      for (const [key, view] of [
        [{ kind: "literal", value: "prototype" }, "prototype"],
        [{ kind: "internal", value: "environment" }, "environment"],
      ] as const) {
        const cells = result.heap.filter((cell) => same(cell.root, root) && same(cell.key, key));
        const domain = cells[0]?.valueDomain;
        if (
          cells.length !== 1 ||
          cells[0]!.presence !== "present" ||
          domain?.kind !== "known" ||
          domain.families.length !== 1 ||
          domain.families[0] !== "Object" ||
          domain.roots.length !== 1 ||
          !same(domain.roots[0], { ...root, view })
        )
          return undefined;
        if (result.heap.some((cell) => same(cell.root, root) && cell.key.kind === "wildcard")) return undefined;
      }
      found.push(root);
    }
    return found;
  };
  return actual.map(({ fn, instruction }) => {
    const base = {
      instruction,
      unitId: fn.unitId,
      targets: [] as { definitionId: IrBindingId; fn: IrFunction }[],
      newTargets: [] as IrBindingId[],
    };
    const occurrence = indexed.get(fn.unitId)?.occurrences.find((row) => row.instr === instruction);
    const calls = result.calls.filter(
      (row) => occurrence && row.kind === "construct" && same(row.location, occurrence.location),
    );
    if (calls.length !== 1) invalid("missing exact constructor equation occurrence");
    const call = calls[0]!,
      callee = roots(call.calleeDomain);
    const targetRows = result.values.filter((row) => row.unitId === fn.unitId && row.value === instruction.newTarget);
    const newTarget = targetRows.length === 1 ? roots(targetRows[0]!.domain) : undefined;
    if (!callee || !newTarget || call.obligations.length)
      return { ...base, gap: "constructor/newTarget candidate closure is unknown or contains an unhandled root" };
    const wanted = new Set<string>();
    for (const root of callee) {
      const entry = input.definitions.find((row) => row.bindingId === root.definitionId)!;
      const descriptor = entry.definition,
        body = indexed.get(descriptor.constructor.unitId)?.fn;
      if (
        !body ||
        descriptor.implicitConstructor ||
        descriptor.instanceElements.length ||
        descriptor.constructorKind !== "base"
      )
        return {
          ...base,
          gap: "constructor requires its actual explicit base body and an empty field initialization schedule",
        };
      const signature = [
        descriptor.constructor.frame.environmentType,
        descriptor.constructor.frame.thisType,
        descriptor.constructor.frame.homeObjectType,
        descriptor.constructor.frame.newTargetType,
        ...descriptor.constructor.params,
      ];
      if (
        !same(
          body.params.map((row) => row.type),
          signature,
        ) ||
        descriptor.constructor.params.some((type) => type.kind !== "dynamic")
      )
        invalid("constructor actual USER/hidden signature differs");
      const instructions = body.blocks.flatMap((block) => block.instrs);
      if (
        body.blocks.length !== 1 ||
        instructions.length !== 2 ||
        instructions[0]?.kind !== "js.class.frame.new" ||
        instructions[1]?.kind !== "js.class.constructor.complete" ||
        instructions[1].completion.kind !== "normal"
      )
        return { ...base, gap: "constructor body requires a separately issued nonempty/completion recipe" };
      wanted.add(descriptor.constructor.unitId + ":" + root.definitionId);
      if (!base.targets.some((row) => row.definitionId === root.definitionId))
        base.targets.push({ definitionId: root.definitionId!, fn: body });
    }
    const observed = new Set(call.targets.map((row) => row.unitId + ":" + row.definitionId));
    if (
      wanted.size !== observed.size ||
      [...wanted].some((key) => !observed.has(key)) ||
      call.targets.some((row) => row.sourceBodyKind !== "constructor")
    )
      invalid("constructor target census differs");
    for (const root of newTarget)
      if (!base.newTargets.includes(root.definitionId!)) base.newTargets.push(root.definitionId!);
    return base;
  });
}

/** Only compiler TDZ branches for unique, source-owned scalar startup pairs are graph-neutral.
 * Canonical runtime/evidence validation is still mandatory at the public owner entry. */
function constructionTdzOperations(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  fn: IrFunction,
): ReadonlySet<IrInstr> {
  const accepted = new Set<IrInstr>();
  const same = (left: unknown, right: unknown) => preparedIrDataMismatch(left, right) === undefined;
  const raw = (type: IrType | null, kind: "externref" | "i32" | "f64") => same(type, { kind: "val", val: { kind } });
  const canonical = irRuntimeFuncRef("__new_ReferenceError");
  const declarations = requirements.realmErrors.filter((row) => same(row.ref, canonical));
  const external = { kind: "val", val: { kind: "externref" } };
  if (
    declarations.length !== 1 ||
    !same(declarations[0]!.params, [external]) ||
    !same(declarations[0]!.results, [external])
  )
    return accepted;
  const callables = program.abi.entries.filter(
    (row) => row.plan.structuralReferenceKey === irCallableBindingKey(canonical.binding),
  );
  const callable = callables[0];
  if (
    callables.length !== 1 ||
    callable?.contract.kind !== "callable" ||
    callable.plan.slotPolicy !== "required" ||
    callable.plan.slotSpace !== "function" ||
    callable.plan.intent.kind !== "callable" ||
    callable.plan.intent.origin !== "runtime" ||
    !same(callable.contract.ref, canonical) ||
    !same(callable.contract.params, [external]) ||
    !same(callable.contract.results, [external]) ||
    !same(callable.plan.intent.signature, {
      params: ['externref:{"kind":"val","val":{"kind":"externref"}}'],
      results: ['externref:{"kind":"val","val":{"kind":"externref"}}'],
    })
  )
    return accepted;
  const owners = program.inventory.allUnits.filter((row) => row.id === fn.unitId);
  if (owners.length !== 1) return accepted;
  const pairs = new Map<string, IrGlobalRef[]>();
  for (const startup of program.startup) {
    if (
      startup.sourceId !== owners[0]!.sourceId ||
      program.startup.filter((row) => row.sourceId === startup.sourceId).length !== 1 ||
      program.inventory.allUnits.filter(
        (row) => row.id === startup.unitId && row.sourceId === startup.sourceId && row.kind === "module-init",
      ).length !== 1
    )
      continue;
    for (const binding of startup.bindings) {
      if (
        binding.initialization !== "tdz" ||
        binding.declarationKind === "var" ||
        !Number.isSafeInteger(binding.declarationOrdinal) ||
        binding.declarationOrdinal < 0 ||
        startup.bindings.filter((row) => row.declarationOrdinal === binding.declarationOrdinal).length !== 1 ||
        binding.globalBindingId !== irModuleGlobalBindingId(startup.sourceId, binding.declarationOrdinal) ||
        binding.tdzBindingId !== irModuleTdzGlobalBindingId(startup.sourceId, binding.declarationOrdinal)
      )
        continue;
      const refs: IrGlobalRef[] = [];
      for (const [id, flag] of [
        [binding.globalBindingId, false],
        [binding.tdzBindingId, true],
      ] as const) {
        const entries = program.abi.entries.filter((row) => row.plan.id === id);
        const entry = entries[0];
        if (
          entries.length !== 1 ||
          entry?.contract.kind !== "global" ||
          entry.contract.ref.binding.kind !== "source" ||
          entry.contract.ref.binding.bindingId !== id ||
          !same(entry.contract.ref.binding, { kind: "source", bindingId: id }) ||
          entry.plan.structuralReferenceKey !== irGlobalBindingKey(entry.contract.ref.binding) ||
          entry.plan.slotPolicy !== "required" ||
          entry.plan.slotSpace !== "global" ||
          entry.plan.intent.kind !== "global" ||
          entry.plan.intent.origin !== "source" ||
          entry.plan.intent.sourceId !== startup.sourceId ||
          entry.plan.intent.unitId !== startup.unitId ||
          !entry.contract.mutable ||
          !entry.plan.intent.mutable ||
          entry.plan.intent.valueType !==
            `${entry.contract.type.kind === "val" ? entry.contract.type.val.kind : ""}:${JSON.stringify(entry.contract.type)}` ||
          !(flag ? raw(entry.contract.type, "i32") : raw(entry.contract.type, "f64") || raw(entry.contract.type, "i32"))
        )
          break;
        refs.push(entry.contract.ref);
      }
      if (refs.length === 2) {
        const key = irGlobalBindingKey(refs[1]!.binding);
        pairs.set(key, [...(pairs.get(key) ?? []), refs[1]!]);
      }
    }
  }
  const walk = (buffer: readonly IrInstr[], incoming: ReadonlyMap<IrValueId, IrInstr>) => {
    const available = new Map(incoming);
    for (const instruction of buffer) {
      if (instruction.kind === "if.stmt") {
        const condition = available.get(instruction.cond);
        const read = condition?.kind === "unary" ? available.get(condition.rand) : undefined;
        const [message, call, thrown] = instruction.then;
        const pair = read?.kind === "global.get" ? pairs.get(irGlobalBindingKey(read.target.binding)) : undefined;
        if (
          instruction.result === null &&
          instruction.resultType === null &&
          condition?.kind === "unary" &&
          condition.op === "i32.eqz" &&
          raw(condition.resultType, "i32") &&
          read?.kind === "global.get" &&
          raw(read.resultType, "i32") &&
          pair?.length === 1 &&
          same(read.target, pair[0]) &&
          instruction.then.length === 3 &&
          instruction.else.length === 0 &&
          message?.kind === "const" &&
          message.value.kind === "null" &&
          raw(message.value.ty, "externref") &&
          raw(message.resultType, "externref") &&
          message.result !== null &&
          call?.kind === "call" &&
          same(call.target, canonical) &&
          call.args.length === 1 &&
          call.args[0] === message.result &&
          call.result !== null &&
          raw(call.resultType, "externref") &&
          thrown?.kind === "throw" &&
          thrown.value === call.result &&
          thrown.result === null &&
          thrown.resultType === null
        ) {
          accepted.add(call);
          accepted.add(thrown);
        }
      }
      forEachNestedBuffer(instruction, (nested) => walk(nested, available));
      if (instruction.result !== null) available.set(instruction.result, instruction);
    }
  };
  for (const block of fn.blocks) walk(block.instrs, new Map());
  return accepted;
}

/** Abstract root equality cannot distinguish repeated runtime definitions.
 * This finite subset excludes writes/calls that could replace their graph links. */
function constructionOperationGap(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  module: { readonly functions: readonly IrFunction[] },
): string | undefined {
  const globals = new Set<string>();
  for (const { definition } of requirements.domain.definitions) {
    const realm = new Set(Object.values(definition.realm));
    for (const entry of program.abi.entries)
      if (entry.contract.kind === "global" && realm.has(entry.plan.id))
        globals.add(irGlobalBindingKey(entry.contract.ref.binding));
    for (const binding of [definition.outerBinding, definition.innerBinding])
      for (const ref of [binding?.valueGlobal, binding?.tdzGlobal])
        if (ref) globals.add(irGlobalBindingKey(ref.binding));
  }
  const scalar = (type: IrType) =>
    type.kind === "val" && !type.typeRef && (type.val.kind === "f64" || (type.val.kind === "i32" && !type.val.symbol));
  let gap: string | undefined;
  for (const fn of module.functions) {
    const tdz = constructionTdzOperations(requirements, program, fn);
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (tdz.has(instruction)) return;
          if (instruction.kind === "global.set" && globals.has(irGlobalBindingKey(instruction.target.binding)))
            gap = "constructor graph may be replaced by a direct support-global write";
          if (instruction.kind === "call") {
            const binding = instruction.target.binding;
            const target =
              binding.kind === "unit" ? module.functions.find((row) => row.unitId === binding.unitId) : undefined;
            if (
              !target ||
              !target.params.every((row) => scalar(row.type)) ||
              !target.resultTypes.every(scalar) ||
              !program.inventory.allUnits.some((row) => row.id === target.unitId && row.kind === "top-level-function")
            )
              gap = "constructor graph has an opaque or reference-transporting call effect";
            return;
          }
          if (
            ![
              "const",
              "box",
              "binary",
              "unary",
              "if",
              "if.stmt",
              "select",
              "early.return",
              "global.get",
              "global.set",
              "js.class.define",
              "js.class.binding.init",
              "js.class.binding.read",
              "js.class.construct",
              "js.class.frame.new",
              "js.class.frame.get",
              "js.class.constructor.complete",
            ].includes(instruction.kind)
          )
            gap = "constructor original prototype/environment has an unissued write/effect: " + instruction.kind;
        });
  }
  return gap;
}

/** Each original/selected view retains its own exact units; support is appended once. */
function constructionModule(program: PreparedIrProgram, functions: readonly IrFunction[]) {
  const complete = [...functions];
  for (const support of irRuntimeSupportFunctions(program.runtimeSupport)) {
    const existing = complete.filter((fn) => fn.unitId === support.unitId);
    if (existing.length > 1 || (existing.length === 1 && existing[0] !== support))
      invalid("constructor support unit substituted or duplicated");
    if (!existing.length) complete.push(support);
  }
  return { functions: complete };
}
