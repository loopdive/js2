// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106) The GlobalDeclarationInstantiation prologue of `__module_init`.
 *
 * Every compiled initializer starts with the same instantiation work, emitted
 * ahead of any user statement: the restricted-global SyntaxError (§16.1.7
 * step 5.d), the `var`-reads-`undefined` seeds (§9.1.1.4.18), the script's
 * global-object function and `var` bindings (§9.1.1.4.17/18) and the
 * reassigned-function live-binding seeds (#2931, #4182).
 *
 * The direct emitter (`compileModuleInitBody`) inlines this prologue. An
 * IR-claimed initializer replaces that body wholesale, and the IR knows none of
 * these emitters, so the claimed body silently dropped GDI: a standalone
 * script's top-level `function f` was never published on the global object
 * (`Object.prototype.hasOwnProperty.call(globalThis, "f")` read `false` the
 * moment the IR claimed `<module-init>`). `buildModuleInitPrologueCall` runs
 * the same emitter into its own private `[] -> []` helper, which the IR patch
 * calls first — before every IR statement, so evaluation order is unchanged.
 * A separate helper rather than a splice: the prologue keeps its own locals,
 * so no index remapping against the IR body's locals is needed.
 */
import type { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import { annexBModuleGlobalSeedsFromTopLevel } from "../annexb-global-live-binding.js";
import { emitUndefinedExtern } from "../any-helpers.js";
import { emitCachedFuncClosureAccess } from "../closures.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { emitScriptGlobalFunctionBindings } from "../global-function-bindings.js"; // (#4394) §9.1.1.4.18
import { emitScriptGlobalVarBindings } from "../global-var-bindings.js"; // (#4491 T4) §9.1.1.4.17
import { emitThrowJsError } from "../js-errors.js";
import { addFuncType } from "../registry/types.js";
import { emitRuntimeEvalAotCallableAdapter } from "../runtime-eval-callable.js";
import { scriptVarBindingNames } from "../source-scan-predicates.js";
import { emitModuleVarUndefinedSeeds } from "./module-var-undefined-seed.js";

/** WAT-visible name of the private helper an IR-claimed initializer calls first. */
export const MODULE_INIT_PROLOGUE_FUNCTION_NAME = "__module_init_prologue";

/**
 * Append the GDI prologue to `initFctx.body`. Emits nothing at all when the
 * program needs no instantiation work, so such initializers stay
 * byte-identical.
 */
export function emitModuleInitPrologue(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  initFctx: FunctionContext,
): void {
  // (#5271 step 8) §16.1.7 GlobalDeclarationInstantiation step 5.d — a
  // top-level lexical declaration whose name is a RESTRICTED GLOBAL
  // (`undefined`, `NaN`, `Infinity`: own, non-configurable properties of the
  // global object) is a SyntaxError. The Script goal decides this at
  // instantiation, i.e. before ANY statement of the script runs, so the throw
  // is the very first instruction of `__module_init`. The runner accepts a
  // runtime throw for `negative: { phase: runtime }`; this deliberately is
  // NOT a compile diagnostic.
  if (ctx.restrictedGlobalLexicalName !== undefined) {
    emitThrowJsError(
      ctx,
      initFctx,
      "SyntaxError",
      `Identifier '${ctx.restrictedGlobalLexicalName}' has already been declared`,
    );
    initFctx.body.push({ op: "unreachable" });
  }

  // (#4489, subsuming the #4264 `with`-body seed) §9.1.1.4.18: every
  // module-scope `var` reads as `undefined` before its declaration. Must stay
  // AHEAD of the function-binding seeds below — rationale, scope and the
  // measured before/after in `declarations/module-var-undefined-seed.ts`.
  emitModuleVarUndefinedSeeds(ctx, sourceFile, initFctx);

  // (#4394) §9.1.1.4.18 — a SCRIPT's top-level function declarations are own
  // properties of the global object. Seeded here, ahead of every user
  // statement, which is what declaration hoisting requires.
  emitScriptGlobalFunctionBindings(ctx, initFctx);
  // (#4491 T4) §9.1.1.4.17 — and the `var` twin of the same instantiation
  // step, AFTER the functions so a name declared both ways keeps the function
  // binding GDI actually initialises. See global-var-bindings.ts.
  emitScriptGlobalVarBindings(ctx, initFctx, sourceFile);

  // (#2931) Seed each reassigned-function live-binding global with the
  // function's closure BEFORE any user init statement runs, so a read of the
  // name before its reassignment still yields the function. Emitted via
  // `emitCachedFuncClosureAccess` (NOT the identifier read-path, which would
  // recurse into the live-binding `global.get` arm). Dedupe by global index so
  // an import alias sharing the same global is seeded once.
  if (!ctx.liveFuncBindingGlobals || ctx.liveFuncBindingGlobals.size === 0) return;
  const seededGlobals = new Set<number>();
  for (const liveName of ctx.liveFuncBindingGlobals) {
    // (#4182) A module-scope Annex B block-fn binding starts as `undefined`
    // (B.3.3.2.b CreateGlobalFunctionBinding(F, undefined)) unless a real
    // top-level `function f` also exists — GDI initializes only that one.
    // Without this split, pass 2 of the #2965 two-pass init compile would
    // seed the block function's closure (its funcMap entry exists by then),
    // making the pre-evaluation read wrongly observe the function. Under
    // the `undefinedSingleton` regime the binding must read as `undefined`,
    // not `null`, so seed the `$undefined` singleton rather than leaving
    // the `ref.null.extern` global init.
    if (!annexBModuleGlobalSeedsFromTopLevel(ctx, liveName)) {
      // Seed the regime's tag-1 `undefined` singleton.
      const annexBGlobalIdx = ctx.moduleGlobals.get(liveName);
      if (annexBGlobalIdx !== undefined && !seededGlobals.has(annexBGlobalIdx) && emitUndefinedExtern(ctx, initFctx)) {
        initFctx.body.push({ op: "global.set", index: annexBGlobalIdx });
        seededGlobals.add(annexBGlobalIdx);
      }
      continue;
    }
    const liveGlobalIdx = ctx.moduleGlobals.get(liveName);
    const liveFuncIdx = ctx.funcMap.get(liveName);
    if (liveGlobalIdx === undefined || liveFuncIdx === undefined) continue;
    if (seededGlobals.has(liveGlobalIdx)) continue;
    const closureType = emitCachedFuncClosureAccess(ctx, initFctx, liveName, liveFuncIdx);
    if (closureType === null) {
      // Could not build the closure — leave the global null-initialised.
      continue;
    }
    // Closure struct (internal ref) → externref for the externref global.
    initFctx.body.push({ op: "extern.convert_any" });
    if (ctx.runtimeEvalGlobalFunctionBindings) {
      emitRuntimeEvalAotCallableAdapter(ctx, initFctx);
    }
    initFctx.body.push({ op: "global.set", index: liveGlobalIdx });
    seededGlobals.add(liveGlobalIdx);
  }
}

/**
 * Conservative "might `emitModuleInitPrologue` emit anything?" — true whenever
 * any of its emitters has work, never false when one does. For the routes that
 * cannot run the prologue (the allocator-sealed multi-source batch), so they
 * can refuse the claim instead of silently dropping instantiation work.
 */
export function moduleInitPrologueMayEmit(ctx: CodegenContext, sourceFile: ts.SourceFile): boolean {
  if (ctx.restrictedGlobalLexicalName !== undefined) return true;
  if ((ctx.liveFuncBindingGlobals?.size ?? 0) > 0) return true;
  if (scriptVarBindingNames(sourceFile).size > 0) return true;
  if (ctx.sourceIsModule) return false;
  return ctx.topLevelFunctionNames.size > 0 || (ctx.globalObjectVarBindings?.size ?? 0) > 0;
}

function reservePrologueHelperName(ctx: CodegenContext): string {
  let name = MODULE_INIT_PROLOGUE_FUNCTION_NAME;
  for (let duplicate = 1; ctx.funcMap.has(name) || ctx.mod.functions.some((func) => func.name === name); duplicate++) {
    name = `${MODULE_INIT_PROLOGUE_FUNCTION_NAME}_${duplicate}`;
  }
  return name;
}

/**
 * Materialize the GDI prologue as a private `[] -> []` helper and return the
 * `call` that runs it, or `undefined` when the prologue is empty (then nothing
 * is minted). The compile-time context keeps the `__module_init` identity —
 * several lowering paths select top-level semantics by that name — while the
 * Wasm function gets a private name.
 *
 * Call this only while no lowered-but-uninstalled body is in flight: the
 * emitters may register late helpers, and a late-import shift reaches only
 * installed functions and `ctx.currentFunc`.
 */
export function buildModuleInitPrologueCall(ctx: CodegenContext, sourceFile: ts.SourceFile): Instr | undefined {
  const fctx: FunctionContext = {
    name: "__module_init",
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
  const previousFunc = ctx.currentFunc;
  ctx.currentFunc = fctx;
  try {
    emitModuleInitPrologue(ctx, sourceFile, fctx);
  } finally {
    ctx.currentFunc = previousFunc;
  }
  if (fctx.body.length === 0) return undefined;
  // Build the whole body before minting the handle, so no late helper
  // registration during emission can take this function's slot.
  const typeIdx = addFuncType(ctx, [], [], "__module_init_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: reservePrologueHelperName(ctx),
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return { op: "call", funcIdx };
}

/**
 * Empty a prologue helper nothing will call (its initializer's IR body was not
 * installed). Keeps the dead copy out of the binary without disturbing any
 * function index.
 */
export function retireModuleInitPrologueHelper(ctx: CodegenContext, funcIdx: number): void {
  const helper = definedFuncAt(ctx, funcIdx);
  if (!helper) return;
  helper.locals = [];
  helper.body = [];
}
