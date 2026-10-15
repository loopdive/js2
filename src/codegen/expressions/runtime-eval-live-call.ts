// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Out-of-line live-binding calls for runtime-eval modules (#6990).
 *
 * In a standalone module that links the runtime-eval provider, eval may
 * replace a script function binding (`eval("function f(){…}")`), so every call
 * of a top-level function is lowered as a LIVE call: read the binding (global
 * lexical sidecar, then the module global), then dispatch dynamically. That
 * sequence is inlined at every call site — ~375 WAT lines and ~8 fresh locals
 * each. Octane mandreel's `global_init` has ~150k such calls; the function
 * needed ~1.2M locals (V8's limit is 50k) and never finished compiling.
 *
 * Here an eligible call site compiles exactly like a plain direct call, and its
 * `call` is retargeted at finalize to a per-callee trampoline with the callee's
 * own signature:
 *
 *   if (provider never entered) call $f(params)      ;; nothing can have rebound f
 *   else                        <live read + __apply_closure, boxed args>
 *
 * Before the first provider entry no evaluated code has run, so the binding
 * still holds the declaration — the direct call is exact. After it, the slow
 * path is the same live read + dynamic dispatch the inline lowering performed.
 * Retargeting happens at finalize (not at the call site) because the callee's
 * Wasm signature can still change while the module compiles; the trampoline is
 * typed from the FINAL signature, and only calls still aimed at the callee's
 * current index are moved.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "../registry/types.js";
import { localGlobalIdx, nextModuleGlobalIdx } from "../registry/imports.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { emitRuntimeEvalGlobalLexicalReadOrFallback } from "../global-environment.js";
import { coerceType } from "../shared.js";

/** Private `moduleGlobals` key of the "provider ever entered" flag. */
const EVER_ENTERED_GLOBAL = "\0runtime-eval-ever-entered";

interface LiveCallSites {
  /** callee name → the `call` instructions to retarget at finalize. */
  readonly byName: Map<string, Instr[]>;
}

const sitesByCtx = new WeakMap<CodegenContext, LiveCallSites>();

/** Index of the i32 "provider ever entered" flag, created on first use. */
export function ensureRuntimeEvalEverEnteredGlobal(ctx: CodegenContext): number {
  const existing = ctx.moduleGlobals.get(EVER_ENTERED_GLOBAL);
  if (existing !== undefined) return existing;
  const idx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__runtime_eval_ever_entered",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.moduleGlobals.set(EVER_ENTERED_GLOBAL, idx);
  return idx;
}

/** Set the flag; emitted at every provider entry (the global-binding seed). */
export function emitRuntimeEvalEverEntered(ctx: CodegenContext, fctx: FunctionContext): void {
  const idx = ensureRuntimeEvalEverEnteredGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: 1 }, { op: "global.set", index: idx });
}

/**
 * Can this live call take the direct-call-plus-trampoline lowering? Only an
 * unshadowed call of an ordinary, never-reassigned top-level function
 * declaration whose binding is live SOLELY because the module consumes the
 * runtime-eval provider (`evalOnlyLiveFuncBindings`); Annex B and syntactically
 * reassigned bindings keep the inline lowering.
 */
export function runtimeEvalLiveCallFastPathEligible(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): boolean {
  if (!(ctx.standalone || ctx.wasi) || ctx.runtimeEvalGlobalFunctionBindings !== true) return false;
  if (!ts.isIdentifier(expr.expression) || expr.arguments.some((a) => ts.isSpreadElement(a))) return false;
  const name = expr.expression.text;
  if (fctx.localMap.has(name) || fctx.boxedCaptures?.has(name)) return false;
  if (fctx.annexBRepeatedOuterBindings?.has(name) || fctx.annexBExistingDirectFunctionBindings?.has(name)) return false;
  if (ctx.annexBModuleBindings?.has(name)) return false;
  if (ctx.liveFuncBindingGlobals?.has(name) !== true) return false;
  const declaration = ctx.topLevelFunctionDeclarations.get(name);
  if (!declaration || !declaration.body || declaration.asteriskToken) return false;
  if (declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  // Live only because eval may rebind it — a syntactic reassignment (also in
  // `reassignedFunctionDeclarations`) keeps the inline live lowering.
  if (ctx.evalOnlyLiveFuncBindings?.has(name) !== true) return false;
  if (ctx.oracle.valueDeclarationOf(expr.expression) !== declaration) return false;
  const funcIdx = ctx.funcMap.get(name);
  return funcIdx !== undefined && definedFuncAt(ctx, funcIdx) !== undefined;
}

/**
 * Record every `call <name>` emitted into `fctx.body` from `start` onwards (at
 * any nesting depth) for finalize-time retargeting. Returns how many were found.
 */
export function recordRuntimeEvalLiveCallSites(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  start: number,
): number {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) return 0;
  let sites = sitesByCtx.get(ctx);
  if (!sites) sitesByCtx.set(ctx, (sites = { byName: new Map() }));
  const list = sites.byName.get(name) ?? [];
  let found = 0;
  const visit = (instrs: Instr[]): void => {
    for (const instr of instrs) {
      if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx === funcIdx) {
        list.push(instr);
        found++;
      }
      for (const key of ["body", "then", "else"] as const) {
        const nested = (instr as Record<string, unknown>)[key];
        if (Array.isArray(nested)) visit(nested as Instr[]);
      }
      const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
      if (Array.isArray(catches)) for (const c of catches) if (Array.isArray(c.body)) visit(c.body);
    }
  };
  visit(fctx.body.slice(start));
  if (found > 0) sites.byName.set(name, list);
  return found;
}

/** Finalize: build each trampoline from the callee's final signature and retarget its sites. */
export function fillRuntimeEvalLiveCallTrampolines(ctx: CodegenContext): void {
  const sites = sitesByCtx.get(ctx);
  if (!sites) return;
  sitesByCtx.delete(ctx);
  for (const [name, list] of sites.byName) {
    const targetIdx = ctx.funcMap.get(name);
    const liveGlobalIdx = ctx.moduleGlobals.get(name);
    if (targetIdx === undefined || liveGlobalIdx === undefined) continue;
    const sig = funcSignatureOf(ctx, targetIdx);
    if (!sig || sig.results.length > 1) continue;
    const trampolineIdx = buildTrampoline(ctx, name, targetIdx, liveGlobalIdx, sig.params, sig.results);
    if (trampolineIdx === undefined) continue;
    const liveTarget = ctx.funcMap.get(name);
    for (const instr of list) {
      if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx === liveTarget) {
        instr.funcIdx = trampolineIdx;
      }
    }
  }
}

function buildTrampoline(
  ctx: CodegenContext,
  name: string,
  targetIdx: number,
  liveGlobalIdx: number,
  params: readonly ValType[],
  results: readonly ValType[],
): number | undefined {
  const externref: ValType = { kind: "externref" };
  const flagIdx = ensureRuntimeEvalEverEnteredGlobal(ctx);
  const funcIdx = mintDefinedFunc(ctx);
  const fctx: FunctionContext = {
    name: `__runtime_eval_live_call_${name}`,
    params: params.map((type, i) => ({ name: `p${i}`, type })),
    locals: [],
    localMap: new Map(),
    returnType: results[0] ?? null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // Attach before filling: late imports registered while building shift every
  // reachable body, this one included.
  pushDefinedFunc(ctx, funcIdx, {
    name: fctx.name,
    typeIdx: addFuncType(ctx, [...params], [...results]),
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  // The trampoline is not a source function, so the ES5 §15.3.5.4 caller-strict
  // marker must sit on the call INTO it, as for the #1058 outlined dyn-call
  // helpers (test262 built-ins/Function/15.3.5.4_2-57gs.js).
  (ctx.outlinedDynamicCallHelpers ??= new Map()).set(fctx.name, fctx.name);

  const direct: Instr[] = [
    ...params.map((_, i) => ({ op: "local.get", index: i }) as Instr),
    { op: "call", funcIdx: targetIdx },
  ];

  // Slow path, built in a scratch body: the same live read the inline
  // lowering performs (sidecar lexical, else the module binding), then the
  // generic apply bridge with an unbound receiver and boxed arguments.
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const outer = fctx.body;
  const slow: Instr[] = [];
  fctx.body = slow;
  const liveType = ctx.mod.globals[localGlobalIdx(ctx, liveGlobalIdx)]?.type ?? externref;
  const fallback: Instr[] = [{ op: "global.get", index: liveGlobalIdx }];
  if (liveType.kind !== "externref") {
    const saved = fctx.body;
    fctx.body = fallback;
    coerceType(ctx, fctx, liveType, externref);
    fctx.body = saved;
  }
  if (emitRuntimeEvalGlobalLexicalReadOrFallback(ctx, fctx, name, fallback, externref) === null) {
    fctx.body = outer;
    return undefined;
  }
  fctx.body.push({ op: "ref.null.extern" });
  const argsLocal = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name: "args", type: externref });
  fctx.body.push({ op: "call", funcIdx: newIdx }, { op: "local.set", index: argsLocal });
  params.forEach((type, i) => {
    fctx.body.push({ op: "local.get", index: argsLocal }, { op: "local.get", index: i });
    if (type.kind !== "externref") coerceType(ctx, fctx, type, externref);
    fctx.body.push({ op: "call", funcIdx: pushIdx });
  });
  fctx.body.push(
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx },
  );
  if (results.length === 0) fctx.body.push({ op: "drop" });
  else if (results[0]!.kind !== "externref") coerceType(ctx, fctx, externref, results[0]!);
  fctx.body = outer;

  outer.push(
    { op: "global.get", index: flagIdx },
    {
      op: "if",
      blockType: results.length === 0 ? { kind: "empty" } : { kind: "val", type: results[0]! },
      then: slow,
      else: direct,
    },
  );
  const fn = definedFuncAt(ctx, funcIdx);
  if (fn) fn.locals = fctx.locals;
  return funcIdx;
}
