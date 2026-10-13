// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFunction, IrInstr, AllocSiteId } from "../core/nodes.js";
import type { LinearRuntimeOperation } from "../analysis/contracts/linear-memory-layout.js";
import type { TypeDef, FuncTypeDef, Import, TagDef } from "../../wasm/model/module-records.js";

interface ExceptionTagResources {
  readonly types: readonly TypeDef[];
  readonly imports: readonly Import[];
  readonly tags: TagDef[];
}

/**
 * Backend resources required by one already-built linear IR module.
 *
 * The names are runtime bindings, while operations/layouts/data segments stay
 * symbolic. This is deliberately a demand projection: it never assigns a
 * final linear address or discovers a new source/runtime intent.
 */
export interface LinearBackendResourceDemand {
  readonly runtimeFunctions: readonly string[];
  readonly runtimeOperations: readonly LinearRuntimeOperation[];
  readonly allocationSites: readonly AllocSiteId[];
  readonly layoutIds: readonly string[];
  readonly dataSegmentIds: readonly string[];
}

interface BodyBatchResourcePorts {
  validateDemand(demand: LinearBackendResourceDemand): void;
  resolveRuntimeOperation(operation: LinearRuntimeOperation): number;
  internFunctionType(signature: FuncTypeDef): number;
  forEachInstruction(fn: IrFunction, visit: (instr: IrInstr) => void): void;
}

/** Complete resource preflight before any frozen body consumer runs. */
export function preflightLinearBodyBatchResources(
  module: { readonly functions: readonly IrFunction[] },
  resources: ExceptionTagResources,
  demand: LinearBackendResourceDemand,
  ports: BodyBatchResourcePorts,
): void {
  ports.validateDemand(demand);
  for (const operation of demand.runtimeOperations) {
    if (operation.family === "vector" && operation.operation === "resolve-forwarding")
      ports.resolveRuntimeOperation(operation);
  }
  let needsExceptionTag = false;
  for (const fn of module.functions) {
    ports.forEachInstruction(fn, (instr) => {
      if (instr.kind === "try" || instr.kind === "throw") needsExceptionTag = true;
    });
  }
  if (needsExceptionTag) reserveLinearBodyBatchExceptionTag(resources, ports.internFunctionType);
}

const reservations = new WeakMap<object, () => number>();
const tagName = "__linear_ir_exn";

function importedTagCount(module: ExceptionTagResources): number {
  return module.imports.filter((entry) => entry.desc.kind === "tag").length;
}

function isOpaqueExceptionType(type: TypeDef | undefined): type is FuncTypeDef {
  return (
    type?.kind === "func" &&
    type.params.length === 1 &&
    type.params[0]!.kind === "externref" &&
    type.results.length === 0
  );
}

function hasDirectTypeCoordinate(module: ExceptionTagResources, typeIndex: number): boolean {
  return !module.types.slice(0, typeIndex).some((type) => type.kind === "rec");
}

/** Reserve the real tag before body emission; repeated preflights reuse its identity. */
export function reserveLinearBodyBatchExceptionTag(
  module: ExceptionTagResources,
  internFunctionType: (signature: FuncTypeDef) => number,
): void {
  const previous = reservations.get(module);
  if (previous) {
    previous();
    return;
  }
  if (module.tags.some((tag) => tag.name === tagName)) {
    throw new Error("linear-ir: exception tag name is already occupied by an unreserved resource");
  }
  const typeIdx = internFunctionType({ kind: "func", params: [{ kind: "externref" }], results: [] });
  const type = module.types[typeIdx];
  if (!Number.isInteger(typeIdx) || typeIdx < 0 || !isOpaqueExceptionType(type)) {
    throw new Error("linear-ir: exception tag requires the actual (externref)->() type");
  }
  if (!hasDirectTypeCoordinate(module, typeIdx)) {
    throw new Error("linear-ir: exception tag interner requires direct physical type coordinates");
  }
  const tag: TagDef = { name: tagName, typeIdx };
  const localIndex = module.tags.length;
  const imports = importedTagCount(module);
  module.tags.push(tag);
  reservations.set(module, () => {
    if (
      module.tags[localIndex] !== tag ||
      tag.typeIdx !== typeIdx ||
      module.types[typeIdx] !== type ||
      !isOpaqueExceptionType(type) ||
      !hasDirectTypeCoordinate(module, typeIdx) ||
      importedTagCount(module) !== imports
    ) {
      throw new Error("linear-ir: reserved exception tag resources changed before body emission");
    }
    return imports + localIndex;
  });
}

/** Resolve only an authentic preflight reservation; never allocate during emission. */
export function readLinearBodyBatchExceptionTag(module: ExceptionTagResources): number {
  const read = reservations.get(module);
  if (!read) throw new Error("linear-ir: exception tag was not reserved before body emission");
  return read();
}
