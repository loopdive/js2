// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { TypeDef, FuncTypeDef, Import, TagDef } from "../model/module-records.js";

export interface ExceptionTagResources {
  readonly types: readonly TypeDef[];
  readonly imports: readonly Import[];
  readonly tags: TagDef[];
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
