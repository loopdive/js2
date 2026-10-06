// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { TypedIrProgramInput } from "./input-contracts.js";
import type { IrModuleInitPlan, IrModuleInitBindingIntent } from "./startup.js";
import type { IrSiteId, IrInstr } from "../core/nodes.js";
import type {
  IrSourceMapSpan,
  IrSourceMapTextProjection,
  IrSourceMapTextStage,
  IrSourceMapPoint,
  IrSourceMapGeneratedOrigin,
} from "../../shared/contracts/ir-unit-inventory.js";
import { irCallableBindingKey, irUnitCallableBindingId } from "../core/callable-bindings.js";
import { irGlobalBindingKey } from "../core/global-binding-keys.js";
import { irTypeBindingKey } from "../core/type-binding-keys.js";
import { irBindingKey } from "../core/declared-types.js";
import { forEachInstrDeep, forEachNestedBuffer } from "../core/nodes.js";
import type { IrDeclaredSignature } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { ProgramAbiMap } from "./abi.js";
import { preparedIrProgramCallableResults } from "./callable-results.js";
import {
  preparedIrCallableSignature,
  preparedIrClassLayoutKey,
  preparedIrDataKey,
  preparedIrTypeKey,
} from "./abi-signatures.js";
import { assertPreparedIrProgramPopulation } from "./population.js";
import { preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { PreparedIrAbiEntry, PreparedIrProgram } from "./prepared-contracts.js";
import {
  prepareIrProgramRuntimeCallables,
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "./runtime-abi.js";
import { verifyIrFunction, type IrVerificationOptions } from "../runtime/verify.js";
import { assertPreparedIrClassLayouts } from "./class-layouts.js";
import { assertPreparedIrProgramAllocations } from "./allocations.js";
import { assertIrRuntimeSupport } from "./runtime-support.js";
import { numberFormatRadixSupportDeclarations } from "./formatter-support.js";
import { assertPreparedIrRuntimeSupportDependencies } from "./runtime-support-dependencies.js";
import { irRuntimeCallableHasNoSlot } from "../runtime/native-async-callables.js";
import { assertPreparedIrRuntimeProjection, assertPreparedIrSemanticRuntimeSeparation } from "./runtime-validation.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
}

function sameSignature(
  left: { readonly params: readonly string[]; readonly results: readonly string[] },
  right: { readonly params: readonly string[]; readonly results: readonly string[] },
): boolean {
  return (
    left.params.length === right.params.length &&
    left.results.length === right.results.length &&
    left.params.every((value, index) => value === right.params[index]) &&
    left.results.every((value, index) => value === right.results[index])
  );
}

function validateEntry(entry: PreparedIrAbiEntry, entries: ReadonlyMap<string, PreparedIrAbiEntry>): void {
  const { plan, contract } = entry;
  if (plan.intent.kind !== contract.kind) invalid(`ABI binding ${plan.id} contradicts its semantic contract kind`);
  if (contract.kind === "callable" && plan.intent.kind === "callable") {
    if (!sameSignature(plan.intent.signature, preparedIrCallableSignature(contract.params, contract.results)))
      invalid(`ABI binding ${plan.id} contradicts its complete callable signature`);
    const key = irCallableBindingKey(contract.ref.binding);
    if (plan.slotPolicy === "alias") {
      const target = entries.get(plan.aliasOf);
      if (target?.contract.kind !== "callable" || irCallableBindingKey(target.contract.ref.binding) !== key)
        invalid(`ABI alias ${plan.id} contradicts its exact callable target`);
      if (
        plan.intent.origin !== "module-alias" ||
        contract.ref.binding.kind !== "unit" ||
        plan.intent.targetUnitId !== contract.ref.binding.unitId
      )
        invalid(`ABI alias ${plan.id} contradicts its source unit`);
    } else {
      if (plan.structuralReferenceKey !== key) invalid(`ABI callable ${plan.id} has a contradictory reference payload`);
      const binding = contract.ref.binding;
      if (binding.kind === "unit") {
        if (
          plan.id !== irUnitCallableBindingId(binding.unitId) ||
          plan.intent.unitId !== binding.unitId ||
          plan.intent.origin !== "source"
        )
          invalid(`ABI callable ${plan.id} has a contradictory unit binding`);
      } else if (binding.kind === "support") {
        if (plan.id !== binding.bindingId || plan.intent.origin !== "support")
          invalid(`ABI callable ${plan.id} has a contradictory support binding`);
      } else {
        if (plan.intent.origin !== binding.kind) invalid(`ABI callable ${plan.id} has a contradictory provider origin`);
        if (
          binding.kind === "import" &&
          (binding.capabilityId !== plan.intent.capabilityId || binding.providerId !== plan.intent.providerId)
        )
          invalid(`ABI callable ${plan.id} has contradictory capability provenance`);
      }
    }
  } else if (contract.kind === "global" && plan.intent.kind === "global") {
    if (
      plan.id !== contract.ref.binding.bindingId ||
      plan.structuralReferenceKey !== irGlobalBindingKey(contract.ref.binding) ||
      plan.intent.valueType !== preparedIrTypeKey(contract.type) ||
      plan.intent.mutable !== contract.mutable ||
      plan.intent.origin !== contract.ref.binding.kind
    )
      invalid(`ABI global ${plan.id} contradicts its declared storage`);
  } else if (contract.kind === "export" && plan.intent.kind === "export") {
    if (
      plan.slotPolicy !== "alias" ||
      plan.aliasOf !== contract.targetId ||
      plan.intent.targetId !== contract.targetId ||
      plan.intent.externalName !== contract.externalName
    )
      invalid(`ABI export ${plan.id} contradicts its declared target`);
  } else if (
    (contract.kind === "type" || contract.kind === "class") &&
    (plan.intent.kind === "type" || plan.intent.kind === "class")
  ) {
    if (
      plan.id !== contract.ref.binding.bindingId ||
      plan.structuralReferenceKey !== irTypeBindingKey(contract.ref.binding)
    )
      invalid(`ABI layout ${plan.id} contradicts its declared reference`);
    if (
      contract.kind === "type" &&
      plan.intent.kind === "type" &&
      plan.intent.shapeKey !== preparedIrTypeKey(contract.type)
    )
      invalid(`ABI type ${plan.id} contradicts its declared shape`);
    if (
      contract.kind === "class" &&
      plan.intent.kind === "class" &&
      (contract.ref.binding.kind !== "class" ||
        contract.ref.binding.classId !== contract.shape.classId ||
        plan.intent.classId !== contract.shape.classId ||
        plan.intent.layoutKey !== preparedIrClassLayoutKey(contract.shape))
    )
      invalid(`ABI class ${plan.id} contradicts its declared class layout`);
  } else if (contract.kind === "support" && plan.intent.kind === "support" && contract.role !== plan.intent.role)
    invalid(`ABI support ${plan.id} contradicts its declared role`);
}

/** Reconcile the final semantic demand against the canonical catalog, including shared ownership. */
function validateRuntimeCallables(program: PreparedIrProgram): void {
  const collected = prepareIrProgramRuntimeCallables(program);
  if (collected.kind !== "prepared")
    invalid(
      `${collected.sourceFile}:${collected.location.line}:${collected.location.column} (${collected.unitId}): ${collected.detail}`,
    );
  const actual = program.abi.entries.filter(
    (entry) =>
      entry.contract.kind === "callable" &&
      (entry.contract.ref.binding.kind === "runtime" || entry.contract.ref.binding.kind === "intrinsic"),
  );
  if (actual.length !== collected.declarations.length)
    invalid("runtime ABI declaration population differs from final semantic demand");
  if (actual.length === 0) return;
  const anchor = preparedIrRuntimeAbiAnchor(program.inventory);
  const runtimeEntries = new Set(actual);
  const firstOrder = program.abi.entries.filter(
    (entry) => !runtimeEntries.has(entry) && entry.plan.order.sourceOrder === anchor.order,
  ).length;
  for (const [index, declaration] of collected.declarations.entries()) {
    const key = irCallableBindingKey(declaration.ref.binding);
    const matches = actual.filter(
      (entry) => entry.contract.kind === "callable" && irCallableBindingKey(entry.contract.ref.binding) === key,
    );
    if (matches.length !== 1) invalid(`runtime ABI lacks one exact declaration for ${key}`);
    const expected: PreparedIrAbiEntry = {
      plan: {
        id: preparedIrRuntimeCallableBindingId(program.inventory, declaration.ref),
        order: { sourceOrder: anchor.order, declarationOrder: firstOrder + index },
        displayName: declaration.ref.name,
        structuralReferenceKey: key,
        ...(irRuntimeCallableHasNoSlot(declaration.ref)
          ? { slotPolicy: "none" as const }
          : { slotPolicy: "required" as const, slotSpace: "function" as const }),
        intent: {
          kind: "callable",
          origin: declaration.ref.binding.kind === "intrinsic" ? "intrinsic" : "runtime",
          signature: preparedIrCallableSignature(declaration.params, declaration.results),
        },
      },
      contract: { kind: "callable", ref: declaration.ref, params: declaration.params, results: declaration.results },
    };
    const mismatch = preparedIrDataMismatch(expected, matches[0]);
    if (mismatch !== undefined) invalid(`runtime ABI ${key} contradicts its canonical declaration at ${mismatch}`);
  }
}

/** Complete source-free validation precedes lookup reconstruction, backend acceptance and replay. */
export function assertPreparedIrProgram(program: PreparedIrProgram, options?: IrVerificationOptions): void {
  if (program.schema !== "prepared-ir-program-v1" || program.reconciliation !== "complete" || program.sealed !== true)
    invalid("program is not a complete prepared program");
  assertPreparedIrProgramPopulation(program);
  assertPreparedSourceMap(program);
  if (Object.hasOwn(program, "runtimeSupport") && program.runtimeSupport === undefined)
    invalid("runtime support must be absent rather than own-property undefined");
  assertIrRuntimeSupport(program, program.runtimeSupport);
  assertPreparedIrSemanticRuntimeSeparation(program);
  assertPreparedIrProgramAllocations(program);
  assertPreparedIrClassLayouts(program);
  if (program.units.size !== program.inventory.terminalUnits.length)
    invalid("program unit receipt denominator differs from original inventory");
  for (const unit of program.inventory.terminalUnits) {
    const receipt = program.units.get(unit.id);
    if (
      !receipt ||
      receipt.id !== unit.id ||
      receipt.sourceId !== unit.sourceId ||
      receipt.kind !== unit.kind ||
      receipt.declarationStart !== unit.declarationStart ||
      receipt.declarationEnd !== unit.declarationEnd
    )
      invalid(`program receipt ${unit.id} contradicts the original inventory`);
  }
  const entries = new Map(program.abi.entries.map((entry) => [entry.plan.id, entry]));
  if (entries.size !== program.abi.entries.length) invalid("program ABI duplicates a binding");
  for (const batch of program.runtimeSupport?.batches ?? []) {
    const canonical = numberFormatRadixSupportDeclarations(batch.sourceId);
    const refs = [
      canonical.scratch.type.ref,
      ...canonical.kernels.map((kernel) => kernel.ref),
      canonical.implementation.ref,
    ];
    const ids = refs.map((ref) => {
      if (ref.binding.kind !== "support") return invalid("formatter declaration is not support-owned");
      return ref.binding.bindingId;
    });
    const first = program.abi.entries.findIndex((entry) => entry.plan.id === ids[0]);
    if (first < 0) invalid("formatter ABI omits scratch type");
    const anchor = preparedIrRuntimeAbiAnchor(program.inventory);
    const firstOrder = program.abi.entries
      .slice(0, first)
      .filter((entry) => entry.plan.order.sourceOrder === anchor.order).length;
    for (const [index, id] of ids.entries()) {
      const entry = program.abi.entries[first + index];
      if (
        !entry ||
        entry.plan.id !== id ||
        entry.plan.slotPolicy !== "required" ||
        entry.plan.slotSpace !== (index === 0 ? "type" : "function") ||
        entry.plan.order.sourceOrder !== anchor.order ||
        entry.plan.order.declarationOrder !== firstOrder + index
      )
        invalid("formatter ABI lacks its exact ordered required declarations");
      if (index === 0) {
        if (
          preparedIrDataMismatch(entry.contract, {
            kind: "type",
            ref: canonical.scratch.type.ref,
            type: canonical.scratch.type,
          }) !== undefined
        )
          invalid("formatter ABI scratch contract differs from canonical declaration");
      } else {
        const callable = [...canonical.kernels, canonical.implementation][index - 1]!;
        if (
          entry.plan.intent.kind !== "callable" ||
          entry.plan.intent.origin !== "support" ||
          entry.plan.intent.sourceId !== batch.sourceId ||
          preparedIrDataMismatch(entry.contract, {
            kind: "callable",
            ref: callable.ref,
            params: callable.params,
            results: callable.results,
          }) !== undefined
        )
          invalid("formatter ABI callable differs from canonical source-owned declaration");
      }
    }
    const isRuntime = (entry: PreparedIrAbiEntry): boolean =>
      entry.contract.kind === "callable" &&
      (entry.contract.ref.binding.kind === "runtime" || entry.contract.ref.binding.kind === "intrinsic");
    if (
      program.abi.entries.slice(0, first).some(isRuntime) ||
      program.abi.entries.slice(first + ids.length).some((entry) => !isRuntime(entry))
    )
      invalid("formatter ABI must follow ordinary entries and precede the runtime tail");
  }
  validateRuntimeCallables(program);
  assertPreparedIrRuntimeSupportDependencies(program);
  const authority = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const entry of program.abi.entries) {
    validateEntry(entry, entries);
    authority.plan(entry.plan);
  }
  authority.sealPlan();
  const functions = new Map(program.ir.functions.map((fn) => [fn.unitId, fn]));
  const calls = new Map<string, PreparedIrAbiEntry>();
  const globals = new Map<string, PreparedIrAbiEntry>();
  const declaredSignatures = new Map<string, IrDeclaredSignature>();
  const declaredGlobals = new Map<string, IrType>();
  for (const entry of program.abi.entries) {
    if (entry.plan.slotPolicy === "alias") continue;
    if (entry.contract.kind === "callable") {
      const key = irCallableBindingKey(entry.contract.ref.binding);
      if (calls.has(key)) invalid(`program ABI duplicates callable reference ${key}`);
      calls.set(key, entry);
      declaredSignatures.set(irBindingKey(entry.contract.ref.binding)!, {
        params: entry.contract.params,
        result: entry.contract.results[0] ?? null,
      });
    } else if (entry.contract.kind === "global") {
      const key = irGlobalBindingKey(entry.contract.ref.binding);
      if (globals.has(key)) invalid(`program ABI duplicates global reference ${key}`);
      globals.set(key, entry);
      declaredGlobals.set(irBindingKey(entry.contract.ref.binding)!, entry.contract.type);
    }
  }
  const bodies = [
    ...[...functions.values()].map((fn) => ({ fn, own: entries.get(irUnitCallableBindingId(fn.unitId)) })),
    ...(program.runtimeSupport?.batches ?? []).map((batch) => ({
      fn: batch.implementation.body,
      own: calls.get(irCallableBindingKey(batch.implementation.declaration.ref.binding)),
    })),
  ];
  for (const { fn, own } of bodies) {
    if (
      own?.contract.kind !== "callable" ||
      !sameSignature(
        preparedIrCallableSignature(own.contract.params, own.contract.results),
        preparedIrCallableSignature(
          fn.params.map((param) => param.type),
          preparedIrProgramCallableResults(fn),
        ),
      )
    )
      invalid(`body ${fn.unitId} lacks its exact declared ABI`);
    if (
      (fn.asyncPlan === undefined) !== (own.contract.promise === undefined) ||
      (fn.asyncPlan && preparedIrDataKey(fn.asyncPlan.abi) !== preparedIrDataKey(own.contract.promise))
    )
      invalid(`body ${fn.unitId} has a contradictory Promise contract`);
    const buffers = [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of buffers)
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call" && !calls.has(irCallableBindingKey(instruction.target.binding)))
            invalid(
              `body ${fn.unitId} calls an undeclared callable ${irCallableBindingKey(instruction.target.binding)}`,
            );
          if (instruction.kind === "closure.new" && !calls.has(irCallableBindingKey(instruction.liftedFunc.binding)))
            invalid(`body ${fn.unitId} captures an undeclared callable`);
          if (
            (instruction.kind === "global.get" || instruction.kind === "global.set") &&
            !globals.has(irGlobalBindingKey(instruction.target.binding))
          )
            invalid(`body ${fn.unitId} references undeclared global ${instruction.target.binding.bindingId}`);
        });
    const errors = verifyIrFunction(fn, undefined, { declaredSignatures, declaredGlobals }, options);
    if (errors.length) invalid(`body ${fn.unitId}: ${errors.map((error) => error.message).join("; ")}`);
  }
  if (program.startup.length !== program.inventory.sources.length) invalid("startup omits or duplicates a source");
  for (const [index, plan] of program.startup.entries()) {
    const source = program.inventory.sources[index]!;
    if (plan.sourceId !== source.id) invalid("startup contradicts canonical dependency order");
    const original = program.inventory.terminalUnits.filter(
      (unit) => unit.sourceId === source.id && unit.kind === "module-init",
    );
    if (plan.executable && (original.length !== 1 || plan.unitId !== original[0]!.id || !functions.has(plan.unitId)))
      invalid(`startup source ${source.id} lacks its one exact typed body`);
    if (!plan.executable && (plan.unitId !== null || original.length !== 0))
      invalid(`empty startup source ${source.id} claims an executable body`);
    if (plan.gaps.length) invalid(`startup source ${source.id} retains unresolved binding/export gaps`);
    for (const binding of plan.bindings)
      for (const id of [binding.globalBindingId, binding.tdzBindingId])
        if (id !== null && entries.get(id)?.contract.kind !== "global")
          invalid(`startup source ${source.id} lacks declared storage ${id}`);
  }
  if (program.runtime.length === 0) invalid("program lacks an explicit runtime projection");
  const projections = new Set<string>();
  for (const projection of program.runtime) {
    if (program.runtimeSupport !== undefined && (projection.backend !== "wasmgc" || projection.target !== "standalone"))
      invalid("formatter runtime support requires a wasmgc:standalone projection");
    const key = `${projection.backend}:${projection.target}`;
    if (projections.has(key)) invalid(`program duplicates runtime projection ${key}`);
    projections.add(key);
    const runtime = projection.prepared;
    if (runtime.manifest.policy.backend !== projection.backend || runtime.manifest.policy.target !== projection.target)
      invalid(`runtime projection ${key} contradicts its frozen policy`);
    assertPreparedIrProgramPopulation({
      inventory: program.inventory,
      derivedUnits: program.derivedUnits,
      ir: { functions: runtime.functions },
    });
    assertPreparedIrRuntimeProjection(program, projection);
  }
}

type SourceMapInput = Pick<TypedIrProgramInput, "inventory" | "ir" | "derivedUnits" | "startup" | "sourceMap">;

function sourceMapInvalid(detail: string): never {
  return invalid(`source map: ${detail}`);
}

function sourceMapFields(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) sourceMapInvalid("expected a data record");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) sourceMapInvalid("expected a plain data record");
  const keys = Reflect.ownKeys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
  )
    sourceMapInvalid("missing or unknown record field");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || descriptor.value === undefined)
      sourceMapInvalid("absent fields must be omitted, not undefined or accessors");
  }
}

function sourceMapArray(value: unknown): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    sourceMapInvalid("expected a plain array with the standard prototype");
  if (Reflect.ownKeys(value).length !== value.length + 1)
    sourceMapInvalid("expected a dense array without extra fields");
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor) sourceMapInvalid("missing array entry");
    if (!("value" in descriptor)) sourceMapInvalid("array entries must be data, not accessors");
  }
}

function sourceMapSpan(span: IrSourceMapSpan, length: number): void {
  sourceMapFields(span, ["start", "end"]);
  if (
    !Number.isSafeInteger(span.start) ||
    !Number.isSafeInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start ||
    span.end > length
  )
    sourceMapInvalid("span lies outside its actual text");
}

function assertSourceMapProjection(projection: IrSourceMapTextProjection): void {
  sourceMapFields(projection, ["originalText", "analyzedText", "stages"]);
  if (typeof projection.originalText !== "string" || typeof projection.analyzedText !== "string")
    sourceMapInvalid("text must be primitive strings");
  sourceMapArray(projection.stages);
  let text = projection.originalText;
  for (const stage of projection.stages) {
    sourceMapFields(stage, ["producer", "inputText", "outputText", "edits"]);
    if (
      ![
        "define",
        "stdin-prelude",
        "iterator-prelude",
        "listformat-prelude",
        "cjs-rewrite",
        "eval-super-rewrite",
        "imports",
      ].includes(stage.producer) ||
      stage.inputText !== text ||
      typeof stage.outputText !== "string"
    )
      sourceMapInvalid("text stages contradict their producer or ordered input");
    sourceMapArray(stage.edits);
    let cursor = 0;
    let output = "";
    for (const edit of stage.edits) {
      sourceMapFields(edit, ["input", "removed", "inserted", "kind"]);
      sourceMapSpan(edit.input, text.length);
      if (
        edit.input.start < cursor ||
        typeof edit.removed !== "string" ||
        typeof edit.inserted !== "string" ||
        edit.removed !== text.slice(edit.input.start, edit.input.end) ||
        edit.removed === edit.inserted
      )
        sourceMapInvalid("text edit overlaps, is a no-op, or contradicts actual removed text");
      if (edit.kind !== (edit.input.start === edit.input.end ? "generated-insertion" : "replacement"))
        sourceMapInvalid("edit kind contradicts its actual input extent");
      output += text.slice(cursor, edit.input.start) + edit.inserted;
      cursor = edit.input.end;
    }
    output += text.slice(cursor);
    if (output !== stage.outputText) sourceMapInvalid("text-stage replay differs from output");
    text = output;
  }
  if (text !== projection.analyzedText) sourceMapInvalid("ordered stages do not reach analyzed text");
}

/** Reverse an authenticated stage, preserving causal replacement spans. */
function sourceMapReverseSpan(
  span: IrSourceMapSpan,
  stage: IrSourceMapTextStage,
): { span: IrSourceMapSpan; rewritten: boolean } {
  let delta = 0;
  let rewritten = false;
  let start: number | undefined;
  let end: number | undefined;
  for (const edit of stage.edits) {
    const lo = edit.input.start + delta;
    const hi = lo + edit.inserted.length;
    const intersects = span.start < hi && span.end > lo;
    if (intersects && edit.kind === "generated-insertion")
      sourceMapInvalid("source point refers to generated inserted text");
    if (intersects) rewritten = true;
    if (start === undefined && span.start < hi) start = span.start < lo ? span.start - delta : edit.input.start;
    if (end === undefined && span.end <= hi) end = span.end <= lo ? span.end - delta : edit.input.end;
    delta += edit.inserted.length - (edit.input.end - edit.input.start);
  }
  return { span: { start: start ?? span.start - delta, end: end ?? span.end - delta }, rewritten };
}

function sourceMapStartupRange(row: { readonly start: number; readonly end: number }, length: number): IrSourceMapSpan {
  const span = { start: row.start, end: row.end };
  sourceMapSpan(span, length);
  if (span.start === span.end) sourceMapInvalid("startup occurrence must be nonempty");
  return span;
}

function sourceMapStartupBindings(plan: IrModuleInitPlan, length: number): readonly IrModuleInitBindingIntent[] {
  sourceMapArray(plan.bindings);
  let end = 0;
  const ids = new Set<string>();
  for (const [index, binding] of plan.bindings.entries()) {
    sourceMapFields(binding, [
      "declarationOrdinal",
      "names",
      "declarationKind",
      "mutable",
      "initialization",
      "globalBindingId",
      "tdzBindingId",
      "start",
      "end",
    ]);
    const span = sourceMapStartupRange(binding, length);
    sourceMapArray(binding.names);
    if (
      binding.declarationOrdinal !== index ||
      span.start < end ||
      !["var", "let", "const"].includes(binding.declarationKind) ||
      binding.mutable !== (binding.declarationKind !== "const") ||
      binding.initialization !== (binding.declarationKind === "var" ? "undefined-at-instantiation" : "tdz") ||
      binding.names.length !== 1 ||
      typeof binding.names[0] !== "string" ||
      !binding.names[0] ||
      typeof binding.globalBindingId !== "string" ||
      !binding.globalBindingId ||
      ids.has(binding.globalBindingId) ||
      (binding.declarationKind === "var"
        ? binding.tdzBindingId !== null
        : typeof binding.tdzBindingId !== "string" || !binding.tdzBindingId)
    )
      sourceMapInvalid("startup binding contradicts its declared occurrence");
    ids.add(binding.globalBindingId);
    end = span.end;
  }
  return plan.bindings;
}

function sourceMapStartupEvaluations(
  plan: IrModuleInitPlan,
  length: number,
  bindings: readonly IrModuleInitBindingIntent[],
): readonly IrSourceMapSpan[] {
  sourceMapArray(plan.evaluations);
  const ranges: IrSourceMapSpan[] = [];
  let statement = -1;
  let eligibleStatement = -1;
  let eligibleEnd = 0;
  for (const [index, row] of plan.evaluations.entries()) {
    sourceMapFields(row, [
      "key",
      "kind",
      "sourceOrdinal",
      "statementOrdinal",
      "nestedOrdinal",
      "start",
      "end",
      "classId",
      "bindingIds",
      "legacyKey",
    ]);
    const span = sourceMapStartupRange(row, length);
    sourceMapArray(row.bindingIds);
    if (
      row.sourceOrdinal !== index ||
      row.key !== `${plan.sourceId}:eval:${index}` ||
      !Number.isSafeInteger(row.statementOrdinal) ||
      row.statementOrdinal < 0 ||
      row.statementOrdinal < statement ||
      !Number.isSafeInteger(row.nestedOrdinal) ||
      row.nestedOrdinal < 0 ||
      !["statement", "variable-initializer", "export-assignment", "class-static-field", "class-static-block"].includes(
        row.kind,
      ) ||
      (row.classId !== null && (typeof row.classId !== "string" || !row.classId)) ||
      typeof row.legacyKey !== "string" ||
      row.bindingIds.some((id) => typeof id !== "string" || !id) ||
      new Set(row.bindingIds).size !== row.bindingIds.length
    )
      sourceMapInvalid("startup evaluation contradicts its declared occurrence");
    statement = row.statementOrdinal;
    if (row.kind !== "statement" && row.kind !== "variable-initializer") continue;
    if (
      row.nestedOrdinal !== 0 ||
      row.classId !== null ||
      row.legacyKey !== `statement:${span.start}:${span.end}` ||
      row.statementOrdinal <= eligibleStatement ||
      span.start < eligibleEnd
    )
      sourceMapInvalid("startup statement lacks its exact ordered occurrence");
    const expected =
      row.kind === "statement"
        ? []
        : bindings
            .filter((binding) => binding.start >= span.start && binding.end <= span.end)
            .map((binding) => binding.globalBindingId);
    if (
      (row.kind === "variable-initializer" && expected.length === 0) ||
      preparedIrDataMismatch(expected, row.bindingIds) !== undefined
    )
      sourceMapInvalid("startup statement binding IDs contradict contained declarations");
    eligibleStatement = row.statementOrdinal;
    eligibleEnd = span.end;
    ranges.push(span);
  }
  return ranges;
}

function sourceMapStartupOccurrences(
  point: IrSourceMapPoint,
  input: SourceMapInput,
  length: number,
  joins: SourceMapDonorJoins,
): readonly IrSourceMapSpan[] {
  const key = JSON.stringify([point.sourceId, point.donorUnitId]);
  const cached = joins.startupOccurrences.get(key);
  if (cached) return cached;
  const originals = input.inventory.terminalUnits.filter(
    (unit) => unit.id === point.donorUnitId && unit.sourceId === point.sourceId && unit.kind === "module-init",
  );
  if (
    originals.length !== 1 ||
    input.derivedUnits.some((unit) => unit.id === point.donorUnitId) ||
    input.ir.functions.filter((fn) => fn.unitId === point.donorUnitId).length !== 1
  )
    sourceMapInvalid("startup point lacks its one original module-init body");
  sourceMapArray(input.startup);
  const candidates: IrModuleInitPlan[] = [];
  for (const plan of input.startup) {
    sourceMapFields(plan, [
      "sourceId",
      "unitId",
      "executable",
      "bindings",
      "liveSeeds",
      "evaluations",
      "exports",
      "invocation",
      "gaps",
    ]);
    if (plan.sourceId === point.sourceId || plan.unitId === point.donorUnitId) candidates.push(plan);
  }
  if (candidates.length !== 1) sourceMapInvalid("startup point lacks its unique source/unit plan");
  const plan = candidates[0]!;
  sourceMapArray(plan.gaps);
  if (
    plan.sourceId !== point.sourceId ||
    plan.unitId !== point.donorUnitId ||
    plan.executable !== true ||
    plan.gaps.length
  )
    sourceMapInvalid("startup point contradicts its executable source/unit plan");
  const bindings = sourceMapStartupBindings(plan, length);
  const evaluations = sourceMapStartupEvaluations(plan, length, bindings);
  const ranges = [...bindings.map((binding) => ({ start: binding.start, end: binding.end })), ...evaluations];
  joins.startupOccurrences.set(key, ranges);
  return ranges;
}

function sourceMapPoint(point: IrSourceMapPoint, input: SourceMapInput, joins: SourceMapDonorJoins): void {
  sourceMapFields(point, ["sourceId", "donorUnitId", "analyzed", "original", "mapping"]);
  if (
    typeof point.sourceId !== "string" ||
    !point.sourceId ||
    typeof point.donorUnitId !== "string" ||
    !point.donorUnitId
  )
    sourceMapInvalid("point identities must be nonempty primitive strings");
  const sources = input.sourceMap!.sources.filter((source) => source.sourceId === point.sourceId);
  const donors = input.inventory.allUnits.filter(
    (unit) => unit.id === point.donorUnitId && unit.sourceId === point.sourceId,
  );
  if (sources.length !== 1 || donors.length !== 1) sourceMapInvalid("point lacks its unique actual source/donor unit");
  const source = sources[0]!;
  const donor = donors[0]!;
  sourceMapSpan(point.analyzed, source.projection.analyzedText.length);
  sourceMapSpan(point.original, source.projection.originalText.length);
  if (point.analyzed.start < donor.declarationStart || point.analyzed.end > donor.declarationEnd) {
    if (
      donor.kind !== "module-init" ||
      point.analyzed.start === point.analyzed.end ||
      !sourceMapStartupOccurrences(point, input, source.projection.analyzedText.length, joins).some(
        (span) => span.start <= point.analyzed.start && point.analyzed.end <= span.end,
      )
    )
      sourceMapInvalid("point escapes its donor declaration and exact startup occurrences");
  }
  let projected = point.analyzed;
  let rewritten = false;
  for (const stage of [...source.projection.stages].reverse()) {
    const reverse = sourceMapReverseSpan(projected, stage);
    projected = reverse.span;
    rewritten ||= reverse.rewritten;
  }
  if (
    projected.start !== point.original.start ||
    projected.end !== point.original.end ||
    point.mapping !== (rewritten ? "rewrite" : "exact")
  )
    sourceMapInvalid("point contradicts complete text projection");
}

function sourceMapGenerated(
  origin: IrSourceMapGeneratedOrigin,
  input: SourceMapInput,
  ownerUnitId: string,
  joins: SourceMapDonorJoins,
): void {
  const roles = {
    frontend: ["insertion", "implicit-return", "binding-scaffold", "control-scaffold"],
    middleend: ["cfg-scaffold", "representation-scaffold"],
    async: ["state-dispatch", "frame-access", "capability", "continuation"],
    backend: ["control-scaffold", "abi-scaffold"],
    support: ["runtime-body", "runtime-adapter"],
    startup: ["adapter"],
  };
  if (!Object.hasOwn(roles, origin.phase) || !roles[origin.phase].includes(origin.role))
    sourceMapInvalid("unknown generated phase/role");
  if (origin.phase === "support") {
    sourceMapFields(origin, ["kind", "phase", "role", "bindingId"]);
    sourceMapInvalid("source IR cannot claim an unjoined physical support binding");
  }
  if (origin.phase === "startup") {
    sourceMapFields(origin, ["kind", "phase", "role", "sourceIds"]);
    sourceMapArray(origin.sourceIds);
    const actual = input.startup.filter((plan) => plan.unitId === ownerUnitId).map((plan) => plan.sourceId);
    if (!actual.length || preparedIrDataMismatch(actual, origin.sourceIds) !== undefined)
      sourceMapInvalid("startup origin contradicts actual ordered contributors");
    return;
  }
  sourceMapFields(origin, ["kind", "phase", "role", "ownerUnitId"], ["cause"]);
  const original = input.inventory.allUnits.filter((unit) => unit.id === origin.ownerUnitId);
  const derived = input.derivedUnits.filter((unit) => unit.id === origin.ownerUnitId);
  if (origin.ownerUnitId !== ownerUnitId || original.length + derived.length !== 1)
    sourceMapInvalid("generated origin lacks its exact current function owner");
  if (origin.phase === "frontend" && origin.role === "insertion" && !original[0]?.syntheticRole)
    sourceMapInvalid("inserted origin lacks a compiler-created unit");
  if (origin.phase === "async" && !input.ir.functions.some((fn) => fn.unitId === ownerUnitId && fn.asyncPlan))
    sourceMapInvalid("async scaffold lacks its owner's actual async plan");
  if (origin.cause !== undefined) {
    sourceMapPoint(origin.cause, input, joins);
    assertSourceMapDonor(input, ownerUnitId, origin.cause.donorUnitId, joins);
  }
}

function assertSourceMapSite(
  site: IrSiteId | undefined,
  input: SourceMapInput,
  ownerUnitId: string,
  joins: SourceMapDonorJoins,
): void {
  if (!site || !Object.hasOwn(site, "origin")) sourceMapInvalid("instruction or exit lacks requested origin coverage");
  sourceMapFields(site, ["origin"], ["line", "column"]);
  sourceMapFields(
    site.origin,
    ["kind"],
    ["point", "inlinedAt", "contributors", "phase", "role", "ownerUnitId", "cause", "bindingId", "sourceIds"],
  );
  if (site.origin?.kind === "source") {
    sourceMapFields(site, ["line", "column", "origin"]);
    sourceMapFields(site.origin, ["kind", "point"], ["inlinedAt", "contributors"]);
    for (const chain of [site.origin.inlinedAt, site.origin.contributors])
      if (chain !== undefined) sourceMapArray(chain);
    sourceMapPoint(site.origin.point, input, joins);
    const sourceId = site.origin.point.sourceId;
    const source = input.sourceMap!.sources.find((row) => row.sourceId === sourceId)!;
    const prefix = source.projection.analyzedText.slice(0, site.origin.point.analyzed.start);
    const lines = prefix.split(/\r\n|\r|\n|\u2028|\u2029/);
    if (site.line !== lines.length || site.column !== lines.at(-1)!.length)
      sourceMapInvalid("diagnostic coordinates contradict analyzed start");
    const outerDonor = site.origin.inlinedAt?.at(-1)?.donorUnitId ?? site.origin.point.donorUnitId;
    assertSourceMapDonor(input, ownerUnitId, outerDonor, joins);
    if (site.origin.inlinedAt) {
      const donors = [site.origin.point.donorUnitId, ...site.origin.inlinedAt.map((point) => point.donorUnitId)];
      if (new Set(donors).size !== donors.length) sourceMapInvalid("inlined call chain is cyclic");
    }
    const primary = preparedIrDataKey(site.origin.point);
    for (const chain of [site.origin.inlinedAt, site.origin.contributors]) {
      if (chain === undefined) continue;
      sourceMapArray(chain);
      if (!chain.length) sourceMapInvalid("empty optional point chain must be omitted");
      const seen = new Set([primary]);
      for (const point of chain) {
        sourceMapPoint(point, input, joins);
        const key = preparedIrDataKey(point);
        if (seen.has(key)) sourceMapInvalid("point chain repeats a causal frame");
        seen.add(key);
      }
    }
  } else if (site.origin?.kind === "generated") {
    sourceMapFields(site, ["origin"]);
    sourceMapGenerated(site.origin, input, ownerUnitId, joins);
  } else sourceMapInvalid("unknown site origin variant");
}

function walkSourceMapInstructions(
  instrs: readonly IrInstr[],
  input: SourceMapInput,
  ownerUnitId: string,
  joins: SourceMapDonorJoins,
  active: Set<IrInstr> = new Set(),
): void {
  sourceMapArray(instrs);
  for (const instr of instrs) {
    if (active.has(instr)) sourceMapInvalid("cyclic nested instruction graph");
    active.add(instr);
    try {
      assertSourceMapSite(instr.site, input, ownerUnitId, joins);
      forEachNestedBuffer(instr, (nested) => walkSourceMapInstructions(nested, input, ownerUnitId, joins, active));
    } finally {
      active.delete(instr);
    }
  }
}

/** Validate requested data; absent no-map payloads retain the original path. */
export function assertPreparedSourceMap(input: SourceMapInput): void {
  if (!Object.hasOwn(input, "sourceMap")) return;
  const descriptor = Object.getOwnPropertyDescriptor(input, "sourceMap")!;
  if (!("value" in descriptor)) sourceMapInvalid("catalog must be data, not an accessor");
  const map: TypedIrProgramInput["sourceMap"] = descriptor.value;
  sourceMapFields(map, ["schema", "sources"], ["derivedSources"]);
  if (!map || map.schema !== "prepared-ir-source-map-v1") sourceMapInvalid("unknown catalog schema");
  sourceMapArray(map.sources);
  if (map.sources.length !== input.inventory.sources.length)
    sourceMapInvalid("catalog differs from actual source population");
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, source] of map.sources.entries()) {
    sourceMapFields(source, ["sourceId", "sourceKey", "originalFileName", "mapName", "projection"]);
    const actual = input.inventory.sources[index]!;
    if (
      source.sourceId !== actual.id ||
      source.sourceKey !== actual.sourceKey ||
      source.originalFileName !== actual.originalFileName ||
      source.mapName !== actual.sourceKey ||
      typeof source.mapName !== "string" ||
      ids.has(source.sourceId) ||
      names.has(source.mapName)
    )
      sourceMapInvalid("catalog source identity/order/name contradicts inventory");
    ids.add(source.sourceId);
    names.add(source.mapName);
    assertSourceMapProjection(source.projection);
  }
  const joins = assertSourceMapDerivedSources(input);
  for (const fn of input.ir.functions) {
    for (const block of fn.blocks) {
      walkSourceMapInstructions(block.instrs, input, fn.unitId, joins);
      assertSourceMapSite(block.terminator.site, input, fn.unitId, joins);
    }
    for (const state of fn.asyncPlan?.states ?? []) {
      walkSourceMapInstructions(state.body, input, fn.unitId, joins);
      for (const update of state.updates ?? []) assertSourceMapSite(update.site, input, fn.unitId, joins);
      assertSourceMapSite(state.terminator.site, input, fn.unitId, joins);
    }
  }
  if (joins.used.size !== joins.donors.size) sourceMapInvalid("derived source table contains an unused donor grant");
}

interface SourceMapDonorJoins {
  readonly donors: ReadonlyMap<string, string>;
  readonly used: Set<string>;
  readonly startupOccurrences: Map<string, readonly IrSourceMapSpan[]>;
}

function assertSourceMapDerivedSources(input: SourceMapInput): SourceMapDonorJoins {
  const joins: SourceMapDonorJoins = { donors: new Map(), used: new Set(), startupOccurrences: new Map() };
  if (!Object.hasOwn(input.sourceMap!, "derivedSources")) return joins;
  const rows = input.sourceMap!.derivedSources!;
  sourceMapArray(rows);
  if (!rows.length) sourceMapInvalid("empty derived source table must be omitted");
  assertSourceMapAcyclicBodies(input);
  // Reuse semantic identity/parent/body validation; map metadata never replaces it.
  try {
    assertPreparedIrProgramPopulation(input);
  } catch (error) {
    if (!(error instanceof PreparedIrProgramInvariantError)) throw error;
    sourceMapInvalid(`derived source population contradicts ownership: ${error.message}`);
  }
  const donors = new Map<string, string>();
  for (const row of rows) {
    sourceMapFields(row, ["unitId", "donorUnitId"]);
    const derived = input.derivedUnits.filter((record) => record.id === row.unitId);
    const functions = input.ir.functions.filter((fn) => fn.unitId === row.unitId);
    const originals = input.inventory.allUnits.filter((unit) => unit.id === row.donorUnitId);
    if (
      donors.has(row.unitId) ||
      input.inventory.allUnits.some((unit) => unit.id === row.unitId) ||
      derived.length !== 1 ||
      functions.length !== 1 ||
      originals.length !== 1
    )
      sourceMapInvalid("derived source row lacks unique derived function/donor identities");
    const record = derived[0]!;
    const donor = originals[0]!;
    if (
      record.role !== "lifted-closure" ||
      !["arrow-function", "function-expression", "object-method", "object-getter", "object-setter"].includes(
        donor.kind,
      ) ||
      record.sourceId !== donor.sourceId ||
      record.terminalOwnerId !== donor.terminalOwnerId
    )
      sourceMapInvalid("derived source row contradicts actual lifting role/source/terminal owner");
    const ancestors = sourceMapOwnerIds(input, row.unitId);
    let lexical = donor.lexicalOwnerId;
    const visited = new Set<string>();
    while (lexical !== null && !ancestors.has(lexical)) {
      if (visited.has(lexical)) sourceMapInvalid("source donor lexical chain is cyclic");
      visited.add(lexical);
      const parents = input.inventory.allUnits.filter(
        (unit) =>
          unit.id === lexical && unit.sourceId === donor.sourceId && unit.terminalOwnerId === donor.terminalOwnerId,
      );
      if (parents.length !== 1) sourceMapInvalid("derived source donor lacks its actual lexical owner");
      lexical = parents[0]!.lexicalOwnerId;
    }
    if (lexical === null) sourceMapInvalid("derived source donor contradicts its actual parent chain");
    donors.set(row.unitId, row.donorUnitId);
  }
  const ordered = input.derivedUnits.filter((record) => donors.has(record.id)).map((record) => record.id);
  if (
    preparedIrDataMismatch(
      ordered,
      rows.map((row) => row.unitId),
    ) !== undefined
  )
    sourceMapInvalid("derived source table contradicts actual derived order");
  return { donors, used: joins.used, startupOccurrences: joins.startupOccurrences };
}

function sourceMapOwnerIds(input: SourceMapInput, ownerUnitId: string): Set<string> {
  const ids = new Set<string>([ownerUnitId]);
  let parent = input.derivedUnits.find((unit) => unit.id === ownerUnitId);
  while (parent) {
    if (ids.has(parent.parentId)) sourceMapInvalid("derived owner chain is cyclic");
    ids.add(parent.parentId);
    const parentId = parent.parentId;
    parent = input.derivedUnits.find((unit) => unit.id === parentId);
  }
  return ids;
}

function assertSourceMapDonor(
  input: SourceMapInput,
  ownerUnitId: string,
  donorUnitId: string,
  joins: SourceMapDonorJoins,
): void {
  const ids = sourceMapOwnerIds(input, ownerUnitId);
  for (const id of ids) {
    if (joins.donors.get(id) === donorUnitId) {
      if (id === ownerUnitId) joins.used.add(id);
      return;
    }
  }
  if (!ids.has(donorUnitId)) sourceMapInvalid("source origin lacks its current or inlined owner chain");
}

/** Population validation uses a recursive walk, so reject cycles before it. */
function assertSourceMapAcyclicBodies(input: SourceMapInput): void {
  const active = new Set<IrInstr>();
  const visit = (instrs: readonly IrInstr[]): void => {
    sourceMapArray(instrs);
    for (const instr of instrs) {
      if (active.has(instr)) sourceMapInvalid("cyclic nested instruction graph");
      active.add(instr);
      try {
        forEachNestedBuffer(instr, visit);
      } finally {
        active.delete(instr);
      }
    }
  };
  for (const fn of input.ir.functions) {
    for (const block of fn.blocks) visit(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) visit(state.body);
  }
}
