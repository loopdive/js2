// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4246) The `new`-site twin of #4221's `tryNonCallableValueCall`.
//
// §13.3.5.1 EvaluateNew steps 3-5: the constructor expression is evaluated,
// then `IsConstructor(constructor)` is checked, and a value that is not a
// constructor throws a **TypeError** before any [[Construct]] happens. The
// standalone/gc `new` lowering had no arm for a callee that is provably not an
// object at all, so `new true`, `new 1`, `new "s"`, `new null`,
// `new undefined`, `var x = true; new x` and `new new Boolean(true)` all fell
// through `compileNewExpression`'s unknown-constructor path and evaluated to
// `undefined` with no throw (test262 `language/expressions/new/S11.2.2_A3_T*`,
// `_A4_T*` — 10 files, BOTH lanes).
//
// The firing conditions are deliberately the SAME two the call-site guard uses,
// because the underlying question is identical ("does the oracle PROVE this
// value has no internal method?") and the false-positive hazard is identical
// too: a wrong fire converts a working construction into a hard runtime throw.
// Reusing `NEVER_CALLABLE_FACT_KINDS`, `isEvolvingAnyBinding` and
// `isFreshlyConstructedNonCallable` from calls-guards.ts is therefore not
// incidental sharing — it keeps the two sites from drifting apart on the one
// judgement that makes either safe.
//
// Two ways [[Construct]] is narrower than [[Call]], both of which this guard
// deliberately does NOT exploit:
//
//   - An ARROW function and a prototype METHOD are callable but not
//     constructable. Both already have their own arms (`unwrapNewTarget` +
//     `classifyNonConstructableValue` in new-super.ts / non-constructable.ts);
//     re-deciding them here would duplicate a subtler analysis.
//   - A plain `function f(){}` value reached through an `any` binding is
//     constructable, and nothing in a primitive/fresh-`new` fact can describe
//     it, so it never reaches this file.
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { compileExpression } from "../shared.js";
import { emitThrowTypeError } from "./helpers.js";
import {
  NEVER_CALLABLE_FACT_KINDS,
  isEvolvingAnyBinding,
  isFreshlyConstructedNonCallable,
  unwrapCallee,
} from "./calls-guards.js";

/**
 * (#4246) `new <provably-not-a-constructor>` → TypeError.
 *
 * Returns an `externref` result when it handled (and threw for) the
 * construction; `undefined` when the callee is not provably non-constructable
 * and the caller must continue its own dispatch.
 *
 * Evaluation order follows §13.3.5.1: the constructor expression first (so
 * `new (sideEffect())` still runs it — and so `new new Boolean(true)` really
 * does construct the inner wrapper), then the argument list, then the throw.
 */
export function tryNonConstructableNewTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | undefined {
  const callee = unwrapCallee(expr.expression);
  // `new super(...)` / `new import(...)` are not value constructions.
  if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) return undefined;

  // §13.3.5.1 step 2 evaluates the constructor EXPRESSION before anything else,
  // and an unresolvable reference throws ReferenceError there (§9.1.1.1 step 3)
  // — a different error, from a different step, than the TypeError below. The
  // unknown-constructor path never compiles its callee at all, so `new x` with
  // no `x` in scope silently answered `undefined` (`S11.2.2_A2`). An identifier
  // the checker cannot resolve to ANY binding can never be a constructor, so
  // evaluating it here is safe; `compileExpression` owns the throw (and the
  // dynamic-global lookup that legitimately precedes it under runtime-eval),
  // which is why this arm delegates rather than emitting the ReferenceError
  // itself — the identifier lowering already distinguishes those two cases.
  //
  // SYNTHESIZED nodes are excluded, and that exclusion is load-bearing rather
  // than defensive: several lowerings rewrite a call/construct into a fresh
  // AST (`.call`/`.apply` reshapes, the #4246 sloppy-`this` box below, the
  // `Function.prototype.apply.call` reshape). A factory-built identifier has
  // no position and therefore no checker symbol, so it looks exactly like an
  // undeclared name — this arm would turn every such rewrite into a
  // ReferenceError.
  if (
    ts.isIdentifier(callee) &&
    !nodeIsSynthesized(callee) &&
    !isInsideWithStatementBody(callee) &&
    ctx.oracle.isUnresolvableIdentifier(callee)
  ) {
    const unresolvedType = compileExpression(ctx, fctx, callee);
    if (unresolvedType) fctx.body.push({ op: "drop" });
    for (const arg of expr.arguments ?? []) {
      const argType = compileExpression(ctx, fctx, ts.isSpreadElement(arg) ? arg.expression : arg);
      if (argType) fctx.body.push({ op: "drop" });
    }
    emitThrowTypeError(ctx, fctx, `${describeNewTarget(callee, "unresolvable")} is not a constructor`);
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  const fact = ctx.oracle.typeFactOf(callee);
  const primitiveTarget = NEVER_CALLABLE_FACT_KINDS.has(fact.kind);
  const freshObjectTarget = isFreshlyConstructedNonCallable(ctx, callee, fact.kind);
  if (!primitiveTarget && !freshObjectTarget) return undefined;

  // A primitive fact carrying a call signature is a contradiction; never throw
  // over one. (`isFreshlyConstructedNonCallable` already excludes `Function`.)
  if (primitiveTarget && ctx.oracle.signatureOf(callee) !== undefined) return undefined;
  if (isEvolvingAnyBinding(ctx, callee)) return undefined;

  const calleeType = compileExpression(ctx, fctx, callee);
  if (calleeType) fctx.body.push({ op: "drop" });
  for (const arg of expr.arguments ?? []) {
    const argType = compileExpression(ctx, fctx, ts.isSpreadElement(arg) ? arg.expression : arg);
    if (argType) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, `${describeNewTarget(callee, fact.kind)} is not a constructor`);
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * (#4246) Best-effort source text for the TypeError message. `getText()` reads
 * the source file, which a SYNTHESIZED node does not have, so a failure falls
 * back to the fact kind rather than aborting codegen — same contract as
 * `describeNonCallableCallee` in calls-guards.ts.
 */
/**
 * (#4246) A node built by `ts.factory` rather than parsed from source. Such a
 * node carries `pos === -1`, has no `SourceFile`, and — critically here — no
 * checker symbol, so it must never be read as "the name does not resolve".
 */
function nodeIsSynthesized(node: ts.Node): boolean {
  return node.pos < 0 || node.end < 0;
}

/**
 * (#3025) Is `node` lexically inside a `with` STATEMENT's body?
 *
 * The unresolvable-identifier arm above reads "the checker knows no binding for
 * this name" as "no binding exists, so `new name()` must throw". Inside a `with`
 * body that inference is invalid: TypeScript deliberately declines to resolve
 * bare identifiers there (it cannot model the Object Environment Record), so
 * `getSymbolAtLocation` answers `undefined` for names that DO resolve — even for
 * a `var` declared in the very same block:
 *
 *     with (myObj) { var f = function () { … }; var obj = new f(); }
 *
 * `f` looked unresolvable, so every `S12.10_A1.8_T*` / `S12.10_A3.8_T*` threw
 * `TypeError: f is not a constructor` instead of constructing. The `with` target
 * itself may also supply the name at runtime. Declining here costs nothing: the
 * ordinary `new` dispatch still runs, and a name that genuinely resolves to
 * nothing raises its own ReferenceError from the identifier lowering.
 */
function isInsideWithStatementBody(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {
    const parent: ts.Node | undefined = cur.parent;
    if (parent !== undefined && ts.isWithStatement(parent) && parent.statement === cur) return true;
  }
  return false;
}

function describeNewTarget(callee: ts.Expression, factKind: string): string {
  try {
    const text = callee.getText();
    if (text.length > 0 && text.length <= 40) return text;
  } catch {
    /* synthesized node — fall through to the fact kind */
  }
  return factKind;
}
