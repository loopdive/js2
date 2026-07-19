// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { LinearMemoryPlan } from "../../analysis/linear-memory-plan.js";
import { forEachInstrDeep, type IrModule, type IrType } from "../../nodes.js";
import { lowerIrFunctionBody } from "../../lower.js";
import { verifyIrBackendLegality } from "../legality.js";
import type { PorfforRendererInput } from "./compat.js";
import { PorfforModuleAssembler } from "./assembler.js";
import { PorfforEmitter } from "./sink.js";
import { PorfforTypeConverter } from "./type-converter.js";

export interface PorfforGlobalInput {
  readonly name: string;
  readonly type: IrType;
}

export interface LowerIrModuleToPorfforOptions {
  readonly globals?: readonly PorfforGlobalInput[];
  /** Renderer entry name. Null/omitted emits no C main, useful for embedding/tests. */
  readonly entry?: string | null;
  readonly prefs?: Readonly<Record<string, unknown>>;
  /** Target-neutral layout/allocation authority required by heap instructions. */
  readonly memoryPlan?: LinearMemoryPlan;
}

/**
 * Lower a typed JS2 SSA module through the five-part backend contract into the
 * frozen Porffor renderer record. This is deliberately IR-only: callers must
 * use JS2's existing AST-to-IR front end and no Porffor parser/codegen path is
 * imported here.
 */
export function lowerIrModuleToPorffor(
  module: IrModule,
  options: LowerIrModuleToPorfforOptions = {},
): PorfforRendererInput {
  const assembler = new PorfforModuleAssembler();
  const types = new PorfforTypeConverter();
  assembler.setPreferences(options.prefs ?? {});

  const hasPlannedHeap = module.functions.some((func) =>
    func.blocks.some((block) =>
      block.instrs.some((instr) => {
        let found = false;
        forEachInstrDeep(instr, (nested) => {
          if (
            nested.kind === "object.new" ||
            nested.kind === "object.get" ||
            nested.kind === "object.set" ||
            nested.kind === "vec.new_fixed" ||
            nested.kind === "vec.len" ||
            nested.kind === "vec.get" ||
            nested.kind === "vec.set"
          ) {
            found = true;
          }
        });
        return found;
      }),
    ),
  );
  if (hasPlannedHeap && !options.memoryPlan) {
    throw new Error("porffor backend heap lowering requires a shared LinearMemoryPlan");
  }
  if (options.memoryPlan) {
    if (options.memoryPlan.policy !== "arena-v1" && options.memoryPlan.policy !== "analysis-stack-arena-v1") {
      throw new Error(`porffor backend does not support memory policy '${options.memoryPlan.policy}'`);
    }
    if (options.prefs?.gc !== undefined && options.prefs.gc !== false) {
      throw new Error(
        `porffor backend ${options.memoryPlan.policy} requires prefs.gc=false because planned pointers are not GC roots`,
      );
    }
    assembler.bindMemoryPlan(options.memoryPlan);
  }

  for (const global of options.globals ?? []) {
    const slots = types.convertType(global.type);
    if (slots.length !== 1) throw new Error(`porffor backend requires one scalar slot for global '${global.name}'`);
    assembler.declarePorfforGlobal(global.name, slots[0]!);
  }

  const handles = new Map<string, number>();
  for (const func of module.functions) {
    const errors = verifyIrBackendLegality(func, "porffor");
    if (errors.length > 0) {
      throw new Error(
        `porffor backend legality failed for ${func.name}: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
    handles.set(func.name, assembler.declareIrFunction(func));
  }

  for (const func of module.functions) {
    const handle = handles.get(func.name)!;
    const signature = assembler.functionSymbol(handle);
    const emitter = new PorfforEmitter(assembler, signature.results);
    const lowered = lowerIrFunctionBody(func, assembler, emitter, types);
    assembler.defineFunc(handle, { lowered });
    if (func.exported) assembler.exportFunc(func.name, handle);
  }

  if (options.entry) {
    const handle = assembler.lookupFunc(options.entry);
    if (handle === undefined) throw new Error(`porffor assembler: entry function '${options.entry}' is not defined`);
    assembler.setStart(handle);
  }

  assembler.finalize();
  return assembler.rendererInput();
}
