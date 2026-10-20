// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  directUses,
  forEachNestedBuffer,
  type IrFunction,
  type IrInstr,
  type IrBinop,
  type IrUnop,
} from "../../../core/nodes.js";
import type { IrValueId, IrConst } from "../../../core/nodes.js";
import { irTypeEquals, type IrType } from "../../../core/types.js";
import {
  irGlobalBindingKey,
  irModuleGlobalBindingId,
  irModuleTdzGlobalBindingId,
} from "../../../core/binding-references.js";
import { irUnitCallableBindingId } from "../../../core/callable-bindings.js";
import type { IrSourceId } from "../../../../shared/contracts/ir-identity.js";
import type { IrGlobalRef } from "../../../core/value-references.js";
import type { IrFuncRef } from "../../../core/value-references.js";
import type { IrUnitId } from "../../../../shared/contracts/ir-identity.js";
import { irBindingKey } from "../../../core/declared-types.js";
import { INTRINSIC_DEFINITIONS, type IntrinsicId } from "../../../core/intrinsics.js";
import { irTypeKey } from "../../../core/type-key.js";
import { irCallableBindingKey } from "../../../core/callable-bindings.js";
import {
  REFERENCE_ERROR_DECLARATION,
  REFERENCE_ERROR_RUNTIME_PROVIDERS,
} from "../../../core/reference-error-contract.js";
import { JS_TAG_IDS } from "../../../core/js-value-tag-identities.js";
import { createIrBindingId, createDerivedIrUnitId } from "../../../../shared/contracts/identity-values.js";
import type { NativeJsClassValueDomainInput, NativeJsClassValueDomainLocation } from "./contracts.js";
import { nativeJsClassValueDataKey as key } from "./data.js";
import { assertPreparedIrData } from "../../../../shared/contracts/prepared-ir-data.js";
const BINARY_OPCODES: Readonly<Record<IrBinop, true>> = {
  "f64.add": true,
  "f64.sub": true,
  "f64.mul": true,
  "f64.div": true,
  "f64.copysign": true,
  "f64.eq": true,
  "f64.ne": true,
  "f64.lt": true,
  "f64.le": true,
  "f64.gt": true,
  "f64.ge": true,
  "i32.eq": true,
  "i32.ne": true,
  "i32.and": true,
  "i32.or": true,
  "i64.eq": true,
  "i32.add": true,
  "i32.sub": true,
  "i32.mul": true,
  "i64.rem_s": true,
  "i32.lt_s": true,
  "i32.le_s": true,
  "i32.gt_s": true,
  "i32.ge_s": true,
  "i32.lt_u": true,
  "i32.le_u": true,
  "i32.gt_u": true,
  "i32.ge_u": true,
  "js.bitand": true,
  "js.bitor": true,
  "js.bitxor": true,
  "js.shl": true,
  "js.shr_s": true,
  "js.shr_u": true,
};
const UNARY_OPCODES: Readonly<Record<IrUnop, true>> = {
  "f64.neg": true,
  "f64.reinterpret_i64": true,
  "i64.reinterpret_f64": true,
  "i32.eqz": true,
  "i32.trunc_sat_f64_s": true,
  "i64.trunc_f64_s": true,
  "f64.convert_i32_s": true,
  "f64.convert_i64_s": true,
  "f64.abs": true,
  "f64.sqrt": true,
  "f64.floor": true,
  "f64.ceil": true,
  "f64.trunc": true,
  "ref.is_null": true,
};

interface Occurrence {
  readonly instr: IrInstr;
  readonly location: NativeJsClassValueDomainLocation;
}
interface IndexedFunction {
  readonly fn: IrFunction;
  readonly nativeReferenceCalls: ReadonlySet<IrInstr>;
  readonly occurrences: readonly Occurrence[];
  readonly types: ReadonlyMap<IrValueId, IrType>;
}
function literalTag(kind: IrConst["kind"]) {
  const tags = {
    f64: JS_TAG_IDS.NumberF64,
    f32: JS_TAG_IDS.NumberF64,
    i32: JS_TAG_IDS.NumberI32,
    bool: JS_TAG_IDS.Boolean,
    undefined: JS_TAG_IDS.Undefined,
    null: JS_TAG_IDS.Null,
    i64: undefined,
  };
  return Object.hasOwn(tags, kind) ? tags[kind] : undefined;
}
function valueTypeFits(actual: IrType | undefined, expected: IrType | undefined): boolean {
  return (
    actual !== undefined &&
    expected !== undefined &&
    (irTypeEquals(actual, expected) ||
      (actual.kind === "dynamic" && expected.kind === "dynamic" && expected.tag === undefined))
  );
}
/** Coherence for transfers this leaf actually understands; never a substitute for the full IR verifier. */
function assertKnownTransferTypes(
  unit: IndexedFunction,
  declarations: NativeJsClassValueDomainInput["declarations"],
  target: IrFuncRef,
): void {
  const signatures = new Map(declarations.signatures.map((row) => [row.key, row.signature]));
  if (signatures.size !== declarations.signatures.length)
    throw new TypeError("native class value domain duplicate declaration");
  const own = signatures.get(irBindingKey(target.binding)!);
  const nullableTypeEquals = (a: IrType | null, b: IrType | null) =>
    a === null || b === null ? a === b : irTypeEquals(a, b);
  if (
    own &&
    (own.params.length !== unit.fn.params.length ||
      own.params.some((type, index) => !irTypeEquals(type, unit.fn.params[index]!.type)) ||
      !nullableTypeEquals(own.result, unit.fn.resultTypes[0] ?? null))
  )
    throw new TypeError("native class value domain callable declaration differs from actual body");
  const valKind = (type: IrType | undefined) => (type?.kind === "val" ? type.val.kind : undefined);
  for (const { instr } of unit.occurrences) {
    if (instr.kind === "const") {
      const literal = instr.value.kind,
        type = instr.resultType;
      const numeric = ["f64", "f32", "i32", "i64", "bool"].includes(literal);
      if (
        numeric &&
        !(type?.kind === "val" && type.val.kind === (literal === "bool" ? "i32" : literal)) &&
        type?.kind !== "dynamic"
      )
        throw new TypeError("native class value domain numeric literal carrier differs");
      const tag = literalTag(literal);
      if (type?.kind === "dynamic" && type.tag !== undefined && tag !== undefined && type.tag !== tag)
        throw new TypeError("native class value domain literal tag contradicts its actual value");
    } else if (instr.kind === "binary" || instr.kind === "unary") {
      const vocabulary = instr.kind === "binary" ? BINARY_OPCODES : UNARY_OPCODES;
      if (typeof instr.op !== "string" || !Object.hasOwn(vocabulary, instr.op))
        throw new TypeError("native class value domain unknown primitive opcode");
      const input = instr.kind === "binary" ? [instr.lhs, instr.rhs] : [instr.rand];
      if (instr.kind === "binary" && instr.op.startsWith("js.")) {
        const rawNumber = (type: IrType | undefined) =>
          type?.kind === "val" && (type.val.kind === "f64" || (type.val.kind === "i32" && !type.val.symbol));
        if (input.some((value) => !rawNumber(unit.types.get(value))) || !rawNumber(instr.resultType ?? undefined))
          throw new TypeError("native class value domain JS bitwise raw carrier differs");
        if (instr.resultType?.kind === "val" && instr.resultType.val.kind === "i32" && instr.resultType.val.boolean)
          throw new TypeError("native class value domain JS bitwise Number result cannot claim Boolean");
      }
      if (instr.kind === "unary" && instr.op === "ref.is_null") {
        const operand = unit.types.get(instr.rand);
        const reference =
          operand?.kind === "support-ref" ||
          (operand?.kind === "val" &&
            ["ref", "ref_null", "funcref", "externref", "ref_extern", "eqref", "anyref"].includes(operand.val.kind));
        if (!reference || valKind(instr.resultType ?? undefined) !== "i32")
          throw new TypeError("native class value domain null-test reference/i32 carrier differs");
      }
      const expected =
        instr.kind === "unary" && instr.op.includes("_f64")
          ? "f64"
          : instr.kind === "unary" && instr.op.includes("_i64")
            ? "i64"
            : instr.kind === "unary" && instr.op.includes("_i32")
              ? "i32"
              : instr.op.split(".")[0];
      if (
        ["f64", "f32", "i32", "i64"].includes(expected) &&
        input.some((value) => valKind(unit.types.get(value)) !== expected)
      )
        throw new TypeError("native class value domain raw numeric operand carrier differs");
      const comparison = instr.kind === "binary" && /\.(eq|ne|lt|le|gt|ge)(_[su])?$/.test(instr.op);
      const result = comparison ? "i32" : instr.op.split(".")[0];
      if (["f64", "f32", "i32", "i64"].includes(result) && valKind(instr.resultType ?? undefined) !== result)
        throw new TypeError("native class value domain raw numeric result carrier differs");
    } else if (instr.kind === "call") {
      const declared = signatures.get(irBindingKey(instr.target.binding)!);
      if (!declared) continue; // Unpopulated/unknown targets stay explicit unknown-callee obligations.
      if (
        declared.params.length !== instr.args.length ||
        instr.args.some((value, index) => !valueTypeFits(unit.types.get(value), declared.params[index])) ||
        ((instr.result !== null || instr.resultType != null) &&
          !nullableTypeEquals(instr.resultType ?? null, declared.result))
      )
        throw new TypeError("native class value domain actual call declaration differs");
    } else if (instr.kind === "early.return") {
      if (
        instr.value === null
          ? unit.fn.resultTypes.length !== 0
          : unit.fn.resultTypes.length !== 1 || !valueTypeFits(unit.types.get(instr.value), unit.fn.resultTypes[0])
      )
        throw new TypeError("native class value domain early return carrier differs");
    } else if (instr.kind === "if") {
      if (
        !valueTypeFits(unit.types.get(instr.thenValue), instr.resultType ?? undefined) ||
        !valueTypeFits(unit.types.get(instr.elseValue), instr.resultType ?? undefined)
      )
        throw new TypeError("native class value domain structured arm carrier differs");
    }
  }
  for (const block of unit.fn.blocks)
    if (block.terminator.kind === "return") {
      const returned = block.terminator.values;
      if (
        returned.length !== unit.fn.resultTypes.length ||
        returned.some((value, index) => !valueTypeFits(unit.types.get(value), unit.fn.resultTypes[index]))
      )
        throw new TypeError("native class value domain return carrier differs");
    }
}
/** Cross-check complete raw metadata against the independently normalized input populations. */
function assertRuntimeInputJoins(input: NativeJsClassValueDomainInput): void {
  const context = input.runtimeContext!;
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("raw runtime record required");
    return value as Record<string, unknown>;
  };
  const rows = context.abiEntries,
    ids = rows.map((row) => object(row.plan).id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)
    throw new TypeError("duplicate raw ABI plan identity");
  const callableKeys = new Set<string>(),
    globalKeys = new Set<string>(),
    normalizedCallables = new Set<string>(),
    normalizedGlobals = new Set<string>();
  for (const row of rows) {
    const plan = object(row.plan),
      contract = object(row.contract);
    if (plan.slotPolicy === "alias") {
      const visited = new Set<unknown>();
      let current = plan;
      while (current.slotPolicy === "alias") {
        if (visited.has(current.id)) throw new TypeError("raw ABI alias cycle");
        visited.add(current.id);
        const next = rows.find((entry) => object(entry.plan).id === current.aliasOf);
        if (!next) throw new TypeError("raw ABI alias target missing");
        current = object(next.plan);
      }
      continue;
    }
    if (contract.kind === "callable") {
      const ref = object(contract.ref) as unknown as IrFuncRef;
      if (
        ref.kind !== "func" ||
        !["unit", "import", "runtime", "intrinsic", "support"].includes(object(ref.binding).kind as string)
      )
        throw new TypeError("malformed raw callable binding kind");
      const normalized = irBindingKey(ref.binding);
      if (normalized === null || normalizedCallables.has(normalized))
        throw new TypeError("duplicate normalized raw callable key");
      normalizedCallables.add(normalized);
      const structural = irCallableBindingKey(ref.binding);
      if (ref.kind !== "func" || plan.structuralReferenceKey !== structural || callableKeys.has(structural))
        throw new TypeError("duplicate or contradictory raw callable reference");
      callableKeys.add(structural);
      if (ref.binding.kind === "unit" && plan.id !== irUnitCallableBindingId(ref.binding.unitId))
        throw new TypeError("raw callable unit identity differs");
      if (ref.binding.kind === "support" && plan.id !== ref.binding.bindingId)
        throw new TypeError("raw callable support identity differs");
    }
    if (contract.kind === "global") {
      const ref = object(contract.ref) as unknown as IrGlobalRef;
      if (
        ref.kind !== "global" ||
        !["source", "import", "runtime", "support"].includes(object(ref.binding).kind as string)
      )
        throw new TypeError("malformed raw global binding kind");
      const normalized = irBindingKey(ref.binding);
      if (normalized === null || normalizedGlobals.has(normalized))
        throw new TypeError("duplicate normalized raw global key");
      normalizedGlobals.add(normalized);
      const structural = irGlobalBindingKey(ref.binding);
      if (
        ref.kind !== "global" ||
        plan.id !== ref.binding.bindingId ||
        plan.structuralReferenceKey !== structural ||
        globalKeys.has(structural)
      )
        throw new TypeError("duplicate or contradictory raw global reference");
      globalKeys.add(structural);
    }
  }
  if (
    normalizedCallables.size !== input.declarations.signatures.length ||
    input.declarations.signatures.some((row) => !normalizedCallables.has(row.key)) ||
    normalizedGlobals.size !== input.globals.length ||
    input.globals.some((row) => !normalizedGlobals.has(irBindingKey(row.ref.binding) ?? ""))
  )
    throw new TypeError("normalized raw ABI reverse census differs");
  const attachments = rows.filter((row) => Object.hasOwn(object(row.contract), "nativeJsClassDefinition"));
  if (attachments.length !== input.definitions.length) throw new TypeError("raw definition reverse census differs");
  for (const row of attachments) {
    const contract = object(row.contract),
      plan = object(row.plan),
      definition = object(contract.nativeJsClassDefinition);
    if (typeof definition.sourceClassId !== "string") throw new TypeError("raw definition source missing");
    const bindingId = createIrBindingId({
      ownerId:
        definition.sourceClassId as NativeJsClassValueDomainInput["definitions"][number]["definition"]["sourceClassId"],
      domain: "support",
      role: "native-js-class-definition-v1",
    });
    const matches = input.definitions.filter((entry) => entry.bindingId === bindingId);
    if (
      contract.kind !== "support" ||
      contract.role !== "native-js-class-definition-v1" ||
      plan.id !== bindingId ||
      plan.slotPolicy !== "none" ||
      object(plan.intent).kind !== "support" ||
      object(plan.intent).role !== "native-js-class-definition-v1" ||
      matches.length !== 1 ||
      key(matches[0]!.definition) !== key(definition)
    )
      throw new TypeError("raw definition attachment differs");
  }
  for (const global of input.globals) {
    const classValue = input.definitions.some(({ definition }) =>
      [definition.outerBinding, definition.innerBinding].some(
        (binding) => binding?.valueGlobal?.binding.bindingId === global.ref.binding.bindingId,
      ),
    );
    const declarations = context.startup
      .flatMap((plan) => plan.bindings as readonly Record<string, unknown>[])
      .filter((binding) => binding.globalBindingId === global.ref.binding.bindingId);
    if (declarations.length > 1) throw new TypeError("duplicate raw startup initializer");
    const initial =
      classValue || declarations[0]?.initialization === "tdz"
        ? { kind: "uninitialized" }
        : declarations[0]?.initialization === "undefined-at-instantiation"
          ? { kind: "constant", value: { kind: "undefined" } }
          : { kind: "unknown" };
    if (key(initial) !== key(global.initial)) throw new TypeError("raw startup initial world differs");
  }
  for (const plan of context.startup) {
    if (typeof plan.sourceId !== "string" || !Array.isArray(plan.bindings))
      throw new TypeError("raw startup source missing");
    for (const data of plan.bindings) {
      const binding = object(data),
        ordinal = binding.declarationOrdinal;
      if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0) throw new TypeError("raw startup ordinal differs");
      if (
        !["var", "let", "const"].includes(binding.declarationKind as string) ||
        binding.mutable !== (binding.declarationKind !== "const") ||
        binding.initialization !== (binding.declarationKind === "var" ? "undefined-at-instantiation" : "tdz")
      )
        throw new TypeError("raw startup declaration initialization differs");
      if (
        binding.globalBindingId !== null &&
        binding.globalBindingId !== irModuleGlobalBindingId(plan.sourceId as IrSourceId, ordinal as number)
      )
        throw new TypeError("raw startup value identity differs");
      if (
        binding.tdzBindingId !==
        (binding.declarationKind === "var"
          ? null
          : irModuleTdzGlobalBindingId(plan.sourceId as IrSourceId, ordinal as number))
      )
        throw new TypeError("raw startup TDZ identity differs");
    }
  }
}
function assertRuntimeManifestCensus(value: unknown): void {
  const row = value as Record<string, unknown>;
  const fields = [
    "policy",
    "intrinsicUses",
    "features",
    "providers",
    "providerComponents",
    "hostCapabilities",
    "hostCapabilityRecords",
    "backendRequirements",
  ];
  if (
    Reflect.ownKeys(row).length !== fields.length ||
    Reflect.ownKeys(row).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new TypeError("closed raw manifest population differs");
  for (const name of fields.filter((name) => name !== "policy"))
    if (!Array.isArray(row[name])) throw new TypeError("raw manifest array missing");
  const providers = row.providers as readonly Record<string, unknown>[],
    components = row.providerComponents as readonly Record<string, unknown>[];
  const features = row.features as readonly unknown[],
    providerIds = providers.map((provider) => provider.id);
  if (
    new Set(features).size !== features.length ||
    new Set(providerIds).size !== providerIds.length ||
    new Set(providers.map((provider) => provider.feature)).size !== providers.length
  )
    throw new TypeError("duplicate raw manifest identity");
  const componentFeatures: unknown[] = [],
    componentProviders: unknown[] = [];
  for (const component of components) {
    if (
      Reflect.ownKeys(component).length !== 3 ||
      !["features", "providers", "cyclic"].every((field) => Object.hasOwn(component, field)) ||
      !Array.isArray(component.features) ||
      !Array.isArray(component.providers) ||
      typeof component.cyclic !== "boolean"
    )
      throw new TypeError("closed raw component differs");
    componentFeatures.push(...component.features);
    componentProviders.push(...component.providers);
  }
  if (
    componentFeatures.length !== features.length ||
    new Set(componentFeatures).size !== features.length ||
    features.some((feature) => !componentFeatures.includes(feature)) ||
    componentProviders.length !== providerIds.length ||
    new Set(componentProviders).size !== providerIds.length ||
    providerIds.some((id) => !componentProviders.includes(id))
  )
    throw new TypeError("raw manifest component reverse census differs");
  const canonical = REFERENCE_ERROR_RUNTIME_PROVIDERS[1]!;
  const matching = components.filter(
    (component) =>
      (component.features as unknown[]).includes(canonical.feature) ||
      (component.providers as unknown[]).includes(canonical.id),
  );
  if (
    matching.length !== 1 ||
    key(matching[0]) !== key({ features: [canonical.feature], providers: [canonical.id], cyclic: false })
  )
    throw new TypeError("raw ReferenceError component differs");
}

/** Reconstruct the fixed native allocator from complete raw facts, not a supplied verdict. */
function assertRuntimeClassBodies(input: NativeJsClassValueDomainInput, functions: readonly IrFunction[]): void {
  const inventory = input.runtimeContext!.inventory;
  for (const unit of inventory.allUnits) {
    if (unit.terminalOwnerId !== null && !inventory.terminalUnits.some((row) => row.id === unit.terminalOwnerId))
      throw new TypeError("raw original terminal owner differs");
    if (unit.terminal && unit.terminalOwnerId !== unit.id) throw new TypeError("raw original terminal owner differs");
  }
  for (const derived of input.runtimeContext!.derivedUnits) {
    if (
      typeof derived.id !== "string" ||
      typeof derived.ordinal !== "number" ||
      typeof derived.parentId !== "string" ||
      typeof derived.role !== "string" ||
      !Number.isSafeInteger(derived.ordinal) ||
      derived.ordinal < 0 ||
      derived.id !==
        createDerivedIrUnitId({
          parentId: derived.parentId as Parameters<typeof createDerivedIrUnitId>[0]["parentId"],
          role: derived.role as Parameters<typeof createDerivedIrUnitId>[0]["role"],
          ordinal: derived.ordinal,
        }) ||
      inventory.allUnits.some((row) => row.id === derived.id)
    )
      throw new TypeError("raw derived identity differs");
    const terminal = inventory.terminalUnits.find((row) => row.id === derived.terminalOwnerId);
    if (!terminal || terminal.sourceId !== derived.sourceId) throw new TypeError("raw derived source owner differs");
    const visited = new Set<unknown>();
    let current = derived;
    while (true) {
      if (visited.has(current.id)) throw new TypeError("raw derived provenance cycle");
      visited.add(current.id);
      const parent =
        inventory.allUnits.find((row) => row.id === current.parentId) ??
        input.runtimeContext!.derivedUnits.find((row) => row.id === current.parentId);
      if (!parent || parent.sourceId !== current.sourceId || parent.terminalOwnerId !== current.terminalOwnerId)
        throw new TypeError("raw derived parent differs");
      const next = input.runtimeContext!.derivedUnits.find((row) => row.id === parent.id);
      if (!next) break;
      current = next;
    }
  }
  for (const { definition } of input.definitions) {
    const originals = inventory.classes.filter((row) => row.id === definition.sourceClassId);
    const owner = inventory.allUnits.find((row) => row.id === definition.evaluationOwnerUnitId);
    if (
      originals.length !== 1 ||
      originals[0]!.sourceId !== definition.sourceId ||
      originals[0]!.declarationStart !== definition.span.start ||
      originals[0]!.declarationEnd !== definition.span.end ||
      originals[0]!.declarationKind !== definition.form ||
      !owner?.terminal ||
      owner.sourceId !== definition.sourceId
    )
      throw new TypeError("raw class source ownership differs");
  }
  const roles = input.definitions.flatMap(({ bindingId, definition }) =>
    [
      definition.constructor,
      ...definition.members.map((row) => row.body),
      ...definition.instanceElements.flatMap((row) => (row.initializer ? [row.initializer] : [])),
    ].map((body) => ({ bindingId, definition, body })),
  );
  if (
    inventory.allUnits.some(
      (unit) =>
        input.definitions.some((row) => row.definition.sourceClassId === unit.lexicalOwnerId) &&
        typeof unit.kind === "string" &&
        [
          "class-constructor",
          "class-implicit-constructor",
          "class-instance-method",
          "class-static-method",
          "class-instance-field-initializer",
          "class-static-field-initializer",
          "class-static-block",
        ].includes(unit.kind) &&
        !roles.some((row) => row.body.unitId === unit.id),
    )
  )
    throw new TypeError("raw class executable role reverse census differs");
  for (const fn of functions) {
    const owner = inventory.allUnits.find((unit) => unit.id === fn.unitId);
    if (owner && !owner.terminal && !Object.hasOwn(fn, "sourceClassBody")) {
      const parent = inventory.allUnits.find((unit) => unit.id === fn.parentId);
      if (
        fn.sourceUnit !== true ||
        fn.role !== "lifted-closure" ||
        fn.parentId !== owner.lexicalOwnerId ||
        fn.ordinal !== owner.ordinal ||
        !parent ||
        parent.sourceId !== owner.sourceId ||
        parent.terminalOwnerId !== owner.terminalOwnerId ||
        ![
          "nested-function",
          "function-expression",
          "arrow-function",
          "object-method",
          "object-getter",
          "object-setter",
        ].includes(owner.kind)
      )
        throw new TypeError("raw lifted source body provenance differs");
    }
    const checkReference = (reference: IrFuncRef) => {
      if (reference.binding.kind === "unit") {
        const unitId = reference.binding.unitId;
        if (!functions.some((body) => body.unitId === unitId)) throw new TypeError("raw unit reference has no body");
      }
    };
    const walk = (buffer: readonly IrInstr[]): void => {
      for (const operation of buffer) {
        if (operation.kind === "call") checkReference(operation.target);
        if (operation.kind === "closure.new") checkReference(operation.liftedFunc);
        if (
          (operation.kind === "class.new" ||
            operation.kind === "class.call" ||
            operation.kind === "class.static_call") &&
          operation.target
        )
          checkReference(operation.target);
        forEachNestedBuffer(operation, walk);
      }
    };
    for (const block of fn.blocks) walk(block.instrs);
    const matches = roles.filter((row) => row.body.unitId === fn.unitId);
    if (!matches.length) {
      if (Object.hasOwn(fn, "sourceClassBody")) throw new TypeError("raw class body provenance differs");
      continue;
    }
    if (matches.length !== 1) throw new TypeError("raw class body owner is not unique");
    const { bindingId, definition, body } = matches[0]!;
    if (!Object.hasOwn(fn, "sourceClassBody")) throw new TypeError("raw class body provenance differs");
    const provenance = fn.sourceClassBody;
    const owners = inventory.allUnits.filter((row) => row.id === body.unitId);
    const kinds =
      body.sourceBodyKind === "constructor"
        ? ["class-constructor", "class-implicit-constructor"]
        : body.sourceBodyKind === "method"
          ? ["class-instance-method", "class-static-method"]
          : body.sourceBodyKind === "field-initializer"
            ? ["class-instance-field-initializer"]
            : ["class-static-field-initializer", "class-static-block"];
    if (
      owners.length !== 1 ||
      owners[0]!.sourceId !== definition.sourceId ||
      owners[0]!.lexicalOwnerId !== definition.sourceClassId ||
      owners[0]!.lexicalOwnerId !== body.lexicalOwnerId ||
      owners[0]!.terminalOwnerId !== body.terminalOwnerId ||
      owners[0]!.ordinal !== body.ordinal ||
      owners[0]!.declarationStart !== body.span.start ||
      owners[0]!.declarationEnd !== body.span.end ||
      !kinds.includes(owners[0]!.kind)
    )
      throw new TypeError("raw class source ownership differs");
    const expected = [
      body.frame.environmentType,
      body.frame.thisType,
      body.frame.homeObjectType,
      body.frame.newTargetType,
      ...body.params,
    ];
    const frame = fn.blocks[0]?.instrs[0];
    if (
      !provenance ||
      (Object.hasOwn(fn, "parentId") && fn.parentId !== undefined) ||
      (Object.hasOwn(fn, "role") && fn.role !== undefined) ||
      (Object.hasOwn(fn, "sourceUnit") && fn.sourceUnit !== undefined) ||
      provenance.classId !== definition.sourceClassId ||
      provenance.sourceBodyKind !== body.sourceBodyKind ||
      provenance.lexicalOwnerId !== body.lexicalOwnerId ||
      provenance.terminalOwnerId !== body.terminalOwnerId ||
      provenance.ordinal !== body.ordinal ||
      key(fn.params.map((param) => param.type)) !== key(expected) ||
      key(fn.resultTypes) !== key(body.result === null ? [] : [body.result]) ||
      !frame ||
      frame.kind !== "js.class.frame.new" ||
      frame.definition !== bindingId ||
      !Number.isSafeInteger(frame.alloc) ||
      (frame.alloc as number) < 0 ||
      frame.result === null ||
      !Number.isSafeInteger(frame.result) ||
      frame.result < 0 ||
      frame.resultType?.kind !== "support-ref" ||
      frame.resultType.nullable !== false ||
      frame.resultType.ref.kind !== "type" ||
      frame.resultType.ref.binding.kind !== "support" ||
      key(frame.resultType.ref.binding) !== key(definition.roles.frame.binding) ||
      key([frame.environment, frame.thisValue, frame.homeObject, frame.newTarget]) !==
        key(fn.params.slice(0, 4).map((param) => param.value))
    )
      throw new TypeError("raw class body provenance differs");
  }
  if (roles.some((row) => !functions.some((fn) => fn.unitId === row.body.unitId)))
    throw new TypeError("raw class body reverse census differs");
}

function nativeReferenceCalls(input: NativeJsClassValueDomainInput): ReadonlyMap<IrFunction, ReadonlySet<IrInstr>> {
  const result = new Map<IrFunction, ReadonlySet<IrInstr>>();
  if (!Object.hasOwn(input, "runtimeContext")) return result;
  const context = input.runtimeContext;
  if (!context || !Array.isArray(context.projections) || !context.projections.length)
    throw new TypeError("native class runtime context is incomplete");
  const own = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("runtime record required");
    return value as Record<string, unknown>;
  };
  const closed = (value: unknown, names: readonly string[]) => {
    const actual = Reflect.ownKeys(own(value));
    if (actual.length !== names.length || actual.some((name) => typeof name !== "string" || !names.includes(name)))
      throw new TypeError("closed runtime population differs");
  };
  closed(context, ["inventory", "derivedUnits", "abiEntries", "startup", "original", "runtimeSupport", "projections"]);
  const entries = context.inventory.sources.filter((source) => source.kind === "entry");
  if (entries.length !== 1) throw new TypeError("runtime entry source is not unique");
  for (const name of ["derivedUnits", "abiEntries", "startup"] as const)
    if (!Array.isArray(context[name])) throw new TypeError("runtime context population missing");
  if (!context.original || !Array.isArray(context.original.functions)) throw new TypeError("original bodies missing");
  closed(context.original, ["functions"]);
  const inventory = context.inventory;
  closed(inventory, ["sources", "classes", "allUnits", "terminalUnits"]);
  for (const rows of [
    inventory.sources,
    inventory.classes,
    inventory.allUnits,
    inventory.terminalUnits,
    context.derivedUnits,
  ]) {
    if (!Array.isArray(rows) || new Set(rows.map((row) => own(row).id)).size !== rows.length)
      throw new TypeError("duplicate or missing runtime ownership population");
  }
  if (inventory.allUnits.some((unit) => !Object.hasOwn(unit, "terminal") || typeof unit.terminal !== "boolean"))
    throw new TypeError("raw original terminal flag differs");
  if (key(inventory.terminalUnits) !== key(inventory.allUnits.filter((unit) => unit.terminal)))
    throw new TypeError("terminal ownership census differs");
  const sourceIds = new Set<unknown>(inventory.sources.map((source) => source.id));
  if (
    [...inventory.classes, ...inventory.allUnits, ...context.derivedUnits].some(
      (row) => !sourceIds.has(own(row).sourceId),
    )
  )
    throw new TypeError("runtime source ownership differs");
  if (
    context.startup.length !== inventory.sources.length ||
    context.startup.some((plan, index) => plan.sourceId !== inventory.sources[index]!.id) ||
    key(input.startupUnits) !== key(context.startup.flatMap((plan) => (plan.executable === true ? [plan.unitId] : [])))
  )
    throw new TypeError("runtime startup census differs");
  if (inventory.classes.length !== input.definitions.length) throw new TypeError("raw native class census differs");
  for (const definition of input.definitions)
    if (!inventory.classes.some((row) => row.id === definition.definition.sourceClassId))
      throw new TypeError("runtime class ownership differs");
  assertRuntimeInputJoins(input);
  const callable = REFERENCE_ERROR_DECLARATION;
  const bindingKey = irCallableBindingKey(callable.ref.binding);
  const bindingId = createIrBindingId({ ownerId: entries[0]!.id, domain: "callable", role: bindingKey });
  const matches = context.abiEntries.filter((row) => own(row.plan).id === bindingId);
  const row = matches[0],
    plan = row && own(row.plan),
    contract = row && own(row.contract);
  const intent = plan && own(plan.intent);
  const typeKey = (type: IrType) => `${irTypeKey(type)}:${key(type)}`;
  const signature = { params: callable.params.map(typeKey), results: callable.results.map(typeKey) };
  if (
    matches.length !== 1 ||
    !plan ||
    !contract ||
    !intent ||
    plan.slotPolicy !== "required" ||
    plan.slotSpace !== "function" ||
    plan.structuralReferenceKey !== bindingKey ||
    intent.kind !== "callable" ||
    intent.origin !== "runtime" ||
    key(intent.signature) !== key(signature) ||
    contract.kind !== "callable" ||
    key(contract.ref) !== key(callable.ref) ||
    key(contract.params) !== key(callable.params) ||
    key(contract.results) !== key(callable.results)
  )
    return result;
  if (context.abiEntries.some((entry) => entry !== row && own(entry.plan).structuralReferenceKey === bindingKey))
    return result;
  if (input.units.some((unit) => key(unit.target.binding) === key(callable.ref.binding))) return result;
  const callableRows = context.abiEntries.filter(
    (entry) => own(entry.plan).slotPolicy !== "alias" && own(entry.contract).kind === "callable",
  );
  if (
    callableRows.length !== input.declarations.signatures.length ||
    callableRows.some((entry) => {
      const actual = own(entry.contract),
        ref = own(actual.ref);
      const matches = input.declarations.signatures.filter(
        (row) => row.key === irBindingKey(ref.binding as IrFuncRef["binding"]),
      );
      return (
        matches.length !== 1 ||
        key(matches[0]!.signature) !== key({ params: actual.params, result: (actual.results as unknown[])[0] ?? null })
      );
    })
  )
    throw new TypeError("runtime declaration reverse census differs");
  const globalRows = context.abiEntries.filter(
    (entry) => own(entry.plan).slotPolicy !== "alias" && own(entry.contract).kind === "global",
  );
  if (
    globalRows.length !== input.globals.length ||
    globalRows.some((entry) => {
      const actual = own(entry.contract),
        matches = input.globals.filter((row) => key(row.ref) === key(actual.ref));
      return (
        matches.length !== 1 || key(matches[0]!.type) !== key(actual.type) || matches[0]!.mutable !== actual.mutable
      );
    })
  )
    throw new TypeError("runtime global reverse census differs");
  for (const plan of context.startup) {
    if (
      !Array.isArray(plan.bindings) ||
      !Array.isArray(plan.liveSeeds) ||
      !Array.isArray(plan.gaps) ||
      plan.gaps.length
    )
      throw new TypeError("runtime startup shape differs");
    for (const binding of plan.bindings)
      for (const id of [own(binding).globalBindingId, own(binding).tdzBindingId])
        if (id !== null && !globalRows.some((entry) => own(entry.plan).id === id))
          throw new TypeError("runtime startup global missing");
  }
  const support = context.runtimeSupport === null ? [] : own(context.runtimeSupport).batches;
  if (!Array.isArray(support)) throw new TypeError("runtime support population missing");
  if (
    support.some(
      (batch) => key(own(own(own(own(batch).implementation).declaration).ref).binding) === key(callable.ref.binding),
    )
  )
    return result;
  for (const batch of support) {
    const implementation = own(own(batch).implementation),
      declaration = own(implementation.declaration);
    const body = implementation.body as IrFunction;
    const units = input.units.filter((unit) => unit.unitId === body.unitId);
    const declarations = callableRows.filter((entry) => key(own(entry.contract).ref) === key(declaration.ref));
    if (
      units.length !== 1 ||
      units[0]!.kind !== "builtin" ||
      key(units[0]!.target) !== key(declaration.ref) ||
      declarations.length !== 1 ||
      key(own(declarations[0]!.contract).params) !== key(declaration.params) ||
      key(own(declarations[0]!.contract).results) !== key(declaration.results) ||
      key(body.params.map((param) => param.type)) !== key(declaration.params) ||
      key(body.resultTypes) !== key(declaration.results)
    )
      throw new TypeError("raw support declaration/body/ABI differs");
  }
  const supportFunctions = support.map((batch) => own(own(batch).implementation).body as IrFunction);
  const population = (view: readonly IrFunction[]) => {
    if (!Array.isArray(view) || new Set(view.map((fn) => fn.unitId)).size !== view.length)
      throw new TypeError("duplicate runtime body owner");
    const bodies = new Map(view.map((fn) => [fn.unitId, fn]));
    for (const fn of supportFunctions) {
      if (bodies.has(fn.unitId) && key(bodies.get(fn.unitId)) !== key(fn)) throw new TypeError("foreign support body");
      bodies.set(fn.unitId, fn);
    }
    if (bodies.size !== input.units.length || input.units.some((unit) => !bodies.has(unit.unitId)))
      throw new TypeError("runtime reverse body population differs");
    if ([...inventory.terminalUnits, ...context.derivedUnits].some((row) => !bodies.has(row.id)))
      throw new TypeError("raw terminal/derived reverse body census differs");
    assertRuntimeClassBodies(input, [...bodies.values()]);
    return bodies;
  };
  if (new Set(supportFunctions.map((fn) => fn.unitId)).size !== supportFunctions.length)
    throw new TypeError("duplicate support body");
  const originalBodies = population(context.original.functions);
  for (const unit of input.units) {
    const original = inventory.allUnits.filter((row) => row.id === unit.unitId);
    const derived = context.derivedUnits.filter((row) => row.id === unit.unitId);
    const builtins = supportFunctions.filter((fn) => fn.unitId === unit.unitId);
    if (
      original.length + derived.length + builtins.length !== 1 ||
      unit.kind !== (original.length ? "source" : derived.length ? "derived" : "builtin")
    )
      throw new TypeError("runtime unit ownership differs");
  }
  const allBodies = context.projections.map((view) => population(view.functions));
  const sameBodies = (view: ReadonlyMap<IrUnitId, IrFunction>) =>
    input.module.functions.every((fn) => key(view.get(fn.unitId)) === key(fn));
  if (input.namespace === "original" ? !sameBodies(originalBodies) : !allBodies.some(sameBodies)) return result;
  const policies = context.projections.map((view) => key([view.backend, view.target]));
  if (new Set(policies).size !== policies.length) throw new TypeError("duplicate runtime policy");
  for (const view of context.projections) {
    closed(view, ["backend", "target", "functions", "manifest", "providers"]);
    const manifest = own(view.manifest),
      policy = own(manifest.policy);
    assertRuntimeManifestCensus(manifest);
    if (
      !Array.isArray(view.functions) ||
      !Array.isArray(view.providers) ||
      !Array.isArray(manifest.providers) ||
      !Array.isArray(manifest.features) ||
      !Array.isArray(manifest.providerComponents)
    )
      throw new TypeError("runtime projection population missing");
    if (!Array.isArray(manifest.intrinsicUses)) throw new TypeError("runtime intrinsic census missing");
    const ids = new Set(manifest.intrinsicUses.map((use) => own(use).id));
    if (
      view.providers.length !== ids.size ||
      new Set(view.providers.map((row: unknown) => own(row).intrinsicId)).size !== ids.size
    )
      throw new TypeError("runtime intrinsic plan census differs");
    for (const row of view.providers) {
      if (!ids.has(row.intrinsicId) || !Object.hasOwn(INTRINSIC_DEFINITIONS, row.intrinsicId))
        throw new TypeError("runtime intrinsic identity differs");
      const feature = INTRINSIC_DEFINITIONS[row.intrinsicId as IntrinsicId].feature;
      const plans = manifest.providers.filter((provider) => own(provider).feature === feature);
      if (plans.length !== 1 || key(plans[0]) !== key(row.plan)) throw new TypeError("runtime intrinsic plan differs");
    }
    const descriptor = REFERENCE_ERROR_RUNTIME_PROVIDERS[1]!;
    const sorted = (values: readonly string[]) => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const canonical = {
      ...descriptor,
      dependencies: sorted(descriptor.dependencies),
      hostCapabilities: sorted(descriptor.hostCapabilities),
      supportedTargets: sorted(descriptor.supportedTargets),
      supportedBackends: sorted(descriptor.supportedBackends),
    };
    const providers = manifest.providers.filter(
      (provider) => own(provider).feature === callable.feature || own(provider).id === canonical.id,
    );
    if (
      !["standalone", "wasi"].includes(view.target) ||
      !["wasmgc", "linear"].includes(view.backend) ||
      policy.target !== view.target ||
      policy.backend !== view.backend ||
      providers.length !== 1 ||
      key(providers[0]) !== key(canonical) ||
      manifest.features.filter((feature) => feature === callable.feature).length !== 1 ||
      !manifest.providerComponents.some((component) => {
        const data = own(component);
        return (
          Array.isArray(data.features) &&
          Array.isArray(data.providers) &&
          data.features.includes(callable.feature) &&
          data.providers.includes(canonical.id)
        );
      }) ||
      view.providers.some((provider: unknown) => own(provider).intrinsicId === callable.feature)
    )
      return result;
  }
  const extern = (type: unknown) => key(type) === key(callable.params[0]);
  for (const fn of input.module.functions) {
    const accepted = new Set<IrInstr>();
    const visit = (instructions: readonly IrInstr[], inherited: ReadonlyMap<number, IrInstr>) => {
      const available = new Map(inherited);
      for (const instruction of instructions) {
        if (
          instruction.kind === "call" &&
          key(instruction.target) === key(callable.ref) &&
          instruction.args.length === 1 &&
          instruction.result !== null &&
          extern(instruction.resultType)
        ) {
          const argument = available.get(instruction.args[0]!);
          if (
            argument?.kind === "const" &&
            argument.value.kind === "null" &&
            extern(argument.value.ty) &&
            extern(argument.resultType)
          )
            accepted.add(instruction);
        }
        forEachNestedBuffer(instruction, (body) => visit(body, available));
        if (instruction.result !== null) available.set(instruction.result, instruction);
      }
    };
    for (const block of fn.blocks) visit(block.instrs, new Map());
    result.set(fn, accepted);
  }
  return result;
}

function indexInput(input: NativeJsClassValueDomainInput): ReadonlyMap<IrUnitId, IndexedFunction> {
  assertPreparedIrData(input);
  if (input.schema !== "native-js-class-value-domain-input-v1" || !["original", "selected"].includes(input.namespace))
    throw new TypeError("native class value domain namespace differs");
  const nativeCalls = nativeReferenceCalls(input);
  const indexed = new Map<IrUnitId, IndexedFunction>();
  const units = new Map(input.units.map((unit) => [unit.unitId, unit]));
  if (units.size !== input.units.length || input.units.length !== input.module.functions.length)
    throw new TypeError("native class value domain unit census differs");
  for (const fn of input.module.functions) {
    if (indexed.has(fn.unitId) || !units.has(fn.unitId) || !fn.blocks.length)
      throw new TypeError("native class value domain function census differs");
    if (
      fn.asyncPlan !== undefined ||
      Object.hasOwn(fn, "asyncRuntime") ||
      fn.funcKind === "async" ||
      fn.funcKind === "generator"
    )
      throw new TypeError("native class value domain async state-buffer census is not represented");
    const types = new Map<IrValueId, IrType>(),
      occurrences: Occurrence[] = [];
    const define = (value: IrValueId, type: IrType) => {
      if (!Number.isSafeInteger(value) || value < 0 || value >= fn.valueCount || types.has(value))
        throw new TypeError("native class value domain SSA census differs");
      types.set(value, type);
    };
    fn.params.forEach((param) => define(param.value, param.type));
    for (const [blockOrdinal, block] of fn.blocks.entries()) {
      if (block.id !== blockOrdinal) throw new TypeError("native class value domain block census differs");
      block.blockArgs.forEach((value, index) => define(value, block.blockArgTypes[index]!));
      const visit = (instructions: readonly IrInstr[], nestedPath: readonly number[]) =>
        instructions.forEach((instr, instructionOrdinal) => {
          occurrences.push({ instr, location: { unitId: fn.unitId, blockOrdinal, nestedPath, instructionOrdinal } });
          if (instr.result !== null) {
            if (!instr.resultType) throw new TypeError("native class value domain SSA result type missing");
            define(instr.result, instr.resultType);
          }
          let ordinal = 0;
          forEachNestedBuffer(instr, (body) => visit(body, [...nestedPath, ordinal++, instructionOrdinal]));
        });
      visit(block.instrs, []);
    }
    for (const { instr } of occurrences)
      for (const value of directUses(instr))
        if (!types.has(value)) throw new TypeError("native class value domain unknown SSA use");
    for (const block of fn.blocks) {
      const end = block.terminator;
      const uses =
        end.kind === "return"
          ? end.values
          : end.kind === "br"
            ? end.branch.args
            : end.kind === "br_if"
              ? [end.condition, ...end.ifTrue.args, ...end.ifFalse.args]
              : [];
      if (uses.some((value) => !types.has(value)))
        throw new TypeError("native class value domain unknown terminator operand");
    }
    const unit = { fn, occurrences, types, nativeReferenceCalls: nativeCalls.get(fn) ?? new Set<IrInstr>() };
    assertKnownTransferTypes(unit, input.declarations, units.get(fn.unitId)!.target);
    indexed.set(fn.unitId, unit);
  }
  if (new Set(input.globals.map((global) => global.ref.binding.bindingId)).size !== input.globals.length)
    throw new TypeError("native class value domain global census differs");
  const declaredGlobals = new Map(input.declarations.globals.map((row) => [row.key, row.type]));
  if (declaredGlobals.size !== input.declarations.globals.length || declaredGlobals.size !== input.globals.length)
    throw new TypeError("native class value domain global declaration census differs");
  for (const global of input.globals) {
    const declared = declaredGlobals.get(irBindingKey(global.ref.binding)!);
    if (!declared || !irTypeEquals(global.type, declared))
      throw new TypeError("native class value domain global declaration type differs");
    if (global.initial.kind === "constant") {
      const literal = global.initial.value.kind;
      if (literal !== "undefined" && literal !== "null" && global.type.kind !== "val" && global.type.kind !== "dynamic")
        throw new TypeError("native class value domain global literal carrier differs");
      if (
        global.type.kind === "val" &&
        ["f64", "f32", "i32", "i64", "bool"].includes(literal) &&
        (global.type.val.kind !== (literal === "bool" ? "i32" : literal) ||
          (global.type.val.kind === "i32" && global.type.val.boolean === true && literal !== "bool"))
      )
        throw new TypeError("native class value domain global literal carrier differs");
      const tag = literalTag(literal);
      if (
        global.type.kind === "dynamic" &&
        global.type.tag !== undefined &&
        tag !== undefined &&
        global.type.tag !== tag
      )
        throw new TypeError("native class value domain global literal tag contradicts actual value");
    }
  }
  const definitions = new Set<string>();
  for (const { bindingId, definition } of input.definitions) {
    const actual = createIrBindingId({
      ownerId: definition.sourceClassId,
      domain: "support",
      role: "native-js-class-definition-v1",
    });
    if (bindingId !== actual || definitions.has(bindingId))
      throw new TypeError("native class value domain definition census differs");
    definitions.add(bindingId);
    const ordinals = [...definition.members, ...definition.instanceElements].map((row) => row.sourceOrdinal);
    if (
      new Set(ordinals).size !== ordinals.length ||
      ordinals.some((value) => !Number.isSafeInteger(value) || value < 0)
    )
      throw new TypeError("native class value domain duplicate/invalid original member ordinal");
    for (const body of [
      definition.constructor,
      ...definition.members.map((member) => member.body),
      ...definition.instanceElements.flatMap((field) => (field.initializer ? [field.initializer] : [])),
    ]) {
      const fn = indexed.get(body.unitId)?.fn,
        unit = units.get(body.unitId);
      const expected = [
        body.frame.environmentType,
        body.frame.thisType,
        body.frame.homeObjectType,
        body.frame.newTargetType,
        ...body.params,
      ];
      if (
        !fn ||
        unit?.sourceClassId !== definition.sourceClassId ||
        unit.sourceBodyKind !== body.sourceBodyKind ||
        key(unit.target.binding) !== key(body.target.binding) ||
        fn.params.length !== expected.length ||
        fn.params.some((param, i) => !irTypeEquals(param.type, expected[i]!)) ||
        fn.resultTypes.length !== (body.result === null ? 0 : 1) ||
        (body.result !== null && !irTypeEquals(fn.resultTypes[0]!, body.result))
      )
        throw new TypeError("native class value domain body/frame census differs");
    }
  }
  if (
    input.startupUnits.some((unit) => !indexed.has(unit)) ||
    new Set(input.startupUnits).size !== input.startupUnits.length
  )
    throw new TypeError("native class value domain startup census differs");
  for (const row of input.entryInputs) {
    const param = indexed.get(row.unitId)?.fn.params[row.parameter];
    if (!param || !irTypeEquals(param.type, row.type) || !["external-js", "scalar-ir"].includes(row.transport))
      throw new TypeError("native class value domain entry transport differs");
    if (row.transport === "scalar-ir")
      throw new TypeError("native class value domain original transport lacks an authenticated scalar bridge");
  }
  if (new Set(input.entryInputs.map((row) => key([row.unitId, row.parameter]))).size !== input.entryInputs.length)
    throw new TypeError("native class value domain duplicate entry parameter");
  const publicUnits = new Set<IrUnitId>(),
    exportNames = new Set<string>();
  for (const exported of input.exports) {
    const unit = input.units.find((unit) => key(unit.target.binding) === key(exported.target.binding));
    const fn = unit && indexed.get(unit.unitId)?.fn;
    if (
      !fn ||
      typeof exported.externalName !== "string" ||
      exported.externalName.length === 0 ||
      exportNames.has(exported.externalName) ||
      exported.logicalParams.length !== fn.params.length ||
      exported.logicalParams.some((type, index) => !irTypeEquals(type, fn.params[index]!.type)) ||
      (exported.logicalResult === null
        ? fn.resultTypes.length !== 0
        : fn.resultTypes.length !== 1 || !irTypeEquals(exported.logicalResult, fn.resultTypes[0]!))
    )
      throw new TypeError("native class value domain actual export census/signature differs");
    exportNames.add(exported.externalName);
    publicUnits.add(fn.unitId);
  }
  const entries = new Set(input.entryInputs.map((row) => key([row.unitId, row.parameter])));
  if (
    input.entryInputs.some((row) => !publicUnits.has(row.unitId)) ||
    [...publicUnits].some((id) => indexed.get(id)!.fn.params.some((_, ordinal) => !entries.has(key([id, ordinal]))))
  )
    throw new TypeError("native class value domain exported parameter census differs");
  return indexed;
}

export { indexInput as indexNativeJsClassValueDomainInput };
export type { IndexedFunction as NativeJsClassValueIndexedFunction };
