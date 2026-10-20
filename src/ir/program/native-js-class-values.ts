// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Conditional analysis context; this module grants no backend admission.
import type { PreparedIrProgram, PreparedIrAbiEntry, PreparedIrProgramFailure } from "./prepared-contracts.js";
import type { IrModule } from "../core/nodes.js";
import type { IrBindingId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { NativeJsClassValueDomainInput as Input } from "../analysis/allocation-evidence/js-class-value-domains/contracts.js";
import {
  assertPreparedIrData,
  copyPreparedIrDataObject,
  freezePreparedIrValue,
  preparedIrDataMismatch,
} from "../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import { assertPreparedIrProgramPopulation } from "./population.js";
import { preparedIrJsClassDefinitions, assertPreparedIrJsClassDefinitions } from "./js-class-definition.js";
import { assertPreparedIrJsClassStartup } from "./js-class-startup.js";
import { assertPreparedStartupInvocation } from "./startup-validation.js";
import { assertIrRuntimeSupport, irRuntimeSupportFunctions } from "./runtime-support.js";
import { irUnitFuncRef, irUnitCallableBindingId, irCallableBindingKey } from "../core/callable-bindings.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import { irBindingKey } from "../core/declared-types.js";
import { forEachInstrDeep } from "../core/nodes.js";
import { indexNativeJsClassValueDomainInput } from "../analysis/allocation-evidence/js-class-value-domains/input.js";
import { analyzeNativeJsClassValueDomains } from "../analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../analysis/allocation-evidence/js-class-value-domains/independent.js";
import type { PreparedIrFunction } from "../runtime/contracts/prepared.js";
import { preparedIrProgramCallableResults } from "./callable-results.js";
import { preparedIrProgramOwner } from "./owner.js";

type Context = Pick<
  PreparedIrProgram,
  "inventory" | "derivedUnits" | "abi" | "startup" | "allocations" | "runtimeSupport"
> &
  Partial<Pick<PreparedIrProgram, "ir" | "runtime">>;
type GlobalExport = { readonly externalName: string; readonly bindingId: IrBindingId };
export type Normalization =
  | { readonly kind: "class-free" }
  | { readonly kind: "unrepresented"; readonly unitId: IrUnitId | null; readonly detail: string }
  | {
      readonly kind: "normalized";
      readonly input: Input;
      readonly globalExports: readonly GlobalExport[];
      readonly invocation: readonly { readonly sourceId: string; readonly kind: string }[];
    };
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class values context: ${detail}`);
}
function resolve(entries: ReadonlyMap<IrBindingId, PreparedIrAbiEntry>, id: IrBindingId): PreparedIrAbiEntry {
  const seen = new Set<IrBindingId>();
  let entry = entries.get(id);
  while (entry?.plan.slotPolicy === "alias") {
    if (seen.has(entry.plan.id)) invalid("ABI alias cycle");
    seen.add(entry.plan.id);
    entry = entries.get(entry.plan.aliasOf);
  }
  if (!entry) invalid("ABI alias/export target missing");
  return entry;
}
function startup(context: Context, module: IrModule): void {
  if (context.startup.length !== context.inventory.sources.length) invalid("startup source census differs");
  const functions = new Set(module.functions.map((fn) => fn.unitId));
  const globals = new Set(
    context.abi.entries.filter((row) => row.contract.kind === "global").map((row) => row.plan.id),
  );
  const seeds = new Set<IrBindingId>();
  for (const [index, plan] of context.startup.entries()) {
    assertPreparedStartupInvocation(plan);
    if (plan.sourceId !== context.inventory.sources[index]!.id) invalid("startup dependency order differs");
    const owners = context.inventory.terminalUnits.filter(
      (unit) => unit.sourceId === plan.sourceId && unit.kind === "module-init",
    );
    if (
      plan.executable
        ? owners.length !== 1 || plan.unitId !== owners[0]!.id || !functions.has(plan.unitId)
        : plan.unitId !== null || owners.length !== 0
    )
      invalid("startup actual body owner differs");
    if (plan.gaps.length) invalid("startup retains unresolved binding/export gaps");
    for (const binding of plan.bindings)
      for (const id of [binding.globalBindingId, binding.tdzBindingId])
        if (id !== null && !globals.has(id)) invalid("startup lacks declared global storage");
    for (const seed of plan.liveSeeds) {
      const original = context.inventory.allUnits.find((unit) => unit.id === seed.unitId);
      if (
        original?.kind !== "top-level-function" ||
        original.sourceId !== plan.sourceId ||
        seed.liveGlobalBindingId !==
          createIrBindingId({ ownerId: seed.unitId, domain: "global", role: "live-function" }) ||
        seeds.has(seed.liveGlobalBindingId) ||
        !globals.has(seed.liveGlobalBindingId) ||
        !functions.has(seed.unitId) ||
        seed.callableBindingId !== irUnitCallableBindingId(seed.unitId)
      )
        invalid("startup live seed owner differs");
      seeds.add(seed.liveGlobalBindingId);
    }
  }
}

/** Reconstruct complete current DATA, never accept reports, entry hints or builtin labels. */
export function normalizeNativeClassValues(
  context: Context,
  actualModule: IrModule,
  namespace: Input["namespace"],
): Normalization {
  // Conditional normalization only. The caller still owns complete ABI plan/contract
  // and actual runtime projection validation; no normalized result is a permission.
  // Screen all DATA before reading any proposed ABI/body property.
  assertPreparedIrData(copyPreparedIrDataObject({ context, actualModule }));
  if (namespace !== "original" && namespace !== "selected") invalid("namespace differs");
  const definitions = preparedIrJsClassDefinitions(context.abi.entries);
  let hasInstruction = false;
  for (const fn of actualModule.functions) {
    const buffers = [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
      ...((fn as PreparedIrFunction).asyncRuntime?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of buffers)
      for (const instruction of buffer)
        forEachInstrDeep(instruction, (instr) => {
          hasInstruction ||= instr.kind.startsWith("js.class.");
        });
  }
  const hasStartupClass = context.startup.some((plan) => (plan.jsClassStartup?.definitions.length ?? 0) !== 0);
  if (!definitions.length && !hasInstruction && !hasStartupClass) return { kind: "class-free" };
  if (!definitions.length) invalid("native class instructions/startup lack actual definitions");
  assertPreparedIrJsClassDefinitions(
    context.inventory,
    definitions.map((row) => row.definition),
    actualModule,
  );
  assertPreparedIrJsClassStartup(
    context.startup,
    definitions.map((row) => row.definition),
    context.inventory,
  );
  const entries = new Map(context.abi.entries.map((entry) => [entry.plan.id, entry]));
  if (entries.size !== context.abi.entries.length) invalid("duplicate ABI binding");
  for (const entry of entries.values()) if (entry.plan.slotPolicy === "alias") resolve(entries, entry.plan.id);
  const support = irRuntimeSupportFunctions(context.runtimeSupport);
  const supportIds = new Set(support.map((fn) => fn.unitId));
  const sourceModule = { functions: actualModule.functions.filter((fn) => !supportIds.has(fn.unitId)) };
  assertPreparedIrProgramPopulation({ ...context, ir: sourceModule }, context.abi);
  assertIrRuntimeSupport({ ...context, ir: sourceModule }, context.runtimeSupport);
  // The actual module may omit support bodies; append each authentic implementation exactly once.
  const functions = [...actualModule.functions];
  for (const fn of support) {
    const existing = functions.filter((candidate) => candidate.unitId === fn.unitId);
    if (existing.length > 1 || (existing.length === 1 && existing[0] !== fn))
      invalid("support body substituted or duplicated");
    if (!existing.length) functions.push(fn);
  }
  const module = { functions };
  startup(context, module);
  if (context.startup.some((plan) => plan.liveSeeds.length !== 0))
    return {
      kind: "unrepresented",
      unitId: null,
      detail: "native live-function storage initialization is not represented",
    };
  const roles = definitions.flatMap(({ definition }) =>
    [
      definition.constructor,
      ...definition.members.map((row) => row.body),
      ...definition.instanceElements.flatMap((row) => (row.initializer ? [row.initializer] : [])),
    ].map((body) => ({ definition, body })),
  );
  const units: Input["units"] = functions.map((fn) => {
    const original = context.inventory.allUnits.find((unit) => unit.id === fn.unitId);
    const derived = context.derivedUnits.find((unit) => unit.id === fn.unitId);
    const batch = context.runtimeSupport?.batches.find((row) => row.implementation.body.unitId === fn.unitId);
    if (Number(Boolean(original)) + Number(Boolean(derived)) + Number(Boolean(batch)) !== 1)
      invalid("body lacks one exact owner");
    const role = roles.find((row) => row.body.unitId === fn.unitId);
    return {
      unitId: fn.unitId,
      kind: original ? "source" : derived ? "derived" : "builtin",
      sourceClassId: role?.definition.sourceClassId ?? null,
      sourceBodyKind: role?.body.sourceBodyKind ?? null,
      target: batch?.implementation.declaration.ref ?? irUnitFuncRef(fn),
    };
  });
  assertCallableBodyJoins(functions, units, context.abi.entries);
  const signatures: Input["declarations"]["signatures"][number][] = [];
  const globals: Input["globals"][number][] = [];
  const signatureKeys = new Set<string>(),
    globalKeys = new Set<string>();
  for (const entry of context.abi.entries) {
    if (entry.plan.slotPolicy === "alias") continue;
    const contract = entry.contract;
    if (contract.kind === "callable") {
      if (contract.results.length > 1)
        return { kind: "unrepresented", unitId: null, detail: "multiple logical result slots are not represented" };
      const key = irBindingKey(contract.ref.binding);
      if (!key || signatureKeys.has(key)) invalid("duplicate/invalid callable declaration");
      signatureKeys.add(key);
      signatures.push({ key, signature: { params: contract.params, result: contract.results[0] ?? null } });
    }
    if (contract.kind !== "global") continue;
    const key = irBindingKey(contract.ref.binding);
    if (!key || globalKeys.has(key)) invalid("duplicate/invalid global declaration");
    globalKeys.add(key);
    const classBinding = definitions
      .flatMap((row) => [row.definition.outerBinding, row.definition.innerBinding])
      .find((binding) => binding?.valueGlobal?.binding.bindingId === contract.ref.binding.bindingId);
    const declarations = context.startup
      .flatMap((plan) => plan.bindings)
      .filter((binding) => binding.globalBindingId === contract.ref.binding.bindingId);
    if (declarations.length > 1) invalid("multiple startup initializers for one global");
    globals.push({
      ref: contract.ref,
      type: contract.type,
      mutable: contract.mutable,
      initial:
        classBinding || declarations[0]?.initialization === "tdz"
          ? { kind: "uninitialized" }
          : declarations[0]?.initialization === "undefined-at-instantiation"
            ? { kind: "constant", value: { kind: "undefined" } }
            : { kind: "unknown" },
    });
  }
  const exported: Input["exports"][number][] = [],
    globalExports: GlobalExport[] = [];
  const names = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.contract.kind !== "export") continue;
    const contract = entry.contract;
    if (!contract.externalName || names.has(contract.externalName)) invalid("duplicate/empty export name");
    names.add(contract.externalName);
    const target = resolve(entries, contract.targetId).contract;
    if (target.kind === "global") {
      globalExports.push({ externalName: contract.externalName, bindingId: target.ref.binding.bindingId });
      continue;
    }
    if (target.kind !== "callable") invalid("export target has no callable/global contract");
    if (target.results.length > 1)
      return { kind: "unrepresented", unitId: null, detail: "exported multiple logical results are not represented" };
    exported.push({
      externalName: contract.externalName,
      target: target.ref,
      logicalParams: target.params,
      logicalResult: target.results[0] ?? null,
    });
  }
  for (const fn of functions)
    if (fn.asyncPlan || Object.hasOwn(fn, "asyncRuntime") || fn.funcKind === "async" || fn.funcKind === "generator")
      return {
        kind: "unrepresented",
        unitId: fn.unitId,
        detail: "async/generator state-buffer census is not represented",
      };
  const exportedUnits = new Set(
    exported.map(
      (row) =>
        units.find((unit) => irCallableBindingKey(unit.target.binding) === irCallableBindingKey(row.target.binding))
          ?.unitId,
    ),
  );
  const input: Input = {
    ...(!Object.hasOwn(context, "runtime")
      ? {}
      : {
          runtimeContext: {
            inventory: context.inventory,
            derivedUnits: context.derivedUnits,
            abiEntries: context.abi.entries,
            startup: context.startup,
            original: context.ir === undefined ? undefined : { functions: context.ir.functions },
            runtimeSupport: context.runtimeSupport ?? null,
            projections: context.runtime?.map((view) => ({
              backend: view.backend,
              target: view.target,
              functions: view.prepared.functions,
              manifest: view.prepared.manifest,
              providers: [...view.prepared.providers].map(([intrinsicId, plan]) => ({ intrinsicId, plan })),
            })),
          } as unknown as NonNullable<Input["runtimeContext"]>,
        }),
    schema: "native-js-class-value-domain-input-v1",
    namespace,
    module,
    units,
    definitions,
    globals,
    declarations: {
      signatures,
      globals: globals.map((row) => ({ key: irBindingKey(row.ref.binding)!, type: row.type })),
    },
    startupUnits: context.startup.flatMap((plan) => (plan.executable && plan.unitId ? [plan.unitId] : [])),
    exports: exported,
    entryInputs: functions.flatMap((fn) =>
      exportedUnits.has(fn.unitId)
        ? fn.params.map((parameter, index) => ({
            unitId: fn.unitId,
            parameter: index,
            transport: "external-js" as const,
            type: parameter.type,
          }))
        : [],
    ),
  };
  indexNativeJsClassValueDomainInput(input);
  return freezePreparedIrValue({
    kind: "normalized",
    input,
    globalExports,
    invocation: context.startup.map((plan) => ({ sourceId: plan.sourceId, kind: plan.invocation.kind })),
  }) as Normalization;
}

/** A single-result analysis refusal must not hide a contradictory whole callable. */
function assertCallableBodyJoins(
  functions: IrModule["functions"],
  units: Input["units"],
  entries: readonly PreparedIrAbiEntry[],
): void {
  for (const [index, fn] of functions.entries()) {
    const key = irBindingKey(units[index]!.target.binding);
    const matches = entries.filter(
      (entry) =>
        entry.plan.slotPolicy !== "alias" &&
        entry.contract.kind === "callable" &&
        irBindingKey(entry.contract.ref.binding) === key,
    );
    const contract = matches[0]?.contract;
    if (
      matches.length !== 1 ||
      contract?.kind !== "callable" ||
      preparedIrDataMismatch(
        contract.params,
        fn.params.map((parameter) => parameter.type),
      ) !== undefined ||
      preparedIrDataMismatch(contract.results, preparedIrProgramCallableResults(fn)) !== undefined
    )
      invalid(`body ${fn.unitId} lacks its exact complete ABI signature`);
  }
}

/** Fresh, conditional equations only: no supplied report, token, transport or cache. */
export function checkNativeClassValueEquations(
  context: Context,
  module: IrModule,
  namespace: Input["namespace"],
): Normalization {
  try {
    const normalized = normalizeNativeClassValues(context, module, namespace);
    if (normalized.kind !== "normalized") return normalized;
    const description = analyzeNativeJsClassValueDomains(normalized.input);
    const problems = replayNativeJsClassValueDomains(normalized.input, description);
    if (problems.length) invalid(`independent value equations disagree: ${JSON.stringify(problems)}`);
    // Keep global exports and invocation classification explicitly conditional.
    return normalized;
  } catch (error) {
    if (error instanceof PreparedIrProgramInvariantError) throw error;
    return invalid(
      `conditional value context is malformed: ${error instanceof Error ? error.message : "unreadable DATA"}`,
    );
  }
}

/** The preparation boundary can locate a genuine unrepresented context. */
export function prepareNativeClassValueEquations(
  context: Context & Pick<PreparedIrProgram, "ir">,
): PreparedIrProgramFailure | undefined {
  const checked = checkNativeClassValueEquations(context, context.ir, "original");
  if (checked.kind !== "unrepresented") return undefined;
  const first = preparedIrJsClassDefinitions(context.abi.entries)[0]?.definition;
  const unitId = checked.unitId ?? first?.evaluationOwnerUnitId;
  const owner = unitId === undefined ? undefined : preparedIrProgramOwner(context, unitId);
  if (!owner) invalid("unrepresented context lacks its genuine original source owner");
  return Object.freeze({
    kind: "unsupported",
    code: "class-projection-unsupported",
    stage: "resolve",
    detail: checked.detail,
    unitId: owner.unitId,
    location: owner.location,
    sourceFile: owner.sourceFile,
  });
}

/** Full canonical program/projection checks remain prerequisites at the caller. */
export function assertNativeClassValueEquations(
  context: Context,
  module: IrModule,
  namespace: Input["namespace"],
): void {
  const checked = checkNativeClassValueEquations(context, module, namespace);
  if (checked.kind === "unrepresented") invalid(`unrepresented class projection: ${checked.detail}`);
}
