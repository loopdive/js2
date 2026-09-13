// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5383 S2p) Outline the standalone realm-global (`globalThis`) lazy-init seed
 * into ONE module-level helper, `__native_globalThis_ensure`.
 *
 * ## The defect this deletes
 *
 * `emitNativeGlobalThisObject` caches the realm object in a module GLOBAL at
 * runtime, but until this landed it spliced the whole lazy-init guard — about
 * 5,000 instructions, since the seed installs every ES5 global value/function
 * property and every builtin namespace carrier — into the CALLER's body at
 * every call site, at compile time.
 *
 * That is invisible on a single-source compile, which reaches the emitter ~5
 * times, and decisive on a multi-source one, which reaches it ~134 times for
 * the same test262 harness. Measured on
 * `built-ins/Temporal/PlainDate/prototype/day/basic.js` (10.6 KB assembled
 * harness, standalone): the harness's `assert` function was 103 WAT lines
 * single-source and 5,610 multi-source, with the seed's locals present twice in
 * one body; the module was 641 k WAT lines against 159 k.
 *
 * The reason the two lanes differ is NOT the linker and not `compileMulti`
 * itself: `compile()` runs the #3418 dead-top-level-binding elision
 * (`src/compiler.ts`, host-free targets only), which blanks the test262
 * harness's unread `var $262 = { global: globalThis, eval: globalThis.eval, … }`.
 * That erases all three runtime-eval boundary sites, so
 * `ctx.runtimeEvalGlobalFunctionBindings` stays false and bare global reads take
 * the ordinary static path. `compileMulti()` does not run that elision, keeps
 * `$262`, and every bare global lexical read routes through
 * `compileRuntimeEvalGlobalLexicalRead` → `emitGlobalEnvironmentObject` → the
 * seed. Outlining fixes the cost at its source rather than depending on which
 * entry point erased the evidence.
 *
 * ## Why this shape
 *
 * `mintDefinedFunc` hands out a STABLE handle (see `func-space.ts`) that no
 * late-import shifter renumbers, so a `call` immediate baked at the first site
 * stays correct however many imports land afterwards. The helper is therefore
 * resolved-or-reserved AT THE SITE, not rewritten by a finalize pass — the
 * multi-module finalize pass order differs from the single-module one (#5383
 * S2n), and nothing here depends on it.
 *
 * Runtime behaviour is unchanged because the cached global already made the
 * seed run at most once: only the first site to execute can observe a null
 * global, whether the guard is spliced or called.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

const ENSURE_NAME = "__native_globalThis_ensure";

/** A detached `FunctionContext` for a zero-parameter, zero-result helper. */
function makeSeedFunctionContext(name: string): FunctionContext {
  return {
    name,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

/**
 * Build (once) the outlined helper and return its stable handle.
 *
 * `buildSeed` is the caller's existing seed builder; it allocates its locals in
 * the `FunctionContext` handed to it, which is now the HELPER's rather than the
 * call site's.
 *
 * Returns `undefined` when the seed cannot be built (the caller then keeps its
 * historical `null` contract), or when a realm-global read is raised from
 * INSIDE the seed's own construction — that inner site must keep the inline
 * splice, since calling a not-yet-initialized ensure helper from within its own
 * initializer would recurse at runtime.
 */
export function ensureNativeGlobalThisEnsureFunc(
  ctx: CodegenContext,
  globalIdx: number,
  buildSeed: (fctx: FunctionContext) => Instr[] | null,
): number | undefined {
  const cached = ctx.funcMap.get(ENSURE_NAME);
  if (cached !== undefined) return cached;
  if (ctx.nativeGlobalThisSeedBuilding) return undefined;
  ctx.nativeGlobalThisSeedBuilding = true;
  try {
    const seedFctx = makeSeedFunctionContext(ENSURE_NAME);
    // Keep the helper's own body live while the seed can still register late
    // imports — the same rule the inline path applies to the caller's body.
    ctx.liveBodies.add(seedFctx.body);
    const initBody = buildSeed(seedFctx);
    ctx.liveBodies.delete(seedFctx.body);
    if (initBody === null) return undefined;
    const typeIdx = addFuncType(ctx, [], [], `${ENSURE_NAME}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: ENSURE_NAME,
      typeIdx,
      locals: seedFctx.locals,
      body: [
        { op: "global.get", index: globalIdx },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: initBody, else: [] },
      ],
      exported: false,
    });
    // Registered only after the push, so a funcMap entry never names a minted
    // handle that was abandoned by a failed build.
    ctx.funcMap.set(ENSURE_NAME, funcIdx);
    return funcIdx;
  } finally {
    ctx.nativeGlobalThisSeedBuilding = false;
  }
}

/**
 * Emit a realm-global READ through the outlined helper: `call ensure` then
 * `global.get`. Also publishes the caller's bodies as live for the duration of
 * a first-time build — the seed registers late imports, and it is now built
 * against the helper's context, so the coverage `flushLateImportShifts(ctx,
 * fctx)` used to give the caller directly has to come from `ctx.liveBodies`.
 *
 * Returns `null` when the helper is unavailable; the caller then falls back to
 * its historical inline splice.
 */
export function emitOutlinedNativeGlobalThisRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  globalIdx: number,
  buildSeed: (seedFctx: FunctionContext) => Instr[] | null,
): ValType | null {
  const callerBodies = [fctx.body, ...fctx.savedBodies].filter((body) => !ctx.liveBodies.has(body));
  for (const body of callerBodies) ctx.liveBodies.add(body);
  const ensureIdx = ensureNativeGlobalThisEnsureFunc(ctx, globalIdx, buildSeed);
  for (const body of callerBodies) ctx.liveBodies.delete(body);
  if (ensureIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: ensureIdx });
  fctx.body.push({ op: "global.get", index: globalIdx });
  return { kind: "externref" };
}
