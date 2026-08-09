// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { LinearMemoryPlan } from "../../analysis/linear-memory-plan.js";
import type { IrUnitId } from "../../identity.js";
import { forEachInstrDeep, type IrGlobalRef, type IrModule, type IrType } from "../../nodes.js";
import { lowerIrFunctionBody } from "../../lower.js";
import { verifyIrBackendLegality } from "../legality.js";
import type { PorfforRendererInput } from "./compat.js";
import { PorfforModuleAssembler } from "./assembler.js";
import { PorfforEmitter } from "./sink.js";
import { PorfforTypeConverter } from "./type-converter.js";

export interface PorfforGlobalInput {
  readonly ref: IrGlobalRef;
  readonly type: IrType;
}

export interface LowerIrModuleToPorfforOptions {
  readonly globals?: readonly PorfforGlobalInput[];
  /** Public-label compatibility entry. Prefer `entryUnitId` for IR-owned entry selection. */
  readonly entry?: string | null;
  /** Exact IR unit selected as the renderer entry. Null/omitted emits no C main. */
  readonly entryUnitId?: IrUnitId | null;
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
            nested.kind === "vec.set" ||
            nested.kind === "string.const" ||
            nested.kind === "string.concat" ||
            nested.kind === "string.len" ||
            nested.kind === "string.char_at" ||
            nested.kind === "string.char_code_at"
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
    if (slots.length !== 1) {
      throw new Error(`porffor backend requires one scalar slot for global '${global.ref.name}'`);
    }
    assembler.declareIrGlobal(global.ref, slots[0]!);
  }

  const handles = new Map<IrUnitId, number>();
  for (const func of module.functions) {
    const errors = verifyIrBackendLegality(func, "porffor");
    if (errors.length > 0) {
      throw new Error(
        `porffor backend legality failed for ${func.name}: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
    handles.set(func.unitId, assembler.declareIrFunction(func));
  }

  for (const func of module.functions) {
    const handle = handles.get(func.unitId);
    if (handle === undefined) {
      throw new Error(`porffor assembler: IR function unit '${func.unitId}' lost its declared handle`);
    }
    const signature = assembler.functionSymbol(handle);
    const emitter = new PorfforEmitter(assembler, signature.results);
    const lowered = lowerIrFunctionBody(func, assembler, emitter, types);
    assembler.defineFunc(handle, { lowered });
    if (func.exported) assembler.exportFunc(func.name, handle);
  }

  if (options.entry && options.entryUnitId) {
    throw new Error("porffor assembler: entry and entryUnitId cannot both be supplied");
  }
  if (options.entryUnitId) {
    const handle = assembler.lookupIrFunction(options.entryUnitId);
    if (handle === undefined) {
      throw new Error(`porffor assembler: entry function unit '${options.entryUnitId}' is not defined`);
    }
    assembler.setStart(handle);
  } else if (options.entry) {
    const handle = assembler.lookupUniqueIrFunctionByDisplayName(options.entry) ?? assembler.lookupFunc(options.entry);
    if (handle === undefined) throw new Error(`porffor assembler: entry function '${options.entry}' is not defined`);
    assembler.setStart(handle);
  }

  assembler.finalize();
  return assembler.rendererInput();
}
