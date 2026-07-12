// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3141 — self-hosted stdlib driver (pilot: Math helpers).
 *
 * Compiles a builtin written as ORDINARY TypeScript source (see
 * `src/stdlib/math.ts`) through the compiler's OWN pipeline —
 * `lowerFunctionAstToIr` (front-end) → IR hygiene passes →
 * `lowerIrFunctionToWasm` (BackendEmitter) — and registers the result as
 * a defined function, exactly where the hand-emitted `Instr[]` bodies
 * used to be pushed. This is the porffor model: builtins are source the
 * compiler precompiles, not hand-assembly.
 *
 * Two-stage split (why it's cheap):
 *   1. `buildBuiltinIr` — parse + from-ast + verify + passes. The
 *      resulting `IrFunction` is CONTEXT-INDEPENDENT (all cross-function
 *      references are symbolic `IrFuncRef`s by name — spec #1131 §1.2),
 *      so it is memoized once per process and shared across compilations.
 *      The IR is never mutated after the pass pipeline (lowering only
 *      reads it), which is what makes the memoization sound.
 *   2. `emitSelfHostedMathFunc` — per compilation, lower the memoized IR
 *      against the LIVE CodegenContext. Symbol resolution happens here:
 *      `IrFuncRef("Math_exp")` → `ctx.funcMap` (the sibling helper
 *      registered moments earlier by `emitInlineMathFunctions`), and the
 *      function's own type is interned through the shared `addFuncType`
 *      registry. The produced body is plain `Instr[]` with absolute call
 *      indices — the same shape the hand-written bodies had, so every
 *      downstream pass (late-import index fixups, DCE, binary emit)
 *      treats it identically.
 *
 * Scope guard: the pilot's builtins are pure-f64 leaf math. Their IR
 * must never reference globals, named types, strings, objects, closures,
 * or vecs — the resolver below throws on all of those, which turns any
 * accidental dialect growth in `src/stdlib/math.ts` into a loud compile
 * error instead of a miscompile.
 *
 * #3161 — generalized typed path (`SelfHostedFuncDef` / `emitSelfHostedFunc`):
 * the scale-up families (array-methods #3159, object-runtime #3160) need
 * builtins whose params/returns/callees are NOT unary f64: externref
 * params, void kernels, i32 results, and ctx-bound `ref_null { typeIdx }`
 * raw-array params. The generalized path carries explicit positional
 * param types + a typed callee map, flowing through from-ast's existing
 * `paramTypeOverrides` / `returnTypeOverride`. It is deliberately NOT
 * process-memoized: a `typeIdx` inside a def's types is only meaningful
 * in the CodegenContext that registered it, so the IR must be rebuilt
 * per emission. That costs little — `emitSelfHostedFunc` early-returns
 * via `ctx.funcMap` (once per compilation, the same lifecycle the hand
 * `Instr[]` bodies had). The global/named-type scope guard stays: raw
 * ValType refs (`ref_null`) are `val`-kind and never hit `resolveType`,
 * while any accidental use of module globals or symbolic named types in
 * stdlib source remains a loud compile error.
 *
 * Caller-side dialect rule: from-ast validates direct-call args by EXACT
 * IrType equality (`irTypeArgAssignable`) — declare numeric index params
 * as `f64` in callee sigs (kernels trunc internally); there is no
 * implicit f64→i32 argument coercion. Params whose type isn't spellable
 * as a TS primitive should be annotated `unknown` in the source (a
 * non-primitive annotation defers to the positional override). Void
 * builtins must end with an explicit `return;` — a loop is not a valid
 * tail statement in the IR subset (`lowerTail`).
 */

import { ts } from "../ts-api.js";
import { lowerFunctionAstToIr } from "../ir/from-ast.js";
import { irVal, type IrFunction, type IrType } from "../ir/nodes.js";
import { constantFold } from "../ir/passes/constant-fold.js";
import { deadCode } from "../ir/passes/dead-code.js";
import { simplifyCFG } from "../ir/passes/simplify-cfg.js";
import { verifyIrFunction } from "../ir/verify.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../ir/lower.js";
import type { StdlibMathBuiltin } from "../stdlib/math.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";

const F64: IrType = irVal({ kind: "f64" });

/**
 * #3161 — a self-hosted builtin with an explicit typed signature. The
 * generalized shape behind the `StdlibMathBuiltin` pilot descriptor:
 * positional param types + a typed callee map instead of the pilot's
 * implicit "everything is unary f64".
 *
 * `paramTypes` is positional and override-authoritative: a param whose
 * type has no TS-primitive spelling (externref, `ref_null { typeIdx }`)
 * should be annotated `unknown` in `source` — from-ast's `resolveIrType`
 * defers non-primitive annotations to the override, and REJECTS a
 * primitive annotation that disagrees with it (typo guard).
 * `returnType: null` means void (zero Wasm results; bare `return;` /
 * fall-through tails, statement-position calls only — #1228 / #2856 C4).
 */
export interface SelfHostedFuncDef {
  /** funcMap registration name — also the function's name in `source`. */
  readonly name: string;
  /** Ordinary TS source, IR-claimable subset. */
  readonly source: string;
  /** Positional param IrTypes (may carry ctx-bound typeIdx refs). */
  readonly paramTypes: readonly IrType[];
  /** Return IrType; null == void. */
  readonly returnType: IrType | null;
  /** Typed signatures for every direct callee in `source`. */
  readonly calleeTypes: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  /**
   * Optional process-lifetime memo key. Set ONLY for a CONTEXT-FREE def —
   * one whose `paramTypes` / `returnType` / callee sigs carry no ctx-bound
   * `{ typeIdx }` ref (all abstract scalars / string / externref). The
   * memoized `IrFunction` is shared across every compilation, so a def with
   * a ctx-relative type must NOT set this (its typeIdx would leak across
   * contexts). The math family (all `(f64) -> f64`) sets it (keyed by
   * builtin name); the generalized families (raw-array/typeIdx params)
   * leave it unset and rebuild per emission — bounded to once per
   * compilation by `emitSelfHostedFunc`'s funcMap early-return.
   */
  readonly memoKey?: string;
}

/** Process-lifetime cache: memoKey → immutable, context-free IR. */
const irCache = new Map<string, IrFunction>();

/**
 * #3161 — parse a typed self-hosted builtin's TS source and lower it to
 * a verified, optimized `IrFunction`.
 *
 * Memoized ONLY when `def.memoKey` is set (a context-free def — see the
 * field doc). A def carrying ctx-bound `{ typeIdx }` refs leaves memoKey
 * unset and is rebuilt per emission, because a memoized IR would leak a
 * typeIdx that is only meaningful in the registering CodegenContext;
 * `emitSelfHostedFunc`'s funcMap early-return bounds that rebuild to once
 * per compilation.
 *
 * Exported separately from the emit glue so the widened dialect shapes
 * are unit-testable without constructing a CodegenContext (the build
 * stage is a pure function of the def).
 */
export function buildSelfHostedIr(def: SelfHostedFuncDef): IrFunction {
  if (def.memoKey !== undefined) {
    const cached = irCache.get(def.memoKey);
    if (cached) return cached;
  }
  const sourceFile = ts.createSourceFile(
    `stdlib/${def.name}.ts`,
    def.source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const fnDecl = sourceFile.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === def.name,
  );
  if (!fnDecl) {
    throw new Error(`stdlib-selfhost: source for ${def.name} has no matching function declaration`);
  }
  if (fnDecl.parameters.length !== def.paramTypes.length) {
    throw new Error(
      `stdlib-selfhost: ${def.name} declares ${fnDecl.parameters.length} params but paramTypes has ${def.paramTypes.length}`,
    );
  }

  const { main, lifted } = lowerFunctionAstToIr(fnDecl, {
    funcName: def.name,
    exported: false,
    calleeTypes: def.calleeTypes,
    paramTypeOverrides: def.paramTypes,
    returnTypeOverride: def.returnType,
  });
  if (lifted.length > 0) {
    throw new Error(`stdlib-selfhost: ${def.name} unexpectedly produced ${lifted.length} lifted functions`);
  }

  const buildErrors = verifyIrFunction(main);
  if (buildErrors.length > 0) {
    throw new Error(`stdlib-selfhost: IR verify failed for ${def.name}: ${buildErrors[0]!.message}`);
  }

  // Same hygiene pipeline integration.ts runs (constantFold → deadCode →
  // simplifyCFG to fixpoint; each pass returns the same reference when it
  // makes no change).
  let ir = main;
  for (let iter = 0; iter < 10; iter++) {
    const next = simplifyCFG(deadCode(constantFold(ir)));
    if (next === ir) break;
    ir = next;
  }

  const postErrors = verifyIrFunction(ir);
  if (postErrors.length > 0) {
    throw new Error(`stdlib-selfhost: post-pass IR verify failed for ${def.name}: ${postErrors[0]!.message}`);
  }

  if (def.memoKey !== undefined) irCache.set(def.memoKey, ir);
  return ir;
}

/**
 * Build the generalized `SelfHostedFuncDef` for a math-pilot builtin.
 * Sibling math helpers are all unary `(f64) -> f64`; the f64 param/return
 * overrides agree with the sources' `: number` annotations (enforced by
 * from-ast's `resolveIrType`), so lowering through the generalized builder
 * yields IR identical to the pilot's un-overridden path. Context-free, so
 * `memoKey` is set to the builtin name.
 */
function mathBuiltinDef(builtin: StdlibMathBuiltin): SelfHostedFuncDef {
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  for (const callee of builtin.callees) {
    calleeTypes.set(callee, { params: [F64], returnType: F64 });
  }
  return {
    name: builtin.name,
    source: builtin.source,
    paramTypes: [F64],
    returnType: F64,
    calleeTypes,
    memoKey: builtin.name,
  };
}

/**
 * #3161 — lower a typed self-hosted builtin against the live context and
 * register it as a defined function under `def.name`. Same registration
 * discipline as the math path (stable-regime mint + push, funcMap entry,
 * `exported: false`) so call sites cannot tell the difference from the
 * hand-emitted `Instr[]` body it replaces.
 *
 * Idempotent: early-returns the existing funcIdx when `def.name` is
 * already registered (mirrors the `ensure*` convention of the hand
 * emitters this replaces).
 *
 * Precondition: every callee in `def.calleeTypes` that the source
 * actually calls is already registered in `ctx.funcMap` (families
 * convert leaf-first; retained hand kernels are emitted before the
 * self-hosted bodies that call them).
 */
export function emitSelfHostedFunc(ctx: CodegenContext, def: SelfHostedFuncDef): number {
  const existing = ctx.funcMap.get(def.name);
  if (existing !== undefined) return existing;

  const ir = buildSelfHostedIr(def);
  const funcIdx = lowerAndRegister(ctx, def.name, ir);
  return funcIdx;
}

/** Shared lowering + registration glue for both driver paths. */
function lowerAndRegister(ctx: CodegenContext, name: string, ir: IrFunction): number {
  const resolver: IrLowerResolver = {
    resolveFunc(ref) {
      const idx = ctx.funcMap.get(ref.name);
      if (idx === undefined) {
        throw new Error(
          `stdlib-selfhost: ${name} calls "${ref.name}" but it is not registered yet — ` +
            `emit callees leaf-first (check the family's phase ordering)`,
        );
      }
      return idx;
    },
    resolveGlobal(ref) {
      throw new Error(`stdlib-selfhost: ${name} must not reference globals (got "${ref.name}")`);
    },
    resolveType(ref) {
      throw new Error(`stdlib-selfhost: ${name} must not reference named types (got "${ref.name}")`);
    },
    internFuncType(type) {
      return addFuncType(ctx, type.params, type.results, type.name);
    },
  };

  const { func } = lowerIrFunctionToWasm(ir, resolver);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx: func.typeIdx,
    locals: func.locals,
    body: func.body,
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * Lower a self-hosted math builtin against the live context and register
 * it as a defined function under `builtin.name`. Mirrors the hand path's
 * `addMathFunc` registration discipline (stable-regime mint + push,
 * funcMap entry) so call sites cannot tell the difference.
 *
 * Precondition: every name in `builtin.callees` is already registered in
 * `ctx.funcMap` (emitInlineMathFunctions emits Phase-1 cores first).
 *
 * Thin adapter over the generalized `emitSelfHostedFunc` — the math pilot
 * and scale-up families share one emit path (the def carries a `memoKey`
 * so the context-free math IR is still process-cached).
 */
export function emitSelfHostedMathFunc(ctx: CodegenContext, builtin: StdlibMathBuiltin): number {
  return emitSelfHostedFunc(ctx, mathBuiltinDef(builtin));
}
