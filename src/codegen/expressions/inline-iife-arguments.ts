// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5207) Argument evaluation for the inline-IIFE fast path.
 *
 * Split out of `call-tail-dispatch.ts` because it must run at a specific
 * MOMENT, and the moment is the whole point: an IIFE's argument list belongs to
 * the CALLER, so it has to be compiled BEFORE `enterInlineIifeBindingScope`
 * hides the names the callee declares. Doing it inside that scope — as the
 * inline path did until #5207 — made a bare caller identifier whose name the
 * callee happened to reuse resolve to nothing and read as `null`:
 *
 *   function C(e, t) {
 *     return (function (x) { let t, n = x; return n === null ? "NULL" : n.length; })(t);
 *   }
 *   C("x", [1, 2]);   // native 2 · js2wasm silently read `t` as null
 *
 * Minifiers reuse short names constantly, so every minified bundle containing
 * an IIFE was exposed; `@js-temporal/polyfill`'s `GregorianBaseHelper`
 * constructor is exactly this shape and its era table arrived empty.
 *
 * The slots are allocated here but deliberately NOT registered in
 * `fctx.localMap`. Registering a parameter's name eagerly would shadow the
 * caller's binding for the REMAINING arguments — `(function (a, b) {…})(b, a)`
 * must read the caller's `a`. `call-tail-dispatch` binds the names to these
 * slots once the callee scope is entered, which is also the first moment the
 * body can observe them.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression } from "../shared.js";

export interface InlineIifeArguments {
  /** One slot per declared parameter, in order; not yet bound to its name. */
  readonly paramLocals: number[];
  /** The slot types, as the argument expressions actually lowered. */
  readonly paramLocalTypes: ValType[];
  /** Every slot the inlined `arguments` carrier is built from (empty if none). */
  readonly allArgLocals: { idx: number; type: ValType }[];
}

/**
 * (#5154 cluster B) Evaluate a call argument that the callee will DISCARD, for
 * its observable side effects only.
 *
 * §12.3.6.1 ArgumentListEvaluation iterates a `...spread` argument to
 * exhaustion regardless of the callee's arity, so `(function(){}(...iter))`
 * must still run `iter[Symbol.iterator]()` and every `next()` — and let any
 * abrupt completion propagate. `compileExpression` on a bare `SpreadElement`
 * produces nothing, so the whole spread (and every throw inside it) used to
 * vanish. Reuse the array-literal spread lowering, which already performs
 * GetIterator + the IteratorStep loop, and drop its result.
 */
export function compileDiscardedArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  if (ts.isSpreadElement(arg)) {
    const drive = ts.factory.createArrayLiteralExpression([arg]);
    ts.setTextRange(drive, arg);
    (drive as unknown as { parent: ts.Node }).parent = arg.parent;
    const driven = compileExpression(ctx, fctx, drive);
    if (driven) fctx.body.push({ op: "drop" });
    return;
  }
  const t = compileExpression(ctx, fctx, arg);
  if (t) fctx.body.push({ op: "drop" });
}

/** Compile an inlined IIFE's argument list in the CALLER's binding scope. */
export function compileInlineIifeArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  args: ts.NodeArray<ts.Expression>,
  iifeNeedsArguments: boolean,
): InlineIifeArguments {
  const paramLocals: number[] = [];
  const paramLocalTypes: ValType[] = [];
  const allArgLocals: { idx: number; type: ValType }[] = [];

  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    const paramName = ts.isIdentifier(param.name) ? param.name.text : `__iife_p${i}`;
    const argType = compileExpression(ctx, fctx, args[i]!);
    const localType = argType ?? { kind: "f64" as const };
    // `allocLocal` without the `localMap` half — see the file header.
    const idx = fctx.params.length + fctx.locals.length;
    fctx.locals.push({ name: paramName, type: localType });
    fctx.body.push({ op: "local.set", index: idx });
    paramLocals.push(idx);
    paramLocalTypes.push(localType);
    if (iifeNeedsArguments) allArgLocals.push({ idx, type: localType });
  }

  // Extra arguments beyond the declared parameters — caller-scope as well.
  for (let i = params.length; i < args.length; i++) {
    // A spread contributes no single argument slot to the inlined `arguments`
    // carrier, but must still be driven (#5154 B).
    if (!iifeNeedsArguments || ts.isSpreadElement(args[i]!)) {
      compileDiscardedArgument(ctx, fctx, args[i]!);
      continue;
    }
    const t = compileExpression(ctx, fctx, args[i]!);
    const localType = (t ?? { kind: "f64" as const }) as ValType;
    // No value produced — push a default so the slot is still well-typed.
    if (t === null) fctx.body.push({ op: "f64.const", value: 0 });
    const idx = allocLocal(fctx, `__iife_extra_${i}`, localType);
    fctx.body.push({ op: "local.set", index: idx });
    allArgLocals.push({ idx, type: localType });
  }

  return { paramLocals, paramLocalTypes, allArgLocals };
}
