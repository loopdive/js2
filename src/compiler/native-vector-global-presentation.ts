import type { ExportSignature } from "../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import { nativeModuleVectorType } from "../ir/native-module-vector-source.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import { emittedProgramBindingIndex, emittedNativeVectorLayouts } from "../ir/program-consumer.js";
import type { PreparedIrProgram, EmittedPreparedIrProgram, PreparedIrBackendOptions } from "../ir/program.js";
import type { IrType } from "../ir/core/types.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
export interface GlobalCapture {
  sourceFile: string;
  start: number;
  end: number;
  name: string;
  numeric: boolean;
  vector?: Extract<IrType, { kind: "vec" }>;
}
export function captureVectorGlobal(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
  source: ts.SourceFile,
  enabled: boolean,
): GlobalCapture {
  if (!ts.isIdentifier(declaration.name))
    throw new Error("native global presentation requires original identifier declaration");
  return {
    sourceFile: source.fileName,
    start: declaration.getStart(source),
    end: declaration.end,
    name: declaration.name.text,
    numeric: (checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.NumberLike) !== 0,
    ...(enabled ? { vector: nativeModuleVectorType(checker, declaration) } : {}),
  };
}
export function checkNativeGlobalPresentation(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  bindingId: IrBindingId,
  type: Extract<IrType, { kind: "vec" }>,
  globals: readonly GlobalCapture[],
  backend: PreparedIrBackendOptions["backend"],
): boolean {
  const mod = emission.module;
  const owners = program.startup.flatMap((row) =>
    row.bindings.filter((binding) => binding.globalBindingId === bindingId).map((binding) => ({ row, binding })),
  );
  const owner = owners.length === 1 ? owners[0] : undefined;
  const source = owner && program.inventory.sources.find((row) => row.id === owner.row.sourceId);
  const witnesses = globals.filter(
    (row) =>
      row.sourceFile === source?.originalFileName &&
      row.start === owner?.binding.start &&
      row.end === owner?.binding.end &&
      owner?.binding.names.length === 1 &&
      row.name === owner.binding.names[0] &&
      row.vector &&
      preparedIrDataMismatch(row.vector, type) === undefined,
  );
  const slot = emittedProgramBindingIndex(emission, bindingId);
  const physical =
    slot?.space === "global"
      ? mod.globals[slot.index - mod.imports.filter((row) => row.desc.kind === "global").length]
      : undefined;
  const layout =
    backend === "wasmgc"
      ? emittedNativeVectorLayouts(emission).find((row) => row.elementValType.kind === "f64")
      : undefined;
  if (
    !owner ||
    witnesses.length !== 1 ||
    !physical ||
    !physical.mutable ||
    (backend === "linear"
      ? physical.type.kind !== "i32"
      : physical.type.kind !== "ref_null" || physical.type.typeIdx !== layout?.vecStructTypeIdx)
  )
    return false;
  return true;
}

export function booleanExportSignature(declaration: {
  readonly params: readonly unknown[];
  readonly results: readonly unknown[];
}): ExportSignature | undefined {
  if (![...declaration.params, ...declaration.results].some((slot) => slot === "boolean" || slot === "promise"))
    return undefined;
  const signature: ExportSignature = {
    params: declaration.params.map((slot) => (slot === "boolean" ? "boolean" : "other")),
    result:
      declaration.results[0] === "promise" ? "promise" : declaration.results[0] === "boolean" ? "boolean" : "other",
  };
  Object.freeze(signature.params);
  return Object.freeze(signature);
}
