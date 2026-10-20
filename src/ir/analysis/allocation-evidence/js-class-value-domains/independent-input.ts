// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent equation replay. No producer runtime dependency or report authority.
import {
  directUses,
  forEachNestedBuffer,
  type IrModule,
  type IrFunction,
  type IrInstr,
  type IrBinop,
  type IrUnop,
} from "../../../core/nodes.js";

import { assertPreparedIrData } from "../../../../shared/contracts/prepared-ir-data.js";
import {
  irGlobalBindingKey,
  irModuleGlobalBindingId,
  irModuleTdzGlobalBindingId,
} from "../../../core/binding-references.js";
import type { IrGlobalRef } from "../../../core/value-references.js";
import { irUnitCallableBindingId } from "../../../core/callable-bindings.js";
import { irCallableBindingKey } from "../../../core/callable-bindings.js";
import { INTRINSIC_DEFINITIONS, type IntrinsicId } from "../../../core/intrinsics.js";
import { irTypeKey } from "../../../core/type-key.js";
import { createIrBindingId, createDerivedIrUnitId } from "../../../../shared/contracts/identity-values.js";
import type { IrSourceId } from "../../../../shared/contracts/ir-identity.js";
import {
  REFERENCE_ERROR_DECLARATION,
  REFERENCE_ERROR_RUNTIME_PROVIDERS,
} from "../../../core/reference-error-contract.js";
import { JS_TAG_IDS } from "../../../core/js-value-tag-identities.js";

import type { IrType } from "../../../core/types.js";
import type { IrFuncRef } from "../../../core/value-references.js";

import { irBindingKey } from "../../../core/declared-types.js";
import type { NativeJsClassValueDomainInput as Input } from "./contracts.js";

import {
  fail,
  record,
  array,
  fields,
  identifier,
  integer,
  stable,
  same,
  unitTarget,
  type Data,
  type Population,
  type Occurrence,
} from "./independent-kernel.js";

/** Every original definition, block and nested occurrence is visited, including unreachable code. */
function population(module: IrModule, definitionCount: number, globalCount: number): Population {
  const functions = new Map<string, IrFunction>(),
    definitions = new Map<string, Set<number>>();
  const occurrences: Occurrence[] = [];
  let parameters = 0,
    blockArguments = 0,
    invokes = 0,
    constructs = 0;
  for (const fn of module.functions) {
    const unit = identifier(fn.unitId);
    if (functions.has(unit)) fail("duplicate function unit");
    functions.set(unit, fn);
    const denominator = integer(fn.valueCount),
      values = new Set<number>(),
      blocks = new Set<number>();
    definitions.set(unit, values);
    const define = (value: unknown) => {
      const id = integer(value);
      if (id >= denominator || values.has(id)) fail("duplicate or out-of-range SSA definition");
      values.add(id);
    };
    for (const parameter of fn.params) {
      define(parameter.value);
      parameters++;
    }
    if (!fn.blocks.length) fail("missing function entry block");
    for (const [blockOrdinal, block] of fn.blocks.entries()) {
      const blockId = integer(block.id);
      if (blocks.has(blockId)) fail("duplicate CFG block");
      blocks.add(blockId);
      if (block.blockArgs.length !== block.blockArgTypes.length) fail("block argument type census");
      for (const value of block.blockArgs) {
        define(value);
        blockArguments++;
      }
      const walk = (instructions: readonly IrInstr[], nestedPath: readonly number[]) => {
        for (const [instructionOrdinal, instruction] of instructions.entries()) {
          if (instruction.result !== null) {
            if (instruction.resultType === null) fail("result without actual type");
            define(instruction.result);
          } else if (instruction.resultType !== null) fail("type without result");
          occurrences.push({ fn, blockOrdinal, nestedPath, instructionOrdinal, instruction });
          if (instruction.kind === "js.class.invoke") invokes++;
          if (instruction.kind === "js.class.construct") constructs++;
          let child = 0;
          forEachNestedBuffer(instruction, (buffer) => walk(buffer, [...nestedPath, child++, instructionOrdinal]));
        }
      };
      walk(block.instrs, []);
    }
    const edge = (branch: { readonly target: number; readonly args: readonly number[] }) => {
      const target = fn.blocks.find((block) => block.id === branch.target);
      if (!target || branch.args.length !== target.blockArgs.length) fail("CFG edge target/arity");
      for (const value of branch.args) if (!values.has(value)) fail("CFG edge undefined SSA operand");
    };
    for (const block of fn.blocks) {
      const end = block.terminator;
      if (end.kind === "return") {
        if (end.values.length !== fn.resultTypes.length) fail("return result census");
        for (const value of end.values) if (!values.has(value)) fail("undefined return SSA");
      } else if (end.kind === "br") edge(end.branch);
      else if (end.kind === "br_if") {
        if (!values.has(end.condition)) fail("undefined CFG condition");
        edge(end.ifTrue);
        edge(end.ifFalse);
      } else if (end.kind !== "unreachable") fail("unknown terminator");
    }
  }
  for (const occurrence of occurrences) {
    const values = definitions.get(occurrence.fn.unitId)!;
    for (const operand of directUses(occurrence.instruction))
      if (!values.has(operand)) fail("undefined instruction SSA operand");
  }
  return {
    functions,
    definitions,
    occurrences,
    census: {
      functions: functions.size,
      instructions: occurrences.length,
      parameters,
      blockArguments,
      definitions: definitionCount,
      globals: globalCount,
      invokes,
      constructs,
    },
  };
}

/** Independent lexical/block dominance for every ordinary and structured-if operand. */
function dominance(module: IrModule): void {
  for (const fn of module.functions) {
    const blocks = fn.blocks,
      predecessors = blocks.map(() => new Set<number>()),
      successors = blocks.map(() => new Set<number>());
    for (const [index, block] of blocks.entries()) {
      const end = block.terminator,
        branches = end.kind === "br" ? [end.branch] : end.kind === "br_if" ? [end.ifTrue, end.ifFalse] : [];
      for (const branch of branches) {
        const target = blocks.findIndex((block) => block.id === branch.target);
        if (target < 0) fail("CFG target");
        predecessors[target]!.add(index);
        successors[index]!.add(target);
      }
    }
    const reachable = new Set<number>(),
      queue = [0];
    while (queue.length) {
      const index = queue.shift()!;
      if (reachable.has(index)) continue;
      reachable.add(index);
      queue.push(...successors[index]!);
    }
    const dominators = blocks.map((_, index) => new Set(index === 0 ? [0] : reachable));
    let changed: boolean;
    do {
      changed = false;
      for (const index of reachable) {
        if (index === 0) continue;
        const previous = dominators[index]!,
          incoming = [...predecessors[index]!].filter((index) => reachable.has(index));
        let next = new Set<number>(reachable);
        for (const parent of incoming) next = new Set([...next].filter((value) => dominators[parent]!.has(value)));
        next.add(index);
        if (stable([...previous].sort()) !== stable([...next].sort())) {
          dominators[index] = next;
          changed = true;
        }
      }
    } while (changed);
    for (const [index, block] of blocks.entries()) {
      if (!reachable.has(index)) continue;
      const available = new Set<number>(fn.params.map((parameter) => parameter.value));
      for (const parent of dominators[index]!)
        if (parent !== index)
          for (const item of blocks[parent]!.instrs) if (item.result !== null) available.add(item.result);
      for (const value of block.blockArgs) available.add(value);
      const lexical = (buffer: readonly IrInstr[], scope: Set<number>): Set<number> => {
        for (const item of buffer) {
          if (item.kind === "if" || item.kind === "if.stmt") {
            if (!scope.has(item.cond)) fail("conditional SSA dominance");
            const a = lexical(item.then, new Set(scope)),
              b = lexical(item.else, new Set(scope));
            if (item.kind === "if" && (!a.has(item.thenValue) || !b.has(item.elseValue)))
              fail("conditional arm SSA scope");
          } else {
            const nested: (readonly IrInstr[])[] = [];
            forEachNestedBuffer(item, (buffer) => nested.push(buffer));
            if (!nested.length) {
              for (const operand of directUses(item)) if (!scope.has(operand)) fail("SSA use does not dominate");
            } else {
              // Unknown control is modeled as opaque/UNKNOWN, never scalar
              // evidence. Complete direct-use existence was checked above.
              // The full canonical verifier remains mandatory in the owner.
              for (const buffer of nested) {
                lexical(buffer, new Set(scope));
              }
            }
          }
          if (item.result !== null) scope.add(item.result);
        }
        return scope;
      };
      const after = lexical(block.instrs, available),
        end = block.terminator;
      const uses =
        end.kind === "return"
          ? end.values
          : end.kind === "br"
            ? end.branch.args
            : end.kind === "br_if"
              ? [end.condition, ...end.ifTrue.args, ...end.ifFalse.args]
              : [];
      for (const value of uses) if (!after.has(value)) fail("terminator SSA dominance");
    }
  }
}

function refKey(value: unknown): string {
  const ref = record(value),
    binding = record(ref.binding);
  return stable(binding);
}
/** Independent metadata join; no accepted population from the producer is consumed. */
function runtimeMetadataJoins(input: Input, raw: Data): void {
  const entries = array(raw.abiEntries).map(record);
  const ids = entries.map((entry) => identifier(record(entry.plan).id));
  if (new Set(ids).size !== entries.length) fail("duplicate raw ABI plan identity");
  const functions = new Set<string>(),
    globals = new Set<string>(),
    callableNames = new Set<string>(),
    globalNames = new Set<string>();
  for (const entry of entries) {
    const plan = record(entry.plan),
      contract = record(entry.contract);
    if (plan.slotPolicy === "alias") {
      const seen = new Set<unknown>();
      let current = plan;
      while (current.slotPolicy === "alias") {
        if (seen.has(current.id)) fail("raw ABI alias cycle");
        seen.add(current.id);
        const target = entries.find((row) => record(row.plan).id === current.aliasOf);
        if (!target) fail("raw ABI alias target missing");
        current = record(target.plan);
      }
    } else if (contract.kind === "callable") {
      const reference = record(contract.ref) as unknown as IrFuncRef;
      if (
        reference.kind !== "func" ||
        !["unit", "import", "runtime", "intrinsic", "support"].includes(record(reference.binding).kind as string)
      )
        fail("malformed raw callable binding kind");
      const name = irBindingKey(reference.binding);
      if (name === null || callableNames.has(name)) fail("duplicate normalized raw callable key");
      callableNames.add(name);
      const key = irCallableBindingKey(reference.binding);
      if (reference.kind !== "func" || functions.has(key) || plan.structuralReferenceKey !== key)
        fail("duplicate or contradictory raw callable reference");
      functions.add(key);
      if (
        (reference.binding.kind === "unit" && plan.id !== irUnitCallableBindingId(reference.binding.unitId)) ||
        (reference.binding.kind === "support" && plan.id !== reference.binding.bindingId)
      )
        fail("raw callable owner identity");
    } else if (contract.kind === "global") {
      const reference = record(contract.ref) as unknown as IrGlobalRef;
      if (
        reference.kind !== "global" ||
        !["source", "import", "runtime", "support"].includes(record(reference.binding).kind as string)
      )
        fail("malformed raw global binding kind");
      const name = irBindingKey(reference.binding);
      if (name === null || globalNames.has(name)) fail("duplicate normalized raw global key");
      globalNames.add(name);
      const key = irGlobalBindingKey(reference.binding);
      if (
        reference.kind !== "global" ||
        globals.has(key) ||
        plan.structuralReferenceKey !== key ||
        plan.id !== reference.binding.bindingId
      )
        fail("duplicate or contradictory raw global reference");
      globals.add(key);
    }
  }
  if (
    callableNames.size !== input.declarations.signatures.length ||
    input.declarations.signatures.some((row) => !callableNames.has(row.key)) ||
    globalNames.size !== input.globals.length ||
    input.globals.some((row) => !globalNames.has(irBindingKey(row.ref.binding) ?? ""))
  )
    fail("normalized raw ABI reverse census differs");
  const definitions = entries.filter((entry) => Object.hasOwn(record(entry.contract), "nativeJsClassDefinition"));
  if (definitions.length !== input.definitions.length) fail("raw definition reverse census differs");
  for (const entry of definitions) {
    const contract = record(entry.contract),
      plan = record(entry.plan),
      descriptor = record(contract.nativeJsClassDefinition);
    const id = createIrBindingId({
      ownerId: identifier(descriptor.sourceClassId) as Input["definitions"][number]["definition"]["sourceClassId"],
      domain: "support",
      role: "native-js-class-definition-v1",
    });
    const expected = input.definitions.filter((row) => row.bindingId === id);
    if (
      contract.kind !== "support" ||
      contract.role !== "native-js-class-definition-v1" ||
      plan.id !== id ||
      plan.slotPolicy !== "none" ||
      record(plan.intent).kind !== "support" ||
      record(plan.intent).role !== "native-js-class-definition-v1" ||
      expected.length !== 1 ||
      !same(expected[0]!.definition, descriptor)
    )
      fail("raw definition attachment differs");
  }
  const starts = array(raw.startup).map(record);
  for (const global of input.globals) {
    const classValue = input.definitions
      .flatMap((entry) => [entry.definition.outerBinding, entry.definition.innerBinding])
      .some((binding) => binding?.valueGlobal?.binding.bindingId === global.ref.binding.bindingId);
    const declarations = starts
      .flatMap((plan) => array(plan.bindings).map(record))
      .filter((binding) => binding.globalBindingId === global.ref.binding.bindingId);
    if (declarations.length > 1) fail("duplicate raw startup initializer");
    let expected: unknown = { kind: "unknown" };
    if (classValue || declarations[0]?.initialization === "tdz") expected = { kind: "uninitialized" };
    else if (declarations[0]?.initialization === "undefined-at-instantiation")
      expected = { kind: "constant", value: { kind: "undefined" } };
    if (!same(expected, global.initial)) fail("raw startup initial world differs");
  }
  for (const plan of starts) {
    const source = identifier(plan.sourceId) as IrSourceId;
    for (const binding of array(plan.bindings).map(record)) {
      const ordinal = integer(binding.declarationOrdinal);
      if (
        !["var", "let", "const"].includes(identifier(binding.declarationKind)) ||
        binding.mutable !== (binding.declarationKind !== "const") ||
        binding.initialization !== (binding.declarationKind === "var" ? "undefined-at-instantiation" : "tdz")
      )
        fail("raw startup declaration initialization differs");
      if (binding.globalBindingId !== null && binding.globalBindingId !== irModuleGlobalBindingId(source, ordinal))
        fail("raw startup value identity");
      if (
        binding.tdzBindingId !==
        (binding.declarationKind === "var" ? null : irModuleTdzGlobalBindingId(source, ordinal))
      )
        fail("raw startup TDZ identity");
    }
  }
}
function runtimeManifestJoins(manifest: Data): void {
  fields(manifest, [
    "policy",
    "intrinsicUses",
    "features",
    "providers",
    "providerComponents",
    "hostCapabilities",
    "hostCapabilityRecords",
    "backendRequirements",
  ]);
  array(manifest.intrinsicUses);
  array(manifest.hostCapabilities);
  array(manifest.hostCapabilityRecords);
  array(manifest.backendRequirements);
  const features = array(manifest.features),
    providers = array(manifest.providers).map(record);
  const ids = providers.map((row) => row.id);
  if (
    new Set(features).size !== features.length ||
    new Set(ids).size !== ids.length ||
    new Set(providers.map((row) => row.feature)).size !== providers.length
  )
    fail("duplicate raw manifest identity");
  const components = array(manifest.providerComponents).map(record);
  const actualFeatures: unknown[] = [],
    actualProviders: unknown[] = [];
  for (const component of components) {
    fields(component, ["features", "providers", "cyclic"]);
    if (typeof component.cyclic !== "boolean") fail("raw component cyclic flag");
    actualFeatures.push(...array(component.features));
    actualProviders.push(...array(component.providers));
  }
  if (
    actualFeatures.length !== features.length ||
    new Set(actualFeatures).size !== features.length ||
    features.some((feature) => !actualFeatures.includes(feature)) ||
    actualProviders.length !== ids.length ||
    new Set(actualProviders).size !== ids.length ||
    ids.some((id) => !actualProviders.includes(id))
  )
    fail("raw manifest component reverse census differs");
  const canonical = REFERENCE_ERROR_RUNTIME_PROVIDERS[1]!;
  const matches = components.filter(
    (row) => array(row.features).includes(canonical.feature) || array(row.providers).includes(canonical.id),
  );
  if (
    matches.length !== 1 ||
    !same(matches[0], { features: [canonical.feature], providers: [canonical.id], cyclic: false })
  )
    fail("raw ReferenceError component differs");
}

function runtimeBodyProvenance(input: Input, bodies: readonly Data[]): void {
  const inventory = record(record(input.runtimeContext).inventory);
  const sourceClasses = array(inventory.classes).map(record),
    sourceUnits = array(inventory.allUnits).map(record);
  const terminalRows = array(inventory.terminalUnits).map(record),
    derivedRows = array(record(input.runtimeContext).derivedUnits).map(record);
  for (const unit of sourceUnits) {
    if (unit.terminalOwnerId !== null && !terminalRows.some((row) => row.id === unit.terminalOwnerId))
      fail("raw original terminal owner differs");
    if (unit.terminal === true && unit.terminalOwnerId !== unit.id) fail("raw original terminal owner differs");
  }
  for (const unit of derivedRows) {
    const parentId = identifier(unit.parentId),
      role = identifier(unit.role),
      ordinal = integer(unit.ordinal);
    const canonical = createDerivedIrUnitId({
      parentId: parentId as Parameters<typeof createDerivedIrUnitId>[0]["parentId"],
      role: role as Parameters<typeof createDerivedIrUnitId>[0]["role"],
      ordinal,
    });
    if (unit.id !== canonical || sourceUnits.some((row) => row.id === unit.id)) fail("raw derived identity differs");
    const terminal = terminalRows.find((row) => row.id === unit.terminalOwnerId);
    if (!terminal || terminal.sourceId !== unit.sourceId) fail("raw derived source owner differs");
    const chain = new Set<unknown>();
    let current = unit;
    while (true) {
      if (chain.has(current.id)) fail("raw derived provenance cycle");
      chain.add(current.id);
      const parent =
        sourceUnits.find((row) => row.id === current.parentId) ??
        derivedRows.find((row) => row.id === current.parentId);
      if (!parent || parent.sourceId !== current.sourceId || parent.terminalOwnerId !== current.terminalOwnerId)
        fail("raw derived parent differs");
      const next = derivedRows.find((row) => row.id === parent.id);
      if (!next) break;
      current = next;
    }
  }
  for (const { definition } of input.definitions) {
    const records = sourceClasses.filter((row) => row.id === definition.sourceClassId);
    const evaluation = sourceUnits.find((row) => row.id === definition.evaluationOwnerUnitId);
    if (
      records.length !== 1 ||
      records[0]!.sourceId !== definition.sourceId ||
      records[0]!.declarationStart !== definition.span.start ||
      records[0]!.declarationEnd !== definition.span.end ||
      records[0]!.declarationKind !== definition.form ||
      evaluation?.terminal !== true ||
      evaluation.sourceId !== definition.sourceId
    )
      fail("raw class source ownership differs");
  }
  const catalogue = input.definitions.flatMap((row) =>
    [
      row.definition.constructor,
      ...row.definition.members.map((member) => member.body),
      ...row.definition.instanceElements.flatMap((field) => (field.initializer ? [field.initializer] : [])),
    ].map((body) => ({ row, body })),
  );
  if (
    sourceUnits.some(
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
        !catalogue.some(({ body }) => body.unitId === unit.id),
    )
  )
    fail("raw class executable role reverse census differs");
  for (const value of bodies) {
    const fn = value as unknown as IrFunction;
    const source = sourceUnits.find((unit) => unit.id === fn.unitId);
    if (source && source.terminal === false && !Object.hasOwn(fn, "sourceClassBody")) {
      const parent = sourceUnits.find((unit) => unit.id === fn.parentId);
      if (
        fn.sourceUnit !== true ||
        fn.role !== "lifted-closure" ||
        fn.parentId !== source.lexicalOwnerId ||
        fn.ordinal !== source.ordinal ||
        !parent ||
        parent.sourceId !== source.sourceId ||
        parent.terminalOwnerId !== source.terminalOwnerId ||
        ![
          "nested-function",
          "function-expression",
          "arrow-function",
          "object-method",
          "object-getter",
          "object-setter",
        ].includes(source.kind as string)
      )
        fail("raw lifted source body provenance differs");
    }
    const visit = (instructions: readonly IrInstr[]): void => {
      for (const operation of instructions) {
        const target =
          operation.kind === "call"
            ? operation.target
            : operation.kind === "closure.new"
              ? operation.liftedFunc
              : operation.kind === "class.new" ||
                  operation.kind === "class.call" ||
                  operation.kind === "class.static_call"
                ? operation.target
                : undefined;
        if (target?.binding.kind === "unit") {
          const targetUnit = target.binding.unitId;
          if (!bodies.some((body) => body.unitId === targetUnit)) fail("raw unit reference has no body");
        }
        forEachNestedBuffer(operation, visit);
      }
    };
    fn.blocks.forEach((block) => visit(block.instrs));
    const roles = catalogue.filter((entry) => entry.body.unitId === fn.unitId);
    if (roles.length === 0) {
      if (Object.hasOwn(fn, "sourceClassBody")) fail("raw class body provenance differs");
      continue;
    }
    if (roles.length !== 1) fail("raw class body owner is not unique");
    const { row, body } = roles[0]!;
    if (!Object.hasOwn(fn, "sourceClassBody")) fail("raw class body provenance differs");
    const actual = fn.sourceClassBody;
    const owners = sourceUnits.filter((entry) => entry.id === body.unitId);
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
      owners[0]!.sourceId !== row.definition.sourceId ||
      owners[0]!.lexicalOwnerId !== row.definition.sourceClassId ||
      owners[0]!.lexicalOwnerId !== body.lexicalOwnerId ||
      owners[0]!.terminalOwnerId !== body.terminalOwnerId ||
      owners[0]!.ordinal !== body.ordinal ||
      owners[0]!.declarationStart !== body.span.start ||
      owners[0]!.declarationEnd !== body.span.end ||
      !kinds.includes(owners[0]!.kind as string)
    )
      fail("raw class source ownership differs");
    if (
      !actual ||
      (Object.hasOwn(fn, "parentId") && fn.parentId !== undefined) ||
      (Object.hasOwn(fn, "role") && fn.role !== undefined) ||
      (Object.hasOwn(fn, "sourceUnit") && fn.sourceUnit !== undefined) ||
      actual.classId !== row.definition.sourceClassId ||
      actual.sourceBodyKind !== body.sourceBodyKind ||
      actual.lexicalOwnerId !== body.lexicalOwnerId ||
      actual.terminalOwnerId !== body.terminalOwnerId ||
      actual.ordinal !== body.ordinal
    )
      fail("raw class body provenance differs");
    const parameters = [
      body.frame.environmentType,
      body.frame.thisType,
      body.frame.homeObjectType,
      body.frame.newTargetType,
      ...body.params,
    ];
    const first = fn.blocks[0]?.instrs[0];
    if (
      !same(
        fn.params.map((parameter) => parameter.type),
        parameters,
      ) ||
      !same(fn.resultTypes, body.result === null ? [] : [body.result]) ||
      !first ||
      first.kind !== "js.class.frame.new" ||
      first.definition !== row.bindingId ||
      !Number.isSafeInteger(first.alloc) ||
      (first.alloc as number) < 0 ||
      first.result === null ||
      !Number.isSafeInteger(first.result) ||
      first.result < 0 ||
      first.resultType?.kind !== "support-ref" ||
      first.resultType.nullable !== false ||
      first.resultType.ref.kind !== "type" ||
      first.resultType.ref.binding.kind !== "support" ||
      !same(first.resultType.ref.binding, row.definition.roles.frame.binding) ||
      !same(
        [first.environment, first.thisValue, first.homeObject, first.newTarget],
        fn.params.slice(0, 4).map((parameter) => parameter.value),
      )
    )
      fail("raw class body provenance differs");
  }
  if (catalogue.some(({ body }) => !bodies.some((fn) => fn.unitId === body.unitId)))
    fail("raw class body reverse census differs");
}

/** The replay reconstructs raw provider and lexical membership without the producer index. */
function referenceAllocatorOccurrences(input: Input): ReadonlyMap<IrFunction, ReadonlySet<IrInstr>> {
  const found = new Map<IrFunction, ReadonlySet<IrInstr>>();
  if (!Object.hasOwn(input, "runtimeContext")) return found;
  const raw = record(input.runtimeContext);
  fields(raw, ["inventory", "derivedUnits", "abiEntries", "startup", "original", "runtimeSupport", "projections"]);
  const inventory = record(raw.inventory),
    original = record(raw.original);
  array(raw.derivedUnits);
  array(raw.startup);
  const sources = array(inventory.sources)
    .map(record)
    .filter((source) => source.kind === "entry");
  if (sources.length !== 1) fail("canonical runtime entry source");
  fields(original, ["functions"]);
  fields(inventory, ["sources", "classes", "allUnits", "terminalUnits"]);
  const sourceRows = array(inventory.sources).map(record),
    classRows = array(inventory.classes).map(record);
  const sourceUnits = array(inventory.allUnits).map(record),
    terminalUnits = array(inventory.terminalUnits).map(record);
  const derived = array(raw.derivedUnits).map(record),
    starts = array(raw.startup).map(record);
  for (const rows of [sourceRows, classRows, sourceUnits, terminalUnits, derived])
    if (new Set(rows.map((row) => identifier(row.id))).size !== rows.length) fail("duplicate raw runtime owner");
  if (sourceUnits.some((unit) => !Object.hasOwn(unit, "terminal") || typeof unit.terminal !== "boolean"))
    fail("raw original terminal flag differs");
  if (
    !same(
      terminalUnits,
      sourceUnits.filter((unit) => unit.terminal === true),
    )
  )
    fail("raw terminal population differs");
  const sourceIds = new Set(sourceRows.map((row) => row.id));
  if ([...classRows, ...sourceUnits, ...derived].some((row) => !sourceIds.has(row.sourceId)))
    fail("raw source owner missing");
  if (
    starts.length !== sourceRows.length ||
    starts.some((plan, index) => plan.sourceId !== sourceRows[index]!.id) ||
    !same(
      input.startupUnits,
      starts.flatMap((plan) => (plan.executable === true ? [plan.unitId] : [])),
    )
  )
    fail("raw startup differs");
  if (classRows.length !== input.definitions.length) fail("raw native class census differs");
  if (input.definitions.some((row) => !classRows.some((actual) => actual.id === row.definition.sourceClassId)))
    fail("raw class owner missing");
  runtimeMetadataJoins(input, raw);
  const canonical = REFERENCE_ERROR_DECLARATION,
    target = irCallableBindingKey(canonical.ref.binding);
  const id = createIrBindingId({ ownerId: identifier(sources[0]!.id) as IrSourceId, domain: "callable", role: target });
  const abi = array(raw.abiEntries).map(record),
    candidates = abi.filter((row) => record(row.plan).id === id);
  if (candidates.length !== 1) return found;
  const entry = candidates[0]!,
    plan = record(entry.plan),
    contract = record(entry.contract),
    intent = record(plan.intent);
  const semanticKey = (type: IrType) => `${irTypeKey(type)}:${stable(type)}`;
  if (
    plan.slotPolicy !== "required" ||
    plan.slotSpace !== "function" ||
    plan.structuralReferenceKey !== target ||
    intent.kind !== "callable" ||
    intent.origin !== "runtime" ||
    !same(intent.signature, {
      params: canonical.params.map(semanticKey),
      results: canonical.results.map(semanticKey),
    }) ||
    contract.kind !== "callable" ||
    !same(contract.ref, canonical.ref) ||
    !same(contract.params, canonical.params) ||
    !same(contract.results, canonical.results)
  )
    return found;
  if (
    abi.some((row) => row !== entry && record(row.plan).structuralReferenceKey === target) ||
    input.units.some((unit) => same(unit.target.binding, canonical.ref.binding))
  )
    return found;
  const declarations = abi.filter(
    (row) => record(row.plan).slotPolicy !== "alias" && record(row.contract).kind === "callable",
  );
  if (
    declarations.length !== input.declarations.signatures.length ||
    declarations.some((row) => {
      const actual = record(row.contract),
        reference = record(actual.ref);
      const matches = input.declarations.signatures.filter(
        (value) => value.key === irBindingKey(reference.binding as IrFuncRef["binding"]),
      );
      return (
        matches.length !== 1 ||
        !same(matches[0]!.signature, { params: actual.params, result: array(actual.results)[0] ?? null })
      );
    })
  )
    fail("raw declaration reverse census");
  const globals = abi.filter(
    (row) => record(row.plan).slotPolicy !== "alias" && record(row.contract).kind === "global",
  );
  if (
    globals.length !== input.globals.length ||
    globals.some((row) => {
      const actual = record(row.contract),
        matches = input.globals.filter((value) => same(value.ref, actual.ref));
      return matches.length !== 1 || !same(matches[0]!.type, actual.type) || matches[0]!.mutable !== actual.mutable;
    })
  )
    fail("raw global reverse census");
  for (const start of starts) {
    array(start.liveSeeds);
    if (array(start.gaps).length) fail("raw startup gaps");
    for (const binding of array(start.bindings).map(record))
      for (const id of [binding.globalBindingId, binding.tdzBindingId])
        if (id !== null && !globals.some((row) => record(row.plan).id === id)) fail("raw startup binding missing");
  }
  const batches = raw.runtimeSupport === null ? [] : array(record(raw.runtimeSupport).batches);
  if (
    batches.some((batch) =>
      same(record(record(record(record(batch).implementation).declaration).ref).binding, canonical.ref.binding),
    )
  )
    return found;
  for (const batch of batches) {
    const implementation = record(record(batch).implementation),
      declaration = record(implementation.declaration),
      body = record(implementation.body);
    const owners = input.units.filter((unit) => unit.unitId === body.unitId);
    const abiRows = declarations.filter((row) => same(record(row.contract).ref, declaration.ref));
    if (
      owners.length !== 1 ||
      owners[0]!.kind !== "builtin" ||
      !same(owners[0]!.target, declaration.ref) ||
      abiRows.length !== 1 ||
      !same(record(abiRows[0]!.contract).params, declaration.params) ||
      !same(record(abiRows[0]!.contract).results, declaration.results) ||
      !same(
        array(body.params).map((param) => record(param).type),
        declaration.params,
      ) ||
      !same(body.resultTypes, declaration.results)
    )
      fail("raw support declaration/body/ABI differs");
  }
  const support = batches.map((batch) => record(record(batch).implementation).body);
  const supportRows = support.map(record);
  if (new Set(supportRows.map((row) => row.unitId)).size !== supportRows.length) fail("duplicate raw support owner");
  const census = (functions: unknown) => {
    const ownBodies = array(functions).map(record);
    if (new Set(ownBodies.map((row) => identifier(row.unitId))).size !== ownBodies.length) fail("duplicate raw body");
    const joined = new Map(ownBodies.map((row) => [row.unitId, row]));
    for (const body of supportRows) {
      if (joined.has(body.unitId) && !same(joined.get(body.unitId), body)) fail("foreign raw support body");
      joined.set(body.unitId, body);
    }
    if (joined.size !== input.units.length || input.units.some((unit) => !joined.has(unit.unitId)))
      fail("raw body reverse census");
    if ([...array(inventory.terminalUnits).map(record), ...derived].some((owner) => !joined.has(owner.id)))
      fail("raw terminal/derived reverse body census differs");
    runtimeBodyProvenance(input, [...joined.values()]);
    return joined;
  };
  const originals = census(original.functions);
  for (const unit of input.units) {
    const a = sourceUnits.filter((row) => row.id === unit.unitId),
      b = derived.filter((row) => row.id === unit.unitId),
      c = supportRows.filter((row) => row.unitId === unit.unitId);
    if (a.length + b.length + c.length !== 1 || unit.kind !== (a.length ? "source" : b.length ? "derived" : "builtin"))
      fail("raw unit owner differs");
  }
  const projections = array(raw.projections).map(record);
  if (!projections.length) fail("complete native runtime projections required");
  if (new Set(projections.map((view) => stable([view.backend, view.target]))).size !== projections.length)
    fail("duplicate raw policy");
  const projected = projections.map((view) => census(view.functions));
  const matches = (bodies: ReadonlyMap<unknown, Data>) =>
    input.module.functions.every((fn) => same(bodies.get(fn.unitId), fn));
  if (input.namespace === "original" ? !matches(originals) : !projected.some(matches)) return found;
  const fixed = REFERENCE_ERROR_RUNTIME_PROVIDERS[1]!;
  const canonicalSet = (values: readonly string[]) =>
    Array.from(new Set(values)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const provider = {
    ...fixed,
    dependencies: canonicalSet(fixed.dependencies),
    hostCapabilities: canonicalSet(fixed.hostCapabilities),
    supportedTargets: canonicalSet(fixed.supportedTargets),
    supportedBackends: canonicalSet(fixed.supportedBackends),
  };
  for (const view of projections) {
    fields(view, ["backend", "target", "functions", "manifest", "providers"]);
    array(view.functions);
    const manifest = record(view.manifest),
      policy = record(manifest.policy);
    runtimeManifestJoins(manifest);
    const useIds = new Set(array(manifest.intrinsicUses).map((use) => record(use).id));
    const bindings = array(view.providers).map(record);
    if (bindings.length !== useIds.size || new Set(bindings.map((row) => row.intrinsicId)).size !== useIds.size)
      fail("raw intrinsic plan census");
    for (const binding of bindings) {
      if (
        typeof binding.intrinsicId !== "string" ||
        !useIds.has(binding.intrinsicId) ||
        !Object.hasOwn(INTRINSIC_DEFINITIONS, binding.intrinsicId)
      )
        fail("raw intrinsic identity");
      const feature = INTRINSIC_DEFINITIONS[binding.intrinsicId as IntrinsicId].feature;
      const providers = array(manifest.providers).filter((row) => record(row).feature === feature);
      if (providers.length !== 1 || !same(providers[0], binding.plan)) fail("raw intrinsic plan linkage");
    }
    const implementations = array(manifest.providers)
      .map(record)
      .filter((row) => row.feature === canonical.feature || row.id === provider.id);
    if (
      typeof view.target !== "string" ||
      !["standalone", "wasi"].includes(view.target) ||
      typeof view.backend !== "string" ||
      !["wasmgc", "linear"].includes(view.backend) ||
      policy.target !== view.target ||
      policy.backend !== view.backend ||
      implementations.length !== 1 ||
      !same(implementations[0], provider) ||
      array(manifest.features).filter((feature) => feature === canonical.feature).length !== 1 ||
      !array(manifest.providerComponents).some((value) => {
        const row = record(value);
        return array(row.features).includes(canonical.feature) && array(row.providers).includes(provider.id);
      }) ||
      array(view.providers).some((value) => record(value).intrinsicId === canonical.feature)
    )
      return found;
  }
  for (const fn of input.module.functions) {
    const accepted = new Set<IrInstr>();
    const walk = (body: readonly IrInstr[], enclosing: ReadonlyMap<number, IrInstr>) => {
      const scope = new Map(enclosing);
      for (const operation of body) {
        if (
          operation.kind === "call" &&
          same(operation.target, canonical.ref) &&
          operation.args.length === 1 &&
          operation.result !== null &&
          same(operation.resultType, canonical.results[0])
        ) {
          const definition = scope.get(operation.args[0]!);
          if (
            definition?.kind === "const" &&
            definition.value.kind === "null" &&
            same(definition.value.ty, canonical.params[0]) &&
            same(definition.resultType, canonical.params[0])
          )
            accepted.add(operation);
        }
        forEachNestedBuffer(operation, (nested) => walk(nested, scope));
        if (operation.result !== null) scope.set(operation.result, operation);
      }
    };
    fn.blocks.forEach((block) => walk(block.instrs, new Map()));
    found.set(fn, accepted);
  }
  return found;
}

export function inputPopulation(input: Input): Population {
  assertPreparedIrData(input);
  fields(record(input), [
    "schema",
    "namespace",
    "module",
    "declarations",
    "units",
    "definitions",
    "globals",
    "startupUnits",
    "exports",
    "entryInputs",
    ...(Object.hasOwn(input, "runtimeContext") ? ["runtimeContext"] : []),
  ]);
  if (input.schema !== "native-js-class-value-domain-input-v1" || !["original", "selected"].includes(input.namespace))
    fail("input schema/namespace");
  fields(record(input.module), ["functions"]);
  array(input.module.functions);
  const actual = population(input.module, input.definitions.length, input.globals.length);
  dominance(input.module);
  const ids = new Set<string>();
  const targetIds = new Set<string>();
  for (const unit of input.units) {
    fields(record(unit), ["unitId", "kind", "sourceClassId", "sourceBodyKind", "target"]);
    if (ids.has(unit.unitId) || !actual.functions.has(unit.unitId)) fail("unit population/identity");
    ids.add(unit.unitId);
    const targetKey = refKey(unit.target);
    if (targetIds.has(targetKey)) fail("duplicate actual unit target binding");
    targetIds.add(targetKey);
    const fn = actual.functions.get(unit.unitId)!;
    if (fn.asyncPlan || fn.funcKind === "async" || fn.funcKind === "generator")
      fail("unrepresented async/generator population");
    if (
      !["source", "derived", "builtin"].includes(unit.kind) ||
      unit.target.kind !== "func" ||
      (unit.target.binding.kind === "unit" && unit.target.binding.unitId !== unit.unitId) ||
      (unit.kind !== "builtin" && unit.target.binding.kind !== "unit")
    )
      fail("actual unit target");
  }
  if (ids.size !== actual.functions.size) fail("incomplete function/unit census");
  const definitions = new Set<string>();
  for (const row of input.definitions) {
    fields(record(row), ["bindingId", "definition"]);
    if (definitions.has(row.bindingId)) fail("duplicate class definition");
    definitions.add(row.bindingId);
    if (row.definition.schema !== "native-js-class-definition-v1" || !ids.has(row.definition.evaluationOwnerUnitId))
      fail("definition evaluation owner");
    const ordinals = new Set<number>();
    for (const member of [...row.definition.members, ...row.definition.instanceElements]) {
      const ordinal = integer(member.sourceOrdinal);
      if (ordinals.has(ordinal)) fail("duplicate original class member/field ordinal");
      ordinals.add(ordinal);
    }
    if (row.definition.constructor.sourceBodyKind !== "constructor") fail("actual constructor body kind");
    if (row.definition.members.some((member) => member.body.sourceBodyKind !== "method"))
      fail("actual method body kind");
    if (
      row.definition.instanceElements.some(
        (field) => field.initializer && field.initializer.sourceBodyKind !== "field-initializer",
      )
    )
      fail("actual field initializer body kind");
    const bodyUnits = new Set<string>();
    const bodies = [
      row.definition.constructor,
      ...row.definition.members.map((member) => member.body),
      ...row.definition.instanceElements.flatMap((field) => (field.initializer ? [field.initializer] : [])),
    ];
    for (const body of bodies) {
      if (bodyUnits.has(body.unitId)) fail("duplicate actual class body unit");
      bodyUnits.add(body.unitId);
      const fn = unitTarget(input, body.target),
        unit = input.units.find((unit) => unit.unitId === body.unitId);
      if (
        !fn ||
        fn.unitId !== body.unitId ||
        !unit ||
        unit.sourceClassId !== row.definition.sourceClassId ||
        unit.sourceBodyKind !== body.sourceBodyKind
      )
        fail("actual original class body target/population");
      const provenance = fn.sourceClassBody;
      if (
        !provenance ||
        provenance.classId !== row.definition.sourceClassId ||
        provenance.sourceBodyKind !== body.sourceBodyKind ||
        provenance.lexicalOwnerId !== body.lexicalOwnerId ||
        provenance.terminalOwnerId !== body.terminalOwnerId ||
        provenance.ordinal !== body.ordinal
      )
        fail("genuine source class body provenance");
      const entry = fn.blocks[0]?.instrs[0];
      if (
        !entry ||
        entry.kind !== "js.class.frame.new" ||
        entry.definition !== row.bindingId ||
        entry.alloc === undefined ||
        !same(
          [entry.environment, entry.thisValue, entry.homeObject, entry.newTarget],
          fn.params.slice(0, 4).map((parameter) => parameter.value),
        )
      )
        fail("genuine original activation frame");
      if (fn.params.length !== body.params.length + 4 || fn.resultTypes.length !== (body.result === null ? 0 : 1))
        fail("class body hidden/user/result arity");
      const types = [
        body.frame.environmentType,
        body.frame.thisType,
        body.frame.homeObjectType,
        body.frame.newTargetType,
        ...body.params,
      ];
      if (
        !same(
          types,
          fn.params.map((parameter) => parameter.type),
        ) ||
        !same(body.result === null ? [] : [body.result], fn.resultTypes)
      )
        fail("class body actual ABI types");
    }
  }
  const globals = new Set<string>();
  for (const global of input.globals) {
    fields(record(global), ["ref", "type", "mutable", "initial"]);
    const key = identifier(global.ref.binding.bindingId);
    if (globals.has(key)) fail("duplicate global");
    globals.add(key);
    if (typeof global.mutable !== "boolean") fail("global mutability");
    const declared = input.declarations.globals.find((row) => row.key === irBindingKey(global.ref.binding));
    if (!declared || !same(declared.type, global.type)) fail("actual global/declaration type census");
    globalConstantType(global);
    if (global.initial.kind === "issued-builtin") {
      const fn = unitTarget(input, global.initial.target),
        unit = input.units.find((row) =>
          same(row.target, global.initial.kind === "issued-builtin" ? global.initial.target : null),
        );
      if (!fn || unit?.kind !== "builtin") fail("issued builtin requires actual populated builtin body");
    } else if (!["constant", "unknown", "uninitialized"].includes(global.initial.kind)) fail("global initialization");
  }
  fields(record(input.declarations), ["signatures", "globals"]);
  if (
    input.declarations.globals.length !== input.globals.length ||
    input.declarations.globals.some(
      (declared) => !input.globals.some((global) => irBindingKey(global.ref.binding) === declared.key),
    )
  )
    fail("complete global/declaration census");
  for (const rows of [input.declarations.signatures, input.declarations.globals]) {
    const keys = new Set<string>();
    for (const row of rows) {
      if (keys.has(row.key)) fail("duplicate declaration key");
      keys.add(identifier(row.key));
    }
  }
  knownOperationTypes(input, actual);
  const startup = new Set<string>();
  for (const unit of input.startupUnits) {
    if (!ids.has(unit) || startup.has(unit)) fail("startup unit absent/duplicate");
    startup.add(unit);
  }
  const exports = new Set<string>();
  for (const row of input.exports) {
    fields(record(row), ["externalName", "target", "logicalParams", "logicalResult"]);
    const fn = unitTarget(input, row.target);
    if (
      !fn ||
      exports.has(row.externalName) ||
      !same(
        row.logicalParams,
        fn.params.map((parameter) => parameter.type),
      ) ||
      !same(row.logicalResult === null ? [] : [row.logicalResult], fn.resultTypes)
    )
      fail("actual export target/signature");
    exports.add(row.externalName);
  }
  const parameters = new Set<string>();
  for (const row of input.entryInputs) {
    fields(record(row), ["unitId", "parameter", "transport", "type"]);
    const fn = actual.functions.get(row.unitId),
      index = integer(row.parameter),
      key = `${row.unitId}:${index}`;
    if (
      !fn ||
      !fn.params[index] ||
      parameters.has(key) ||
      !same(fn.params[index]!.type, row.type) ||
      !["external-js", "scalar-ir"].includes(row.transport)
    )
      fail("entry input actual transport/parameter");
    if (!input.exports.some((row) => unitTarget(input, row.target)?.unitId === fn.unitId))
      fail("nonexport entry transport");
    if (row.transport === "scalar-ir") fail("pure entry DATA has no scalar transport authority");
    parameters.add(key);
  }
  for (const row of input.exports) {
    const fn = unitTarget(input, row.target)!;
    for (let index = 0; index < fn.params.length; index++)
      if (!parameters.has(`${fn.unitId}:${index}`)) fail("incomplete public entry transport census");
  }
  return { ...actual, nativeReferenceCalls: referenceAllocatorOccurrences(input) };
}
function actualValueTypes(fn: IrFunction): Map<number, IrType> {
  const table = new Map<number, IrType>(fn.params.map((parameter) => [parameter.value, parameter.type]));
  for (const block of fn.blocks) {
    for (const [index, value] of block.blockArgs.entries()) table.set(value, block.blockArgTypes[index]!);
    const visit = (items: readonly IrInstr[]) => {
      for (const item of items) {
        if (item.result !== null && item.resultType) table.set(item.result, item.resultType);
        forEachNestedBuffer(item, visit);
      }
    };
    visit(block.instrs);
  }
  return table;
}
function scalarKind(type: IrType | undefined): string | undefined {
  return type?.kind === "val" ? type.val.kind : undefined;
}
function valueTypeFits(actual: IrType | undefined | null, expected: IrType | undefined | null): boolean {
  if (same(actual, expected)) return true;
  return actual?.kind === "dynamic" && expected?.kind === "dynamic" && expected.tag === undefined;
}
function returnTypes(fn: IrFunction, types: ReadonlyMap<number, IrType>): void {
  for (const block of fn.blocks) {
    const end = block.terminator,
      branches = end.kind === "br" ? [end.branch] : end.kind === "br_if" ? [end.ifTrue, end.ifFalse] : [];
    for (const branch of branches) {
      const target = fn.blocks.find((candidate) => candidate.id === branch.target);
      if (!target || branch.args.length !== target.blockArgTypes.length) fail("actual typed CFG target/arity");
      for (const [index, value] of branch.args.entries())
        if (!valueTypeFits(types.get(value), target.blockArgTypes[index])) fail("actual typed CFG argument");
    }
    if (block.terminator.kind === "return")
      for (const [index, value] of block.terminator.values.entries())
        if (!valueTypeFits(types.get(value), fn.resultTypes[index])) fail("actual function return type");
    const visit = (items: readonly IrInstr[]) => {
      for (const item of items) {
        if (item.kind === "early.return") {
          if (item.value === null) {
            if (fn.resultTypes.length) fail("slotless return in value function");
          } else if (fn.resultTypes.length !== 1 || !valueTypeFits(types.get(item.value), fn.resultTypes[0]))
            fail("actual early return type");
        }
        forEachNestedBuffer(item, visit);
      }
    };
    visit(block.instrs);
  }
}
const BINARY_OPCODES = {
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
} satisfies Record<IrBinop, true>;

const UNARY_OPCODES = {
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
} satisfies Record<IrUnop, true>;

function knownOperationTypes(input: Input, population: Population): void {
  const tables = new Map(input.module.functions.map((fn) => [fn.unitId, actualValueTypes(fn)]));
  for (const fn of input.module.functions) {
    const owner = input.units.find((unit) => unit.unitId === fn.unitId)!,
      declared = input.declarations.signatures.find((row) => row.key === irBindingKey(owner.target.binding))?.signature;
    if (
      declared &&
      (!same(
        declared.params,
        fn.params.map((parameter) => parameter.type),
      ) ||
        !same(declared.result === null ? [] : [declared.result], fn.resultTypes))
    )
      fail("actual callable declaration/body types");
    returnTypes(fn, tables.get(fn.unitId)!);
    const indices = new Set<number>();
    for (const slot of fn.slots ?? []) {
      fields(record(slot), ["index", "name", "type"]);
      const index = integer(slot.index);
      if (indices.has(index) || index >= (fn.slots?.length ?? 0)) fail("actual slot index census");
      indices.add(index);
    }
  }
  for (const { fn, instruction: item } of population.occurrences) {
    const types = tables.get(fn.unitId)!,
      output = item.resultType;
    if (item.kind === "const" && ["i32", "f32", "f64"].includes(item.value.kind)) {
      if (scalarKind(output ?? undefined) !== item.value.kind) fail("numeric constant actual result type");
      if (
        output?.kind === "val" &&
        output.val.kind === "i32" &&
        "boolean" in output.val &&
        output.val.boolean === true &&
        item.value.kind === "i32" &&
        ![0, 1].includes(item.value.value)
      )
        fail("Boolean constant payload");
    }
    if (item.kind === "const" && item.value.kind === "bool") {
      if (typeof item.value.value !== "boolean" || scalarKind(output ?? undefined) !== "i32")
        fail("Boolean constant actual carrier");
    }
    if (item.kind === "const" && (item.value.kind === "undefined" || item.value.kind === "null")) {
      if (["i32", "i64", "f32", "f64"].includes(scalarKind(output ?? undefined) ?? ""))
        fail("nullish constant cannot establish numeric carrier");
    }
    if (item.kind === "binary" || item.kind === "unary") {
      if (!Object.hasOwn(item.kind === "binary" ? BINARY_OPCODES : UNARY_OPCODES, item.op))
        fail("unknown numeric opcode vocabulary");
      const operandIds = item.kind === "binary" ? [item.lhs, item.rhs] : [item.rand],
        prefix = item.op.split(".")[0]!;
      let inputKind = prefix;
      const conversion = /\.(?:convert|trunc|trunc_sat|reinterpret|promote|demote|wrap)_(i32|i64|f32|f64)/.exec(
        item.op,
      );
      if (conversion) inputKind = conversion[1]!;
      if (prefix === "js") {
        if (operandIds.some((value) => !["i32", "f64"].includes(scalarKind(types.get(value)) ?? "")))
          fail("JavaScript bit operation actual operand carrier");
        for (const value of operandIds) {
          const actual = types.get(value);
          if (
            actual?.kind === "val" &&
            actual.val.kind === "i32" &&
            "symbol" in actual.val &&
            actual.val.symbol === true
          )
            fail("JavaScript bit operation cannot coerce Symbol handle");
        }
        if (!["i32", "f64"].includes(scalarKind(output ?? undefined) ?? ""))
          fail("JavaScript bit operation actual result carrier");
        if (
          output?.kind === "val" &&
          output.val.kind === "i32" &&
          "boolean" in output.val &&
          output.val.boolean === true
        )
          fail("JavaScript bit operation cannot brand its numeric result Boolean");
        if (output?.kind === "val" && output.val.kind === "i32" && "symbol" in output.val && output.val.symbol === true)
          fail("JavaScript bit operation cannot brand its numeric result Symbol");
      }
      if (item.op === "ref.is_null") {
        const actual = types.get(operandIds[0]!);
        if (
          actual?.kind !== "support-ref" &&
          !["ref", "ref_null", "externref", "funcref", "ref_extern", "eqref", "anyref"].includes(
            scalarKind(actual) ?? "",
          )
        )
          fail("reference null test actual operand carrier");
        if (scalarKind(output ?? undefined) !== "i32") fail("reference null test actual result carrier");
      }
      if (["i32", "i64", "f32", "f64"].includes(prefix)) {
        for (const value of operandIds)
          if (scalarKind(types.get(value)) !== inputKind) fail("numeric operation actual operand type");
        const expected = /\.(eq|ne|lt|le|gt|ge|lt_s|lt_u|le_s|le_u|gt_s|gt_u|ge_s|ge_u|eqz)$/.test(item.op)
          ? "i32"
          : prefix;
        if (scalarKind(output ?? undefined) !== expected) fail("numeric operation actual result type");
      }
    }
    if (item.kind === "call") {
      const key = irBindingKey(item.target.binding),
        declared = input.declarations.signatures.find((row) => row.key === key)?.signature;
      if (
        declared &&
        (declared.params.length !== item.args.length ||
          declared.params.some((type, index) => !valueTypeFits(types.get(item.args[index]!), type)) ||
          !same(declared.result, output))
      )
        fail("call actual declaration types");
    }
    if (item.kind === "if") {
      if (!valueTypeFits(types.get(item.thenValue), output) || !valueTypeFits(types.get(item.elseValue), output))
        fail("actual conditional arm/result types");
    }
    if (item.kind === "box") {
      if (item.toType.kind !== "dynamic" || !same(item.resultType, item.toType)) fail("box actual result carrier");
      const actual = types.get(item.value),
        tag = item.toType.tag;
      const expected =
        tag === JS_TAG_IDS.NumberF64
          ? "f64"
          : tag === JS_TAG_IDS.NumberI32 || tag === JS_TAG_IDS.Boolean
            ? "i32"
            : undefined;
      if (expected && scalarKind(actual) !== expected) fail("box actual payload type");
      if (
        tag === JS_TAG_IDS.Boolean &&
        !(actual?.kind === "val" && actual.val.kind === "i32" && "boolean" in actual.val && actual.val.boolean === true)
      )
        fail("box genuine Boolean brand");
    }
    if (item.kind === "unbox") {
      const expected =
        item.tagId === JS_TAG_IDS.NumberF64
          ? "f64"
          : item.tagId === JS_TAG_IDS.NumberI32 || item.tagId === JS_TAG_IDS.Boolean
            ? "i32"
            : undefined;
      if (expected && scalarKind(output ?? undefined) !== expected) fail("unbox actual result type");
    }
    if (item.kind === "slot.read" || item.kind === "slot.write") {
      const slot = fn.slots?.find((candidate) => candidate.index === integer(item.slotIndex)),
        actual = item.kind === "slot.read" ? output : types.get(item.value);
      if (!slot || actual?.kind !== "val" || !same(actual.val, slot.type)) fail("actual slot operand/result type");
    }
    if (item.kind === "global.get" || item.kind === "global.set") {
      const key = irBindingKey(item.target.binding),
        declared = input.declarations.globals.find((row) => row.key === key)?.type;
      if (declared && !same(declared, item.kind === "global.get" ? output : types.get(item.value)))
        fail("global actual declaration type");
    }
  }
}

function globalConstantType(global: Input["globals"][number]): void {
  if (global.initial.kind !== "constant") return;
  const value = global.initial.value;
  // This input records logical JS instantiation, so Undefined remains genuine
  // even for an annotated scalar slot. Other closed-family contradictions fail.
  const type = global.type;
  if (["bool", "i32", "i64", "f32", "f64"].includes(value.kind) && type.kind !== "val" && type.kind !== "dynamic")
    fail("scalar constant on managed global carrier");
  if (
    type.kind === "dynamic" &&
    type.tag !== undefined &&
    ((value.kind === "undefined" && type.tag !== JS_TAG_IDS.Undefined) ||
      (value.kind === "null" && type.tag !== JS_TAG_IDS.Null))
  )
    fail("actual nullish global exact tag");
  if (value.kind === "undefined" || value.kind === "null") return;
  if (
    type.kind === "val" &&
    ["i32", "i64", "f32", "f64"].includes(type.val.kind) &&
    value.kind !== type.val.kind &&
    !(value.kind === "bool" && type.val.kind === "i32")
  )
    fail("actual constant global payload width");
  const expected =
    type.kind === "val"
      ? type.val.kind === "i32" && "boolean" in type.val && type.val.boolean === true
        ? "Boolean"
        : ["f64", "f32", "i32"].includes(type.val.kind)
          ? "Number"
          : undefined
      : type.kind === "dynamic"
        ? type.tag === JS_TAG_IDS.Boolean
          ? "Boolean"
          : type.tag === JS_TAG_IDS.NumberF64 || type.tag === JS_TAG_IDS.NumberI32
            ? "Number"
            : type.tag === JS_TAG_IDS.String
              ? "String"
              : type.tag === JS_TAG_IDS.Object
                ? "Object"
                : type.tag === JS_TAG_IDS.Function
                  ? "Function"
                  : undefined
        : undefined;
  const actual =
    value.kind === "i32" &&
    type.kind === "val" &&
    type.val.kind === "i32" &&
    "boolean" in type.val &&
    type.val.boolean === true &&
    [0, 1].includes(value.value)
      ? "Boolean"
      : value.kind === "bool"
        ? "Boolean"
        : ["f64", "f32", "i32"].includes(value.kind)
          ? "Number"
          : undefined;
  if (expected && actual && expected !== actual) fail("actual constant global family/type contradiction");
  if (
    type.kind === "dynamic" &&
    ((type.tag === JS_TAG_IDS.NumberF64 && value.kind !== "f64") ||
      (type.tag === JS_TAG_IDS.NumberI32 && value.kind !== "i32"))
  )
    fail("actual constant global exact tag");
}
