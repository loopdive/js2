// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { absoluteFuncIndex } from "../emit/resolve-layout.js";
import { emittedStartupAdapterIndex, emittedProgramBindingIndex } from "../ir/program-consumer.js";
import type { PreparedIrProgram, EmittedPreparedIrProgram } from "../ir/program.js";
import type { IrWholeProgramPreparationInput } from "../ir/program-preparation.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrProgramPresentationGap } from "./ir-program-presentation.js";

type GapRecorder = (
  field: string,
  code: string,
  detail: string,
  association?: Partial<IrProgramPresentationGap>,
) => void;

export type IrProgramPresentationStartup =
  | { readonly kind: "none"; readonly hasTopLevelStatements: false }
  | {
      readonly kind: "wasm-start";
      readonly hasTopLevelStatements: true;
      readonly adapterIndex: number;
      readonly unitIds: readonly IrUnitId[];
    }
  | {
      readonly kind: "deferred-export";
      readonly hasTopLevelStatements: true;
      readonly adapterIndex: number;
      readonly unitIds: readonly IrUnitId[];
      readonly exportName: "__module_init";
    }
  | {
      readonly kind: "wasi-start-export";
      readonly hasTopLevelStatements: true;
      readonly adapterIndex: number;
      readonly unitIds: readonly IrUnitId[];
      readonly exportName: "_start";
    };
export function joinPreparedStartup(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  input: IrWholeProgramPreparationInput,
  gap: GapRecorder,
): IrProgramPresentationStartup {
  const mod = emission.module;
  const functionImports = mod.imports.filter((row) => row.desc.kind === "func").length;
  const executable = program.startup.filter((row) => row.executable);
  if (
    program.startup.length !== program.inventory.sources.length ||
    program.startup.some(
      (row, index) =>
        row.sourceId !== program.inventory.sources[index]?.id ||
        row.gaps.length ||
        row.invocation.target !== input.policy.target ||
        row.executable !== (row.evaluations.length > 0 || row.liveSeeds.length > 0),
    )
  )
    gap(
      "startup",
      "startup-census",
      "source order, executable evaluations and startup policy must be complete and consistent",
    );
  const adapterIndex = emittedStartupAdapterIndex(emission);
  let startup: IrProgramPresentationStartup = Object.freeze({ kind: "none", hasTopLevelStatements: false });
  if (executable.length === 0) {
    if (
      adapterIndex !== undefined ||
      mod.startFuncIdx !== undefined ||
      program.startup.some((row) => row.invocation.kind !== "none")
    )
      gap(
        "startup",
        "unexpected-startup",
        "zero executable demand must have no authenticated startup adapter or Wasm start",
      );
  } else {
    const unitIds = Object.freeze(executable.flatMap((row) => (row.unitId ? [row.unitId] : [])));
    if (adapterIndex !== undefined) {
      const adapter = mod.functions[adapterIndex - functionImports];
      const signature = adapter && mod.types[adapter.typeIdx];
      const slots = unitIds.map((unitId) => {
        const matches = program.abi.entries.filter(
          (entry) =>
            entry.plan.intent.kind === "callable" &&
            entry.plan.intent.unitId === unitId &&
            entry.plan.slotPolicy === "required",
        );
        return matches.length === 1 ? emittedProgramBindingIndex(emission, matches[0]!.plan.id) : undefined;
      });
      if (
        !signature ||
        signature.kind !== "func" ||
        signature.params.length ||
        signature.results.length ||
        !adapter ||
        adapter.locals.length ||
        adapter.body.length !== unitIds.length ||
        adapter.body.some(
          (instruction, index) =>
            instruction.op !== "call" ||
            slots[index]?.space !== "function" ||
            absoluteFuncIndex(mod, instruction.funcIdx) !== slots[index]?.index,
        )
      )
        gap(
          "startup",
          "startup-call-order",
          "completed adapter must call each authenticated startup unit once in semantic order",
        );
    }
    if (
      unitIds.length !== executable.length ||
      adapterIndex === undefined ||
      !mod.functions[adapterIndex - functionImports]
    )
      gap("startup", "startup-adapter", "executable source units require a genuine completed physical startup adapter");
    else if (
      !input.deferTopLevelInit &&
      executable.every((row) => row.invocation.kind === "wasm-start") &&
      mod.startFuncIdx === adapterIndex
    )
      startup = Object.freeze({ kind: "wasm-start", hasTopLevelStatements: true, adapterIndex, unitIds });
    else if (
      input.deferTopLevelInit &&
      executable.every((row) => row.invocation.kind === "deferred-export") &&
      mod.startFuncIdx === undefined &&
      mod.exports.filter(
        (row) => row.name === "__module_init" && row.desc.kind === "func" && row.desc.index === adapterIndex,
      ).length === 1
    )
      startup = Object.freeze({
        kind: "deferred-export",
        hasTopLevelStatements: true,
        adapterIndex,
        unitIds,
        exportName: "__module_init",
      });
    else if (
      input.policy.target === "wasi" &&
      executable.every((row) => row.invocation.kind === "wasi-start-export") &&
      mod.startFuncIdx === undefined &&
      mod.exports.filter((row) => row.name === "_start" && row.desc.kind === "func" && row.desc.index === adapterIndex)
        .length === 1
    )
      startup = Object.freeze({
        kind: "wasi-start-export",
        hasTopLevelStatements: true,
        adapterIndex,
        unitIds,
        exportName: "_start",
      });
    else
      gap(
        "startup",
        "startup-disposition",
        "authenticated adapter and actual start/export disagree with captured invocation policy",
      );
  }
  return startup;
}
