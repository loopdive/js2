// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Stage 4 of the Prepared validator (#7380): the invariants of the physical module storage a binary is emitted from.
// Every index an instruction, type, import, export or start names must resolve, with the right resource kind. The
// completion ledger (`module-reservations.ts`) runs the same checks incrementally at reserve, fill and seal time;
// `assertPhysicalModule` runs them once over the finished module, so a defect introduced after a fill is still seen.
// The functions are stateless and read only the storage they are given.

import type { FuncHandle, Instr, ValType } from "../model/instructions.js";
import type { TypeDef, FuncTypeDef, ImportDesc, WasmExport } from "../model/module-records.js";
import type { PhysicalModuleStorage } from "./module-reservations.js";
import { STABLE_FUNC_BASE } from "./function-handles.js";
import { indexPhysicalTypes, planPhysicalTypeSection } from "./type-layout.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-program-errors.js";

type FlatType = Exclude<TypeDef, { kind: "rec" }>;

/** Abstract heap immediates of the reference casts and `ref.null` are not module type indices. */
const ABSTRACT_HEAP_OPS = new Set(["ref.cast", "ref.cast_null", "ref.test", "ref.null"]);
const ABSTRACT_HEAP_TYPES = new Set([-16, -17, -18, -19, -20, -21, -22, -23, -24, -25]);

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
}

function checkIndex(index: number, count: number, kind: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) fail(`unresolved ${kind} index ${index}`);
}

function importCount(module: PhysicalModuleStorage, kind: ImportDesc["kind"]): number {
  return module.imports.filter((record) => record.desc.kind === kind).length;
}

/** Wasm rec wrappers occupy no index; each subtype/member occupies one. */
function flatTypes(types: readonly TypeDef[]): FlatType[] {
  return indexPhysicalTypes(types).entries.map((entry) => entry.definition);
}

export function physicalType(module: PhysicalModuleStorage, index: number): Exclude<FlatType, { kind: "sub" }> {
  const flat = flatTypes(module.types);
  checkIndex(index, flat.length, "type");
  const type = flat[index]!;
  return type.kind === "sub" ? type.type : type;
}

function physicalFunctionType(module: PhysicalModuleStorage, index: number): FuncTypeDef {
  const type = physicalType(module, index);
  if (type.kind !== "func") fail(`type ${index} is not a function signature`);
  return type;
}

export function assertPhysicalValue(module: PhysicalModuleStorage, value: ValType): void {
  if (value.kind === "ref" || value.kind === "ref_null") physicalType(module, value.typeIdx);
}

/** Match emitted finality, including implicit final plain types and rec/sub wrappers. */
export function assertPhysicalFinalParents(types: readonly TypeDef[]): void {
  const entries = indexPhysicalTypes(types).entries;
  for (const { definition } of entries) {
    const parentIndex =
      definition.kind === "sub"
        ? definition.superType
        : definition.kind === "struct"
          ? definition.superTypeIdx
          : undefined;
    if (parentIndex === undefined || parentIndex === null || parentIndex === -1) continue;
    const parent = entries[parentIndex]?.definition;
    // Forward coordinates may still be unresolved during reservation; the resource check rejects them.
    if (!parent) continue;
    const final =
      parent.kind === "sub"
        ? !!parent.final
        : parent.kind === "struct"
          ? parent.superTypeIdx === undefined || !!parent.final
          : true;
    if (final) fail(`cannot extend final parent type ${parentIndex}`);
  }
}

function assertType(module: PhysicalModuleStorage, type: TypeDef): void {
  switch (type.kind) {
    case "func":
      for (const value of [...type.params, ...type.results]) assertPhysicalValue(module, value);
      break;
    case "struct":
      if (
        type.superTypeIdx !== undefined &&
        type.superTypeIdx !== -1 &&
        physicalType(module, type.superTypeIdx).kind !== "struct"
      )
        fail("struct parent is not a struct");
      for (const field of type.fields) assertPhysicalValue(module, field.type);
      break;
    case "array":
      assertPhysicalValue(module, type.element);
      break;
    case "rec":
      for (const member of type.types) assertType(module, member);
      break;
    case "sub":
      if (type.superType !== null) physicalType(module, type.superType);
      assertType(module, type.type);
      break;
  }
}

function assertCanonicalGroup(module: PhysicalModuleStorage): void {
  const group = module.canonicalRuntimeRecGroup;
  if (group === undefined) return;
  const count = flatTypes(module.types).length;
  checkIndex(group.start, count, "canonical rec-group start");
  checkIndex(group.end, count, "canonical rec-group end");
  if (group.end < group.start || !Number.isInteger(group.abiVersion) || group.abiVersion < 1)
    fail("invalid canonical runtime rec-group descriptor");
  planPhysicalTypeSection(indexPhysicalTypes(module.types), [[group.start, group.end]]);
}

/** Every type, import, function, global, tag, table, memory and data declaration resolves. */
export function assertPhysicalResources(module: PhysicalModuleStorage): void {
  assertCanonicalGroup(module);
  assertPhysicalFinalParents(module.types);
  for (const type of module.types) assertType(module, type);
  planPhysicalTypeSection(indexPhysicalTypes(module.types));
  for (const imp of module.imports) {
    if (imp.desc.kind === "func" || imp.desc.kind === "tag") {
      const signature = physicalFunctionType(module, imp.desc.typeIdx);
      if (imp.desc.kind === "tag" && signature.results.length) fail("tag import has results");
    } else if (imp.desc.kind === "global") assertPhysicalValue(module, imp.desc.type);
  }
  for (const fn of module.functions) physicalFunctionType(module, fn.typeIdx);
  for (const global of module.globals) assertPhysicalValue(module, global.type);
  for (const tag of module.tags) if (physicalFunctionType(module, tag.typeIdx).results.length) fail("tag has results");
  const positions = new Set<number>();
  for (const position of module.funcOrdinalToPosition) {
    checkIndex(position, module.functions.length, "function ordinal");
    if (positions.has(position)) fail("duplicate function ordinal position");
    positions.add(position);
  }
  if (positions.size !== module.functions.length) fail("function lacks minted ordinal");
  if (module.functions.length + importCount(module, "func") >= STABLE_FUNC_BASE)
    fail("physical function space overlaps stable handles");
  for (const descriptor of [...module.tables, ...module.memories]) {
    if (
      !Number.isInteger(descriptor.min) ||
      descriptor.min < 0 ||
      (descriptor.max !== undefined && (!Number.isInteger(descriptor.max) || descriptor.max < descriptor.min))
    )
      fail("invalid table/memory limits");
  }
  for (const data of module.dataSegments) {
    if (!data.passive) {
      checkIndex(0, module.memories.length + importCount(module, "memory"), "active data memory");
      if (!Number.isInteger(data.offset) || data.offset < 0) fail("invalid active data offset");
    }
  }
}

function functionIndex(module: PhysicalModuleStorage, handle: FuncHandle): number {
  if (handle >= STABLE_FUNC_BASE) {
    const position = module.funcOrdinalToPosition[handle - STABLE_FUNC_BASE];
    if (position === undefined) fail(`unresolved function handle ${handle}`);
    checkIndex(position, module.functions.length, "defined function");
    return importCount(module, "func") + position;
  }
  checkIndex(handle, importCount(module, "func") + module.functions.length, "function");
  return handle;
}

/** Every index an instruction names resolves to a resource of the kind the opcode needs. */
export function assertPhysicalInstructions(
  module: PhysicalModuleStorage,
  body: readonly Instr[],
  refTargets?: Set<number>,
): void {
  for (const instr of body) {
    if ("funcIdx" in instr) {
      const index = functionIndex(module, instr.funcIdx);
      if (instr.op === "ref.func") refTargets?.add(index);
    }
    if ("typeIdx" in instr && !(ABSTRACT_HEAP_OPS.has(instr.op) && ABSTRACT_HEAP_TYPES.has(instr.typeIdx))) {
      const type = physicalType(module, instr.typeIdx);
      if (
        (instr.op.startsWith("struct.") && type.kind !== "struct") ||
        (instr.op.startsWith("array.") && type.kind !== "array")
      )
        fail(`wrong resource kind for ${instr.op}`);
      if (instr.op === "call_indirect" || instr.op === "call_ref" || instr.op === "return_call_ref")
        physicalFunctionType(module, instr.typeIdx);
      if ("fieldIdx" in instr && type.kind === "struct") checkIndex(instr.fieldIdx, type.fields.length, "struct field");
    }
    if (instr.op === "array.copy") {
      if (
        physicalType(module, instr.dstTypeIdx).kind !== "array" ||
        physicalType(module, instr.srcTypeIdx).kind !== "array"
      )
        fail("array.copy requires array types");
    }
    if (instr.op === "global.get" || instr.op === "global.set")
      checkIndex(instr.index, importCount(module, "global") + module.globals.length, "global");
    if ("tableIdx" in instr) checkIndex(instr.tableIdx, importCount(module, "table") + module.tables.length, "table");
    if ("tagIdx" in instr) checkIndex(instr.tagIdx, importCount(module, "tag") + module.tags.length, "tag");
    if ("dataIdx" in instr) checkIndex(instr.dataIdx, module.dataSegments.length, "data segment");
    if (instr.op.startsWith("memory.") || "align" in instr)
      checkIndex(0, importCount(module, "memory") + module.memories.length, "memory");
    if ("blockType" in instr) {
      if (instr.blockType.kind === "val") assertPhysicalValue(module, instr.blockType.type);
      if (instr.blockType.kind === "type") physicalFunctionType(module, instr.blockType.typeIdx);
    }
    if ("body" in instr) assertPhysicalInstructions(module, instr.body, refTargets);
    if (instr.op === "if") {
      assertPhysicalInstructions(module, instr.then, refTargets);
      if (instr.else) assertPhysicalInstructions(module, instr.else, refTargets);
    }
    if (instr.op === "try" || instr.op === "try_table") {
      for (const clause of instr.catches) {
        if (clause.tagIdx !== undefined)
          checkIndex(clause.tagIdx, importCount(module, "tag") + module.tags.length, "catch tag");
        else if ("kind" in clause && (clause.kind === "catch" || clause.kind === "catch_ref"))
          fail("tagged catch has no tag");
        if ("body" in clause) assertPhysicalInstructions(module, clause.body, refTargets);
      }
      if (instr.op === "try" && instr.catchAll) assertPhysicalInstructions(module, instr.catchAll, refTargets);
    }
  }
}

/** Every `ref.func` in a function body names a function an element, global, export or declaration publishes. */
export function assertDeclaredFunctionReferences(module: PhysicalModuleStorage): void {
  const declared = new Set<number>();
  for (const handle of module.declaredFuncRefs) declared.add(functionIndex(module, handle));
  for (const element of module.elements) {
    for (const handle of element.funcIndices) declared.add(functionIndex(module, handle));
    assertPhysicalInstructions(module, element.offset, declared);
  }
  for (const global of module.globals) assertPhysicalInstructions(module, global.init, declared);
  for (const exported of module.exports) {
    if (exported.desc.kind === "func") declared.add(functionIndex(module, exported.desc.index));
  }
  // Startup alone and other function bodies are not declaration routes (the #4257 emitter contract).
  for (const fn of module.functions) {
    const used = new Set<number>();
    assertPhysicalInstructions(module, fn.body, used);
    for (const index of used) if (!declared.has(index)) fail(`undeclared ref.func target ${index} in ${fn.name}`);
  }
}

function assertExports(module: PhysicalModuleStorage): void {
  const spaces: Record<WasmExport["desc"]["kind"], number> = {
    func: importCount(module, "func") + module.functions.length,
    global: importCount(module, "global") + module.globals.length,
    tag: importCount(module, "tag") + module.tags.length,
    table: importCount(module, "table") + module.tables.length,
    memory: importCount(module, "memory") + module.memories.length,
  };
  const names = new Set<string>();
  for (const { name, desc } of module.exports) {
    claimExportName(names, name);
    checkIndex(desc.index, spaces[desc.kind], `${desc.kind} export`);
  }
}

/** Export names are unique: `name` joins `names` unless it is already there. */
export function claimExportName(names: Set<string>, name: string): void {
  if (names.has(name)) fail(`duplicate export name ${name}`);
  names.add(name);
}

/** The start function takes and returns nothing. */
export function assertStartSignature(module: PhysicalModuleStorage, typeIdx: number): void {
  const signature = physicalFunctionType(module, typeIdx);
  if (signature.params.length || signature.results.length) fail("start function must have signature () -> ()");
}

function assertStart(module: PhysicalModuleStorage): void {
  if (module.startFuncIdx === undefined) return;
  const index = functionIndex(module, module.startFuncIdx);
  const imports = module.imports.filter((record) => record.desc.kind === "func");
  assertStartSignature(
    module,
    index < imports.length
      ? (imports[index]!.desc as Extract<ImportDesc, { kind: "func" }>).typeIdx
      : module.functions[index - imports.length]!.typeIdx,
  );
}

/** Stage 4 entry: the finished module's every index resolves; exports are unique; the start function is `() -> ()`. */
export function assertPhysicalModule(module: PhysicalModuleStorage): void {
  assertPhysicalResources(module);
  for (const fn of module.functions) {
    for (const local of fn.locals) assertPhysicalValue(module, local.type);
  }
  assertDeclaredFunctionReferences(module);
  assertExports(module);
  assertStart(module);
}
