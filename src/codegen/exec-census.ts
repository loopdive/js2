// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Deterministic EXECUTED-call census — counts, not time.
 *
 * `JS2WASM_EXEC_CENSUS=<substr>,<substr>,…` exports one mutable `i32` global per
 * matching defined function and prepends an increment to that function's OWN
 * BODY. Read the globals after running the workload; the counts are exact and
 * identical on every run.
 *
 * ## Why this exists alongside `JS2WASM_ALLOC_CENSUS_CALLS`, and why that one is broken
 *
 * The #4185 call census splices its increment **at each call site**, immediately
 * before the `call`. That is stack-neutral in isolation, but it lands in the
 * middle of the callee's argument sequence — and `applyRefNullFixups`
 * (`fixups.ts`) walks backwards from a `call` mapping roughly ONE INSTRUCTION
 * PER PARAMETER, special-casing only `local.tee`, `struct.new`,
 * `array.new_fixed` and nested `call`. Four extra instructions desynchronise
 * that walk, and it retypes a `ref.null.extern` against the wrong parameter.
 * Measured 2026-08-13: instrumenting `__extern_get` produced a module that
 * failed to compile with a stack-type error at a call parameter.
 *
 * Incrementing at FUNCTION ENTRY avoids the hazard entirely — the increment is
 * not adjacent to any call, so no argument sequence is disturbed and no
 * backward walk can be thrown off. That is the whole design difference.
 *
 * ## Why counts rather than a profile
 *
 * Every performance verdict in #4157 rests on profile bucket share with
 * order-reversed blocks. Bucket share is a RATIO, so it survives a uniformly
 * slower machine — but contention is not uniform (it perturbs memory-bound code
 * and GC timing more than compute-bound code), and this container has been
 * observed running the same 300-iteration workload in 36 s and in 71 s. A count
 * of executed calls is immune to all of that: it answers "does the emitted code
 * do less work", which is the question an optimisation is actually making a
 * claim about.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

export const EXEC_CENSUS_PREFIX = "__exec_count_";

function targets(): string[] {
  const raw = process.env.JS2WASM_EXEC_CENSUS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Install the census. Call LAST in finalize — after every body fill and every
 * index remap — so the increment sits at the head of each function's final
 * body and no later pass reorders it. Adding globals is not adding imports, so
 * the frozen import index space is undisturbed.
 */
export function installExecCensus(ctx: CodegenContext): void {
  const want = targets();
  if (want.length === 0) return;
  let instrumented = 0;
  for (const fn of ctx.mod.functions) {
    const name = fn.name;
    if (!name || !want.some((t) => name.includes(t))) continue;
    if (fn.body.length === 0) continue;
    const globalName = `${EXEC_CENSUS_PREFIX}${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
    if (ctx.mod.globals.some((g) => g.name === globalName)) continue;
    const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    ctx.mod.exports.push({ name: globalName, desc: { kind: "global", index: globalIdx } });
    const bump: Instr[] = [
      { op: "global.get", index: globalIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "global.set", index: globalIdx },
    ];
    fn.body.unshift(...bump);
    instrumented++;
  }
  process.stderr.write(`[exec-census] instrumented ${instrumented} function(s)\n`);
}
