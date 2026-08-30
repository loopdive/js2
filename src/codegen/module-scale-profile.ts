// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4645) Module-scale checkpoints for the compile profiler.
//
// Phase timings alone cannot tell "this pass is quadratic in module size" from
// "this pass is linear but the module itself grew superlinearly". On the #4645
// repro every whole-module finalize pass grew 50-300x for a 2.8x source growth,
// and only these counts explained why: the module's instruction VISIT count had
// gone from 140,699 to 9,731,399 while its UNIQUE instruction count grew from
// 132,401 to 215,907. That gap is the whole diagnosis.

import type { Instr, WasmModule } from "../ir/types.js";
import { profileModuleScale } from "../compile-profile.js";
import { walkInstructionDag, walkInstructions } from "./walk-instructions.js";

export interface ModuleScale extends Record<string, number> {
  funcs: number;
  imports: number;
  types: number;
  globals: number;
  instrs: number;
  uniqueInstrs: number;
}

/**
 * Measure expanded instruction visits and physical instruction-array entries.
 *
 * V8's Set and WeakSet implementations both exhaust their backing-table limits
 * when they retain one entry per instruction in the TypeScript parser module.
 * Instruction arrays are the IR's sharing unit, so walking their DAG counts a
 * shared subtree once while retaining only the much smaller array-identity set.
 * A deliberately aliased instruction object placed in two distinct arrays is
 * counted as two physical entries; ordinary codegen shares the containing
 * array, which is the duplication this metric diagnoses.
 */
export function measureModuleScale(mod: WasmModule): ModuleScale {
  let instrs = 0;
  for (const f of mod.functions) {
    walkInstructions(f.body, () => {
      instrs++;
    });
  }

  const visitedArrays = new WeakSet<Instr[]>();
  let uniqueInstrs = 0;
  for (const f of mod.functions) {
    walkInstructionDag(
      f.body,
      () => {
        uniqueInstrs++;
      },
      visitedArrays,
    );
  }

  return {
    funcs: mod.functions.length,
    imports: mod.imports.length,
    types: mod.types.length,
    globals: mod.globals.length,
    instrs,
    uniqueInstrs,
  };
}

/**
 * Report the module's scale at a named checkpoint. The walk only runs when
 * `JS2WASM_COMPILE_PROFILE` is set — the profiler invokes the callback lazily.
 *
 * `instrs` counts VISITS; `uniqueInstrs` counts distinct objects. A large gap
 * means nested instruction arrays are SHARED across bodies (a DAG, not a tree),
 * so every non-deduping whole-module walk — and the binary encoder — re-traverses
 * the same subtree once per path that reaches it.
 */
export function reportModuleScale(label: string, mod: WasmModule): void {
  profileModuleScale(label, () => measureModuleScale(mod));
}
