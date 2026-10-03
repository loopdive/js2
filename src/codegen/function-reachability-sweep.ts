// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6768 lever 1) Function reachability sweep.
 *
 * Every standalone compile carries a ~650-function runtime floor of which ~39 %
 * is unreachable from any root. Every whole-module finalize pass (repair-struct,
 * peephole, ir-inline, cross-hierarchy, stack-balance, extern-convert-any) and
 * the binary emitter walk those dead bodies anyway.
 *
 * ## What this pass does — and deliberately does NOT do
 *
 * It computes the set of defined functions that can run and replaces every
 * other function's body with a single `unreachable` (dropping its locals). It
 * does NOT remove the function from `mod.functions`.
 *
 * Physical removal would renumber every later function. Function identities
 * live in two handle regimes (live absolute indices and stable ordinals, see
 * `src/wasm/physical/function-handles.ts`) and in many codegen side tables
 * (`funcMap`, helper maps, trampolines, the Program ABI registries and their
 * publication), several of which are read after this point. A stub keeps the
 * function index space — and, because import/type liveness is still computed
 * from the ORIGINAL bodies (the sweep runs inside `eliminateDeadImports` after
 * its reference scan), the import and type index spaces too — identical to the
 * no-sweep layout. The only change is that code which can never execute is
 * gone, so the finalize passes and the emitter no longer walk it.
 *
 * A liveness the sweep misses therefore cannot produce an invalid module or a
 * wrong-callee call: the stub traps on `unreachable`. That failure is loud and
 * local, and `JS2WASM_FUNC_SWEEP_VERIFY=1` re-checks after every finalize pass.
 *
 * ## Roots
 *
 * - every function export and the start function;
 * - every active element-segment entry (tables are dispatched untyped);
 * - `call` / `ref.func` / `call_ref` in element offsets and global initializers;
 * - helpers a LATER finalize pass may introduce a fresh `call` to by name
 *   (`LATE_PASS_HELPER_ROOTS`).
 *
 * Not roots: `mod.declaredFuncRefs` (a declarative segment only licenses
 * `ref.func`; it is re-derived from bodies and cannot invoke anything) and the
 * `WasmFunction.exported` flag (only an entry in `mod.exports` is callable).
 *
 * ## Edges
 *
 * Every instruction carrying a `funcIdx` (`call`, `return_call`, `ref.func`)
 * makes its target live. Treating every `ref.func` target as callable is
 * deliberately coarse: a type-directed refinement (a `ref.func` target runs
 * only if a live `call_ref` of a compatible type exists) was measured on the
 * 40-row #6768 sample and stubbed ZERO additional functions, so it is not worth
 * its subtyping/iso-recursive-equality soundness burden.
 *
 * ## When it runs
 *
 * Twice: inside `eliminateDeadImports` (before the first finalize pass), and
 * again right after the IR inliner, whose single-caller rule leaves the inlined
 * callee unreferenced (`sweepAfterInline`). Both points follow every body
 * FILL pass, so no body that can still gain calls is analysed early.
 *
 * Instructions are reached through `walkChildren` — the same child enumeration
 * the binary emitter recurses through. Each body is walked with its OWN visited
 * set: an instruction array shared by a dead and a live function must count for
 * the live one.
 */
import type { Instr, WasmFunction, WasmModule } from "../ir/types.js";
import { STABLE_FUNC_BASE } from "../wasm/physical/function-handles.js";
import type { CodegenContext } from "./context/types.js";
import { profileCount } from "../compile-profile.js";
import { readEnv } from "../env.js";

/**
 * Helpers a finalize pass that runs AFTER the sweep may reference by name when
 * it inserts a coercion (`stackBalance` → `findFuncByName`,
 * `repairCrossHierarchyOperands` → `findFunc`, `fixups.ts` → `funcMap`). Keep
 * them alive even when no body references them yet.
 */
const LATE_PASS_HELPER_ROOTS: readonly string[] = ["__box_number", "__unbox_number"];

/** Stubbed functions per module — read only by the post-finalize verifier. */
const stubbedByModule = new WeakMap<WasmModule, Set<WasmFunction>>();

function envFlag(name: string): string | undefined {
  return readEnv(name);
}

/**
 * Whether the sweep runs for this compile. Standalone only for now (#6768:
 * validated on the standalone test262 lane); `JS2WASM_FUNC_SWEEP=0` disables
 * it and `=1` forces it on for any WasmGC target.
 */
export function functionSweepEnabled(ctx: CodegenContext): boolean {
  const env = envFlag("JS2WASM_FUNC_SWEEP");
  if (env === "0") return false;
  if (env === "1") return true;
  return ctx.standalone && !ctx.wasi;
}

/** Position in `mod.functions` of a function handle, or -1 (import / unresolvable). */
function definedPosition(mod: WasmModule, numImportFuncs: number, h: unknown): number {
  if (typeof h !== "number" || Number.isNaN(h)) return -1;
  if (h >= STABLE_FUNC_BASE) {
    const pos = mod.funcOrdinalToPosition[h - STABLE_FUNC_BASE];
    return pos === undefined || Number.isNaN(pos) ? -1 : pos;
  }
  const pos = h - numImportFuncs;
  return pos >= 0 && pos < mod.functions.length ? pos : -1;
}

/**
 * Positions (in `mod.functions`) of every defined function that can run.
 * Pure: does not mutate `mod`.
 */
export function reachableFunctionPositions(
  mod: WasmModule,
  extraRootNames: readonly string[] = LATE_PASS_HELPER_ROOTS,
): Uint8Array {
  let numImportFuncs = 0;
  for (const imp of mod.imports) if (imp.desc.kind === "func") numImportFuncs++;
  const live = new Uint8Array(mod.functions.length);
  const queue: number[] = [];
  const mark = (pos: number): void => {
    if (pos < 0 || live[pos]) return;
    live[pos] = 1;
    queue.push(pos);
  };

  // One visited set for the whole walk is exact here: only LIVE bodies are
  // ever scanned, so an array skipped as already-visited was reached from a
  // live function whose edges are already recorded. The child enumeration is
  // `walkChildren`'s (body / then / else / catches[].body / catchAll), inlined
  // because this walk runs twice per compile over all live code.
  const visited = new Set<Instr[]>();
  const pendingArrays: Instr[][] = [];
  const push = (arr: unknown): void => {
    if (Array.isArray(arr) && !visited.has(arr)) {
      visited.add(arr);
      pendingArrays.push(arr);
    }
  };
  const scan = (body: Instr[]): void => {
    push(body);
    while (pendingArrays.length > 0) {
      const arr = pendingArrays.pop()!;
      for (let i = 0; i < arr.length; i++) {
        const n = arr[i] as {
          funcIdx?: unknown;
          body?: unknown;
          then?: unknown;
          else?: unknown;
          catches?: { body?: unknown }[];
          catchAll?: unknown;
        };
        if (n.funcIdx !== undefined) mark(definedPosition(mod, numImportFuncs, n.funcIdx));
        if (n.body !== undefined) push(n.body);
        if (n.then !== undefined) push(n.then);
        if (n.else !== undefined) push(n.else);
        if (n.catchAll !== undefined) push(n.catchAll);
        if (Array.isArray(n.catches)) for (const c of n.catches) push(c?.body);
      }
    }
  };

  for (const ex of mod.exports) {
    if (ex.desc.kind === "func") mark(definedPosition(mod, numImportFuncs, ex.desc.index));
  }
  if (mod.startFuncIdx !== undefined) mark(definedPosition(mod, numImportFuncs, mod.startFuncIdx));
  for (const el of mod.elements) {
    for (const fi of el.funcIndices) mark(definedPosition(mod, numImportFuncs, fi));
    scan(el.offset);
  }
  for (const g of mod.globals) scan(g.init);
  const rootNames = new Set(extraRootNames);
  for (let i = 0; i < mod.functions.length; i++) if (rootNames.has(mod.functions[i]!.name)) mark(i);

  while (queue.length > 0) scan(mod.functions[queue.pop()!]!.body);
  return live;
}

/**
 * Replace every unreachable defined function's body with `unreachable` and
 * drop its locals. Assigns fresh arrays (never mutates the old ones in place):
 * a dead function's body array may be shared with a live function.
 * Returns the number of functions stubbed.
 */
export function stubUnreachableFunctions(mod: WasmModule, live: Uint8Array): number {
  const stubbed = stubbedByModule.get(mod) ?? new Set<WasmFunction>();
  let count = 0;
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = mod.functions[i]!;
    if (live[i] || stubbed.has(fn)) continue;
    fn.body = [{ op: "unreachable" }];
    fn.locals = [];
    stubbed.add(fn);
    count++;
  }
  if (stubbed.size > 0) stubbedByModule.set(mod, stubbed);
  profileCount("finalize/function-sweep:stubbed", count);
  return count;
}

/**
 * (#6768) Second sweep, right after `inlineUserFunctions`: the inliner's
 * single-caller rule leaves each inlined callee with no remaining reference,
 * and the passes after it (cross-hierarchy, stack-balance, extern-convert-any,
 * emit) would otherwise still walk it.
 */
export function sweepAfterInline(ctx: CodegenContext): void {
  if (functionSweepEnabled(ctx)) stubUnreachableFunctions(ctx.mod, reachableFunctionPositions(ctx.mod));
}

/**
 * After every finalize pass has run, no function that can run may be a stub.
 * A hit means a late pass introduced a reference the sweep did not anticipate
 * (the root list above must grow). Used by the #6768 test and by
 * `verifyFunctionSweep`.
 */
export function stubsReachedAfterFinalize(mod: WasmModule): string[] {
  const stubbed = stubbedByModule.get(mod);
  if (!stubbed || stubbed.size === 0) return [];
  const live = reachableFunctionPositions(mod);
  const hits: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    if (live[i] && stubbed.has(mod.functions[i]!)) hits.push(mod.functions[i]!.name);
  }
  return hits;
}

/** Post-finalize hook: throws under `JS2WASM_FUNC_SWEEP_VERIFY=1` when a stub can run. */
export function verifyFunctionSweep(mod: WasmModule): void {
  if (envFlag("JS2WASM_FUNC_SWEEP_VERIFY") !== "1") return;
  const hits = stubsReachedAfterFinalize(mod);
  if (hits.length > 0) {
    throw new Error(`#6768 function sweep: stubbed function(s) reachable after finalize: ${hits.join(", ")}`);
  }
}
