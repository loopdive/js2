import {
  collectNativeJsClassErrorDemands,
  nativeJsClassRealmErrorDeclarations,
  TYPE_ERROR_RUNTIME_PROVIDERS,
} from "./native-js-class-error-callables.js";
import { REFERENCE_ERROR_RUNTIME_PROVIDERS, REFERENCE_ERROR_DECLARATION } from "./reference-error-callable.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrModule, type IrInstr, type IrValueId, type IrFunction } from "../core/nodes.js";
import { irSupportRef, type IrType } from "../core/types.js";
import { irTypeKey } from "../core/type-key.js";
import { irSupportTypeRef } from "../core/type-references.js";
import { irTypeBindingKey } from "../core/type-binding-keys.js";
import { irGlobalBindingKey } from "../core/global-binding-keys.js";
import { irRuntimeFuncRef, irCallableBindingKey } from "../core/callable-bindings.js";
import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { IrJsClassBody, IrJsClassDefinition } from "../core/js-class-contracts.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import type { AllocationEvidenceCheck } from "../analysis/allocation-evidence/contracts.js";
import type { NativeJsClassEvidenceDomain } from "../analysis/allocation-evidence/native-js-class-effects.js";
import { inspectNativeJsClassNamespaces } from "../analysis/allocation-evidence/native-js-class-profile.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { verifyIrFunction } from "./verify.js";
import { verifyIrJsClassDefinitionData, verifyIrJsClassInstruction } from "./js-class-verify.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import {
  assertPreparedIrData,
  copyPreparedIrDataObject,
  freezePreparedIrValue,
  preparedIrDataMismatch,
} from "../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-invariant-error.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class canonical evidence: ${detail}`);
}
function unsupported(detail: string): never {
  throw new IrUnsupportedError("class-member-unsupported", "build", `native JS class canonical evidence: ${detail}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("program projection record");
  return value as Record<string, unknown>;
}

/** A bounded semantic signature check. Richer callable populations remain refused. */
function typeKey(type: IrType): string {
  if (type.kind === "support-ref") return irTypeKey(type);
  if (type.kind !== "val" && type.kind !== "dynamic") unsupported("callable/global type outside native class subset");
  if (type.kind === "val" && !["i32", "f64"].includes(type.val.kind)) unsupported("physical numeric/ref type");
  const sorted = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sorted);
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  };
  return `${irTypeKey(type)}:${JSON.stringify(sorted(type))}`;
}

/** Runtime independently binds the captured complete original DATA to these actual bodies. */
function verifyProgramDomain(module: IrModule, domain: NativeJsClassEvidenceDomain): void {
  const data = domain.programData;
  if (!data) invalid("missing complete original program projection");
  assertPreparedIrData(data);
  if (data.phase !== "sealed" || !Array.isArray(data.startup))
    invalid("early source capture is not final canonical evidence");
  const inventory = data.inventory;
  const classes = new Map(inventory.classes.map((row) => [row.id, row]));
  const units = new Map(inventory.allUnits.map((row) => [row.id, row]));
  if (
    classes.size !== inventory.classes.length ||
    units.size !== inventory.allUnits.length ||
    classes.size !== domain.definitions.length
  )
    invalid("complete original class/unit denominator");
  const source = inventory.sources.find((row) => row.kind === "entry");
  if (!source) invalid("missing original entry source");
  const entries = data.abiEntries.map((value) => {
    const entry = record(value),
      plan = record(entry.plan),
      contract = record(entry.contract);
    return { plan, contract };
  });
  const abi = new Map(entries.map((entry) => [entry.plan.id, entry]));
  if (abi.size !== entries.length) invalid("duplicate complete ABI binding");
  const definitionEntries = entries.filter(
    ({ contract }) => contract.kind === "support" && contract.role === "native-js-class-definition-v1",
  );
  if (definitionEntries.length !== domain.definitions.length) invalid("complete definition ABI denominator");
  const functions = new Map(module.functions.map((fn) => [fn.unitId, fn]));
  const bodies = new Set<string>(),
    originals = new Set<string>();
  for (const { id, definition } of domain.definitions) {
    const original = classes.get(definition.sourceClassId);
    if (
      !original ||
      originals.has(original.id) ||
      original.syntheticRole !== undefined ||
      original.sourceId !== definition.sourceId ||
      original.declarationKind !== definition.form ||
      original.declarationStart !== definition.span.start ||
      original.declarationEnd !== definition.span.end
    )
      invalid("original ClassId/source span/form");
    originals.add(original.id);
    const owner = units.get(definition.evaluationOwnerUnitId);
    if (!owner?.terminal || owner.sourceId !== original.sourceId) invalid("definition original evaluation owner");
    const support = abi.get(id);
    if (
      !support ||
      support.plan.slotPolicy !== "none" ||
      record(support.plan.intent).kind !== "support" ||
      record(support.plan.intent).role !== "native-js-class-definition-v1" ||
      support.contract.kind !== "support" ||
      support.contract.role !== "native-js-class-definition-v1" ||
      preparedIrDataMismatch(support.contract.nativeJsClassDefinition, definition) !== undefined
    )
      invalid("canonical definition ABI attachment");
    for (const [role, ref] of Object.entries(definition.roles)) {
      const canonical = irSupportTypeRef(source.id, `native-js-class-role:${role}`, `native_js_class_${role}`);
      if (preparedIrDataMismatch(ref.binding, canonical.binding) !== undefined) invalid("foreign class role identity");
      const entry = abi.get(ref.binding.bindingId),
        type = irSupportRef(ref, false);
      if (
        !entry ||
        entry.plan.slotPolicy !== "none" ||
        Object.hasOwn(entry.plan, "slotSpace") ||
        Object.hasOwn(entry.plan, "aliasOf") ||
        entry.plan.structuralReferenceKey !== irTypeBindingKey(ref.binding) ||
        record(entry.plan.intent).kind !== "type" ||
        record(entry.plan.intent).shapeKey !== typeKey(type) ||
        entry.contract.kind !== "type" ||
        preparedIrDataMismatch(entry.contract.ref, ref) !== undefined ||
        preparedIrDataMismatch(entry.contract.type, type) !== undefined
      )
        invalid("actual managed logical type ABI");
    }
    if (
      definition.constructor.sourceBodyKind !== "constructor" ||
      units.get(definition.constructor.unitId)?.kind !==
        (definition.implicitConstructor ? "class-implicit-constructor" : "class-constructor")
    )
      invalid("original implicit/explicit constructor kind");
    for (const member of definition.members)
      if (
        member.body.sourceBodyKind !== "method" ||
        units.get(member.body.unitId)?.kind !== (member.static ? "class-static-method" : "class-instance-method")
      )
        invalid("original method static/instance kind");
    for (const element of definition.instanceElements)
      if (element.initializer && element.initializer.sourceBodyKind !== "field-initializer")
        invalid("original field initializer kind");
    const owned = [
      definition.constructor,
      ...definition.members.map((member) => member.body),
      ...definition.instanceElements.flatMap((element) => (element.initializer ? [element.initializer] : [])),
    ];
    for (const body of owned) {
      const unit = units.get(body.unitId);
      const kinds =
        body.sourceBodyKind === "constructor"
          ? ["class-constructor", "class-implicit-constructor"]
          : body.sourceBodyKind === "method"
            ? ["class-instance-method", "class-static-method"]
            : body.sourceBodyKind === "field-initializer"
              ? ["class-instance-field-initializer"]
              : ["class-static-field-initializer", "class-static-block"];
      if (
        !unit ||
        bodies.has(unit.id) ||
        unit.syntheticRole !== undefined ||
        !kinds.includes(unit.kind) ||
        unit.sourceId !== original.sourceId ||
        unit.lexicalOwnerId !== original.id ||
        body.lexicalOwnerId !== unit.lexicalOwnerId ||
        body.terminalOwnerId !== unit.terminalOwnerId ||
        body.ordinal !== unit.ordinal ||
        body.span.start !== unit.declarationStart ||
        body.span.end !== unit.declarationEnd
      )
        invalid("original body provenance population");
      bodies.add(unit.id);
      const fn = functions.get(unit.id);
      if (!fn) invalid("original callable missing");
      const callable = entries.filter(
        ({ contract }) =>
          contract.kind === "callable" && preparedIrDataMismatch(contract.ref, body.target) === undefined,
      );
      if (callable.length !== 1) invalid("actual class-body callable denominator");
      const entry = callable[0]!,
        params = [
          body.frame.environmentType,
          body.frame.thisType,
          body.frame.homeObjectType,
          body.frame.newTargetType,
          ...body.params,
        ],
        results = body.result === null ? [] : [body.result];
      const intent = record(entry.plan.intent);
      if (
        entry.plan.slotPolicy !== "required" ||
        entry.plan.slotSpace !== "function" ||
        entry.plan.structuralReferenceKey !== irCallableBindingKey(body.target.binding) ||
        intent.kind !== "callable" ||
        intent.unitId !== body.unitId ||
        preparedIrDataMismatch(intent.signature, {
          params: params.map(typeKey),
          results: results.map(typeKey),
        }) !== undefined ||
        preparedIrDataMismatch(entry.contract.params, params) !== undefined ||
        preparedIrDataMismatch(entry.contract.results, results) !== undefined
      )
        invalid("actual original callable/hidden signature ABI");
    }
    for (const [name, semantic, type] of [
      ["objectPrototype", "Object.prototype", irSupportRef(definition.roles.prototype, false)],
      ["functionPrototype", "Function.prototype", irSupportRef(definition.roles.method, false)],
      ["referenceError", "ReferenceError", irSupportRef(definition.roles.constructor, false)],
      ["typeError", "TypeError", irSupportRef(definition.roles.constructor, false)],
    ] as const) {
      const binding = {
        kind: "support" as const,
        bindingId: createIrBindingId({
          ownerId: source.id,
          domain: "global",
          role: `native-js-class-realm:${semantic}`,
        }),
      };
      const entry = abi.get(binding.bindingId);
      if (definition.realm[name] !== binding.bindingId || !entry) invalid("canonical realm global identity/census");
      const intent = record(entry.plan.intent),
        ref = record(entry.contract.ref);
      if (
        entry.plan.slotPolicy !== "required" ||
        entry.plan.slotSpace !== "global" ||
        entry.plan.structuralReferenceKey !== irGlobalBindingKey(binding) ||
        intent.kind !== "global" ||
        intent.origin !== "support" ||
        intent.mutable !== false ||
        intent.valueType !== typeKey(type) ||
        entry.contract.kind !== "global" ||
        entry.contract.mutable !== false ||
        ref.kind !== "global" ||
        preparedIrDataMismatch(ref.binding, binding) !== undefined ||
        preparedIrDataMismatch(entry.contract.type, type) !== undefined
      )
        invalid("actual immutable realm global ABI");
    }
    for (const binding of [definition.outerBinding, definition.innerBinding]) {
      if (!binding || binding.storage !== "module") continue;
      for (const [ref, type] of [
        [binding.valueGlobal, binding.valueType],
        [binding.tdzGlobal, { kind: "val", val: { kind: "i32" } }],
      ] as const) {
        if (!ref) invalid("missing actual binding/TDZ globals");
        const entry = abi.get(ref.binding.bindingId);
        if (
          !entry ||
          entry.plan.slotPolicy !== "required" ||
          entry.plan.slotSpace !== "global" ||
          entry.plan.structuralReferenceKey !== irGlobalBindingKey(ref.binding) ||
          record(entry.plan.intent).kind !== "global" ||
          record(entry.plan.intent).valueType !== typeKey(type) ||
          record(entry.plan.intent).mutable !== true ||
          entry.contract.kind !== "global" ||
          entry.contract.mutable !== true ||
          preparedIrDataMismatch(entry.contract.ref, ref) !== undefined ||
          preparedIrDataMismatch(entry.contract.type, type) !== undefined
        )
          invalid("actual binding/TDZ global ABI");
      }
    }
  }
  for (const unit of inventory.allUnits)
    if (
      unit.lexicalOwnerId !== null &&
      originals.has(unit.lexicalOwnerId) &&
      unit.kind.startsWith("class-") &&
      !bodies.has(unit.id)
    )
      invalid("omitted original class body");
  const observed = new Set<string>();
  for (const input of data.startup) {
    const plan = record(input);
    if (!Object.hasOwn(plan, "jsClassStartup")) continue;
    const startup = record(plan.jsClassStartup);
    if (
      Object.keys(startup).length !== 2 ||
      startup.schema !== "native-js-class-startup-v1" ||
      !Array.isArray(startup.definitions)
    )
      invalid("canonical startup DATA");
    let ordinal = -1,
      start = -1;
    for (const value of startup.definitions) {
      const row = record(value),
        span = record(row.span),
        entry = domain.definitions.find((item) => item.id === row.definitionId);
      if (
        Object.keys(row).length !== 4 ||
        Object.keys(span).length !== 2 ||
        !entry ||
        observed.has(entry.id) ||
        entry.definition.sourceClassId !== row.sourceClassId ||
        entry.definition.sourceId !== plan.sourceId ||
        entry.definition.evaluationOwnerUnitId !== plan.unitId ||
        preparedIrDataMismatch(entry.definition.span, span) !== undefined ||
        !Number.isSafeInteger(row.statementOrdinal) ||
        (row.statementOrdinal as number) < ordinal ||
        ((row.statementOrdinal as number) === ordinal && (span.start as number) <= start)
      )
        invalid("actual original startup definition order/source/span");
      ordinal = row.statementOrdinal as number;
      start = span.start as number;
      observed.add(entry.id);
    }
  }
  for (const { id, definition } of domain.definitions)
    if (data.startup.some((plan) => record(plan).unitId === definition.evaluationOwnerUnitId) && !observed.has(id))
      invalid("module definition absent from finalized startup");
}

function normalizedErrorProvider(value: unknown): unknown {
  const row = record(value);
  return {
    ...row,
    ...Object.fromEntries(
      ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"].map((key) => {
        const items = row[key];
        if (
          !Array.isArray(items) ||
          items.some((item) => typeof item !== "string") ||
          new Set(items).size !== items.length
        )
          invalid("error provider list DATA");
        return [key, [...items].sort()];
      }),
    ),
  };
}

/** Actual implicit operations and realm roots select canonical declarations, not inserted calls. */
function verifyNativeJsClassErrorProgramData(module: IrModule, domain: NativeJsClassEvidenceDomain): void {
  const data = domain.programData!;
  const source = data.inventory.sources.find((row) => row.kind === "entry");
  if (!source) invalid("error ABI has no original source anchor");
  const declarations = new Map(
    nativeJsClassRealmErrorDeclarations(module.functions).map((declaration) => [declaration.feature, declaration]),
  );
  for (const demand of collectNativeJsClassErrorDemands(module.functions))
    declarations.set(demand.declaration.feature, demand.declaration);
  for (const declaration of declarations.values()) {
    const key = irCallableBindingKey(declaration.ref.binding);
    const id = createIrBindingId({ ownerId: source.id, domain: "callable", role: key });
    const entries = data.abiEntries.map(record).filter((entry) => record(entry.plan).id === id);
    if (entries.length !== 1) invalid("implicit error callable ABI census");
    const entry = entries[0]!,
      plan = record(entry.plan),
      contract = record(entry.contract),
      intent = record(plan.intent);
    const externalKey = 'externref:{"kind":"val","val":{"kind":"externref"}}';
    if (
      plan.slotPolicy !== "required" ||
      plan.slotSpace !== "function" ||
      plan.structuralReferenceKey !== key ||
      intent.kind !== "callable" ||
      intent.origin !== "runtime" ||
      preparedIrDataMismatch(
        intent.signature,
        copyPreparedIrDataObject({ params: [externalKey], results: [externalKey] }),
      ) !== undefined ||
      contract.kind !== "callable" ||
      preparedIrDataMismatch(contract.ref, declaration.ref) !== undefined ||
      preparedIrDataMismatch(contract.params, declaration.params) !== undefined ||
      preparedIrDataMismatch(contract.results, declaration.results) !== undefined
    )
      invalid("canonical implicit error callable signature/binding");
  }
  for (const view of data.runtimeManifests ?? []) {
    const manifest = record(view.manifest),
      policy = record(manifest.policy);
    if (
      policy.backend !== view.backend ||
      policy.target !== view.target ||
      !["wasmgc", "linear"].includes(view.backend) ||
      !["standalone", "wasi"].includes(view.target)
    )
      invalid("implicit class error provider requires the actual native policy");
    if (!Array.isArray(manifest.features) || !Array.isArray(manifest.providers)) invalid("class error manifest census");
    for (const declaration of declarations.values()) {
      const canonical =
        declaration.feature === "error.type.construct"
          ? TYPE_ERROR_RUNTIME_PROVIDERS[0]!
          : REFERENCE_ERROR_RUNTIME_PROVIDERS.find((row) => row.id === "native.error.reference.construct")!;
      const providers = manifest.providers.filter((value) => record(value).feature === declaration.feature);
      if (
        manifest.features.filter((value) => value === declaration.feature).length !== 1 ||
        providers.length !== 1 ||
        preparedIrDataMismatch(normalizedErrorProvider(providers[0]), normalizedErrorProvider(canonical)) !== undefined
      )
        invalid("actual implicit error provider descriptor/demand differs");
    }
  }
}

/** Exact semantic declarations, not permission from a global name or opcode. */
function createExpectedOperationOperands() {
  const externType = { kind: "val", val: { kind: "externref" } };
  const expected = {
    referenceTarget: REFERENCE_ERROR_DECLARATION.ref,
    externType,
    referenceParams: REFERENCE_ERROR_DECLARATION.params,
    referenceResults: REFERENCE_ERROR_DECLARATION.results,
    referenceSignature: {
      params: [`externref:${JSON.stringify(externType)}`],
      results: [`externref:${JSON.stringify(externType)}`],
    },
  };
  return freezePreparedIrValue(expected) as typeof expected;
}
type ExpectedOperationOperands = ReturnType<typeof createExpectedOperationOperands>;
function verifyGlobalAndTdzOperation(
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
      verifyGlobalAndTdzOperation(producer, types, definitions, domain, expected);
      return true;
    }
    if (producer?.kind !== "call" || preparedIrDataMismatch(producer.target, expected.referenceTarget) !== undefined)
      unsupported("noncanonical error throw transport");
    verifyGlobalAndTdzOperation(producer, types, definitions, domain, expected);
    return true;
  }
  return false;
}
/** Complete canonical operand/body replay, separate from immutable program-domain joins. */
function verifyNativeJsClassInstructions(
  module: IrModule,
  definitions: ReadonlyMap<IrBindingId, IrJsClassDefinition>,
  bodies: ReadonlyMap<string, { readonly definition: string; readonly body: IrJsClassBody }>,
  bindingTypes: ReadonlyMap<
    string,
    { readonly type: IrType; readonly storage: "module" | "cell" | "value"; readonly innerOwned: boolean }
  >,
  functions: ReadonlyMap<string, IrFunction>,
  domain: NativeJsClassEvidenceDomain,
): void {
  const expected = createExpectedOperationOperands();
  const defined = new Map<string, number>();
  for (const fn of module.functions) {
    const types = new Map<IrValueId, IrType>(fn.params.map((parameter) => [parameter.value, parameter.type]));
    const actualDefinitions = new Map<IrValueId, IrInstr>();
    for (const block of fn.blocks) {
      for (const [index, value] of block.blockArgs.entries()) types.set(value, block.blockArgTypes[index]!);
      for (const instruction of block.instrs)
        forEachInstrDeep(instruction, (item) => {
          if (item.result !== null && item.resultType !== null) {
            types.set(item.result, item.resultType);
            actualDefinitions.set(item.result, item);
          }
        });
    }
    for (const block of fn.blocks)
      for (const instruction of block.instrs)
        forEachInstrDeep(instruction, (item) => {
          const row = item as unknown as Record<string, unknown>;
          verifyGlobalAndTdzOperation(item, types, actualDefinitions, domain, expected);
          if (item.kind === "const") {
            if (item.resultType?.kind === "dynamic") {
              if (item.value.kind !== "undefined" || item.resultType.tag !== JS_TAG_IDS.Undefined)
                unsupported("noncanonical dynamic constant");
            } else if (
              !(
                item.resultType?.kind === "val" &&
                item.resultType.val.kind === "externref" &&
                item.value.kind === "null"
              ) &&
              (item.resultType?.kind !== "val" ||
                !["i32", "f64"].includes(item.resultType.val.kind) ||
                !["i32", "f64", "bool"].includes(item.value.kind))
            )
              unsupported("constant carrier");
          }
          if (item.kind === "box") {
            const payload = types.get(item.value);
            if (
              item.resultType?.kind !== "dynamic" ||
              preparedIrDataMismatch(item.toType, item.resultType) !== undefined
            )
              unsupported("box carrier");
            if (item.resultType.tag === JS_TAG_IDS.NumberF64) {
              if (
                preparedIrDataMismatch(payload, {
                  kind: "val",
                  val: { kind: "f64" },
                }) !== undefined
              )
                unsupported("NumberF64 box payload");
            } else if (item.resultType.tag === JS_TAG_IDS.Boolean) {
              if (
                preparedIrDataMismatch(payload, {
                  kind: "val",
                  val: { kind: "i32", boolean: true },
                }) !== undefined
              )
                unsupported("Boolean box payload");
            } else unsupported("canonical class primitive box partition");
          }
          if (
            item.kind === "js.class.property.get" &&
            (item.resultType?.kind !== "dynamic" || item.resultType.tag !== undefined)
          )
            unsupported("mutable property read requires an unrefined JSValue");
          if (
            (item.kind === "js.class.property.set" || item.kind === "js.class.property.define") &&
            types.get(item.value)?.kind !== "dynamic"
          )
            unsupported("stored property requires an existing immutable JSValue");
          if ((item.kind as string).startsWith("js.class.")) {
            const local = verifyIrJsClassInstruction(item as Extract<IrInstr, { kind: `js.class.${string}` }>, types);
            if (local.length) invalid(local.join("; "));
            if (row.kind === "js.class.define") {
              const descriptor = definitions.get(row.definition as IrBindingId);
              if (!descriptor) invalid("foreign definition operation");
              if (descriptor.evaluationOwnerUnitId !== fn.unitId)
                unsupported("definition moved outside original evaluation owner");
              if (item.kind !== "js.class.define") invalid("definition discriminant");
              if (
                preparedIrDataMismatch(item.resultType, irSupportRef(descriptor.roles.constructor, false)) !== undefined
              )
                invalid("definition constructor role");
              const captures = descriptor.captures.filter((capture) => capture.mode !== "live-global");
              if (item.captures.length !== captures.length) invalid("external capture operand census");
              for (const [index, capture] of captures.entries()) {
                const expected =
                  capture.mode === "live-cell" ? irSupportRef(descriptor.roles["binding-cell"], false) : capture.type;
                if (preparedIrDataMismatch(types.get(item.captures[index]!), expected) !== undefined)
                  invalid("capture referent/cell type");
              }
              defined.set(row.definition as string, (defined.get(row.definition as string) ?? 0) + 1);
            }
            if (item.kind === "js.class.binding.new") {
              const binding = bindingTypes.get(item.binding);
              if (!binding || binding.storage !== "cell" || binding.innerOwned)
                invalid("fresh cell lacks an independent outer/captured binding root");
            }
            if (
              item.kind === "js.class.binding.read" ||
              item.kind === "js.class.binding.write" ||
              item.kind === "js.class.binding.init"
            ) {
              const binding = bindingTypes.get(item.storage.bindingId);
              if (!binding || binding.storage !== item.storage.kind)
                invalid("binding storage has foreign identity/mode");
              if (item.kind === "js.class.binding.read") {
                if (preparedIrDataMismatch(item.resultType, binding.type) !== undefined)
                  invalid("TDZ-checked binding result type");
              } else if (preparedIrDataMismatch(types.get(item.value), binding.type) !== undefined)
                unsupported("binding assignment carrier");
            }
            if (item.kind === "js.class.frame.get") {
              const owner = bodies.get(fn.unitId);
              if (!owner || item.frame !== fn.blocks[0]!.instrs[0]!.result)
                invalid("frame access has foreign activation root");
              const frame = owner.body.frame;
              let expected: IrType;
              switch (item.access.kind) {
                case "this":
                  expected = frame.thisType;
                  break;
                case "environment":
                  expected = frame.environmentType;
                  break;
                case "home-object":
                  expected = frame.homeObjectType;
                  break;
                case "new-target":
                  expected = frame.newTargetType;
                  break;
                case "capture": {
                  if (item.access.definitionId !== owner.definition) invalid("capture has foreign definition");
                  const capture = frame.captures[item.access.index];
                  if (!capture) invalid("capture index");
                  const descriptor = definitions.get(owner.definition as IrBindingId)!;
                  expected =
                    capture.mode === "live-cell" ? irSupportRef(descriptor.roles["binding-cell"], false) : capture.type;
                  break;
                }
              }
              if (preparedIrDataMismatch(item.resultType, expected) !== undefined)
                invalid("frame capture value/cell result type");
            }
            if (row.kind === "js.class.frame.new") {
              const owner = bodies.get(fn.unitId);
              if (!owner || row.definition !== owner.definition) invalid("frame has foreign body/definition owner");
              if (item !== fn.blocks[0]!.instrs[0]) invalid("extra activation frame");
            }
          }
          if (item.kind === "call") {
            const binding = item.target.binding;
            if (!binding) unsupported("foreign call target");
            if (binding.kind !== "unit") {
              verifyGlobalAndTdzOperation(item, types, actualDefinitions, domain, expected);
              return;
            }
            if (bodies.has(binding.unitId)) unsupported("class-owned callable requires its explicit protocol");
            const callee = functions.get(binding.unitId);
            if (!callee || item.args.length !== callee.params.length) invalid("call target/arity");
            for (const [index, argument] of item.args.entries())
              if (preparedIrDataMismatch(types.get(argument), callee.params[index]!.type) !== undefined)
                invalid("call argument type");
            if (
              callee.resultTypes.length > 1 ||
              preparedIrDataMismatch(item.resultType === null ? [] : [item.resultType], callee.resultTypes) !==
                undefined
            )
              invalid("call result type");
          }
        });
  }
  for (const id of definitions.keys()) if (defined.get(id) !== 1) invalid("definition occurrence census");
}

/** Runtime-local canonical conjunction. Reports are fresh observations, never transferable physical authority. */
export function verifyNativeJsClassEvidence(
  module: IrModule,
  registry: AllocRegistrySnapshot,
  domain: NativeJsClassEvidenceDomain | undefined,
): AllocationEvidenceCheck | undefined {
  const neutral = inspectNativeJsClassNamespaces(module, registry, domain);
  if (neutral === undefined || neutral.kind === "invalid") return neutral;
  try {
    if (!domain) invalid("missing domain");
    assertPreparedIrData(domain);
    for (const fn of module.functions) {
      const errors = verifyIrFunction(fn);
      if (errors.length) invalid(errors.map((error) => error.message).join("; "));
    }
    for (const entry of domain.definitions)
      if (verifyIrJsClassDefinitionData(entry.definition).length) invalid("malformed class definition DATA");
    verifyProgramDomain(module, domain);
    verifyNativeJsClassErrorProgramData(module, domain);
    const functions = new Map(module.functions.map((fn) => [fn.unitId, fn]));
    if (functions.size !== module.functions.length) invalid("duplicate units");
    const bodies = new Map<string, { readonly definition: string; readonly body: IrJsClassBody }>();
    const definitions = new Map(domain.definitions.map((entry) => [entry.id, entry.definition]));
    for (const entry of domain.definitions) {
      const descriptor = entry.definition;
      if (verifyIrJsClassDefinitionData(descriptor).length) invalid("malformed class definition DATA");
      if (
        entry.id !==
        createIrBindingId({
          ownerId: descriptor.sourceClassId,
          domain: "support",
          role: "native-js-class-definition-v1",
        })
      )
        invalid("foreign definition binding");
      const owned = [
        descriptor.constructor,
        ...descriptor.members.map((member) => member.body),
        ...descriptor.instanceElements.flatMap((element) => (element.initializer ? [element.initializer] : [])),
      ];
      for (const body of owned) {
        if (bodies.has(body.unitId)) invalid("class body has multiple owners");
        const fn = functions.get(body.unitId);
        if (!fn) invalid("missing original class body");
        const parameters = [
          body.frame.environmentType,
          body.frame.thisType,
          body.frame.homeObjectType,
          body.frame.newTargetType,
          ...body.params,
        ];
        if (
          preparedIrDataMismatch(
            fn.params.map((parameter) => parameter.type),
            parameters,
          ) !== undefined ||
          preparedIrDataMismatch(fn.resultTypes, body.result === null ? [] : [body.result]) !== undefined
        )
          invalid("actual hidden ABI/body signature mismatch");
        if (body.sourceBodyKind === "field-initializer" && body.params.length)
          invalid("initializer has user parameters");
        const first = fn.blocks[0]?.instrs[0] as unknown as Record<string, unknown> | undefined;
        if (!first || first.kind !== "js.class.frame.new" || first.definition !== entry.id)
          invalid("original callee lacks genuine entry frame");
        const actual = [first.environment, first.thisValue, first.homeObject, first.newTarget];
        if (
          preparedIrDataMismatch(
            actual,
            fn.params.slice(0, 4).map((parameter) => parameter.value),
          ) !== undefined ||
          first.alloc === undefined
        )
          invalid("frame hidden roots/allocation mismatch");
        if (preparedIrDataMismatch(first.resultType, irSupportRef(body.frame.type, false)) !== undefined)
          invalid("frame role type");
        if (
          preparedIrDataMismatch(fn.sourceClassBody, {
            classId: descriptor.sourceClassId,
            sourceBodyKind: body.sourceBodyKind,
            lexicalOwnerId: body.lexicalOwnerId,
            terminalOwnerId: body.terminalOwnerId,
            ordinal: body.ordinal,
          }) !== undefined
        )
          invalid("original class-body provenance");
        bodies.set(body.unitId, { definition: entry.id, body });
      }
    }
    const bindingTypes = new Map<
      string,
      {
        type: IrType;
        storage: "module" | "cell" | "value";
        innerOwned: boolean;
      }
    >();
    for (const entry of domain.definitions) {
      for (const binding of [entry.definition.outerBinding, entry.definition.innerBinding])
        if (binding) {
          const isInner = binding === entry.definition.innerBinding;
          const type =
            binding.valueType.kind === "support-ref" ? irSupportRef(binding.valueType.ref, false) : binding.valueType;
          bindingTypes.set(binding.id, {
            type,
            storage: binding.storage,
            innerOwned: isInner && binding.storage === "cell",
          });
        }
      const captureLists = [
        entry.definition.captures,
        entry.definition.constructor.frame.captures,
        ...entry.definition.members.map((member) => member.body.frame.captures),
        ...entry.definition.instanceElements.flatMap((element) =>
          element.initializer ? [element.initializer.frame.captures] : [],
        ),
      ];
      for (const captures of captureLists)
        for (const capture of captures) {
          const type =
            capture.type.kind === "support-ref" &&
            capture.type.ref.binding.bindingId === entry.definition.roles.constructor.binding.bindingId
              ? irSupportRef(capture.type.ref, false)
              : capture.type;
          const storage = capture.mode === "live-cell" ? "cell" : capture.mode === "live-global" ? "module" : "value";
          const current = bindingTypes.get(capture.bindingId);
          if (current && (current.storage !== storage || preparedIrDataMismatch(current.type, type) !== undefined))
            invalid("capture binding referent/storage drift");
          if (!current)
            bindingTypes.set(capture.bindingId, {
              type,
              storage,
              innerOwned: false,
            });
        }
    }
    verifyNativeJsClassInstructions(module, definitions, bodies, bindingTypes, functions, domain);
  } catch (error) {
    if (error instanceof IrUnsupportedError)
      return {
        kind: "not-covered",
        reason: "reference-carrier",
        at: { kind: "module" },
      };
    if (error instanceof PreparedIrProgramInvariantError || error instanceof TypeError)
      return {
        kind: "invalid",
        code: "lexical-definition",
        at: { kind: "module" },
      };
    throw error;
  }
  if (neutral.kind !== "representable") return neutral;
  return {
    kind: "verified",
    profile: "native-js-class-v1",
    namespaces: neutral.namespaces,
    census: neutral.census,
  };
}
