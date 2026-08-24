// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4623) `<ordinary receiver>.isPrototypeOf(V)` — §20.1.3.4 — for the call
 * shapes that reach the END of `compileCallExpression`, i.e. the ones every
 * static and receiver-typed dispatcher has already declined.
 *
 * ## What was measured (2026-08-23, campaign branch `9d9291db7`)
 *
 * ```js
 * var P = { q: 1 };
 * var o = Object.create(P);
 * P.isPrototypeOf(o);          // standalone: false.  JS host: undefined.
 * ```
 *
 * The two lanes were wrong in two DIFFERENT ways, which is why the defect
 * looked like one thing from each side:
 *
 *  - **JS host** — the graceful `ref.null.extern` fallback in
 *    `stored-member-closure-call.ts`. WAT decode of `__module_init`:
 *    `global.get <P>; extern.convert_any; global.get "isPrototypeOf";
 *    call $__extern_get; drop; ref.null extern`. So the `ref.null extern` in
 *    #4506's decode is not a mis-compiled *argument* (the reading in this
 *    issue's title) — it is the CALL's whole result. The argument does not
 *    appear because the dead `global.get`/`drop` pair for it is elided later.
 *  - **standalone** — `compileTailDispatch`'s generic `ref.test`-guarded
 *    closure dispatch (`call-tail-dispatch.ts`, the #1298 fix-#3 arm). The
 *    callee's TS type (`Object.isPrototypeOf` from lib.d.ts) carries a call
 *    signature and a closure of that shape is registered, so the arm claims the
 *    call, reads the member dynamically with `__extern_get`, finds nothing, and
 *    takes its `else` branch — `ref.null extern`, coerced to the `boolean`
 *    result slot as `0`.
 *
 * Both are the "detector that cannot say I don't know": an unrecognised shape
 * is rendered as a VALUE rather than refused. One arm, placed where both lanes
 * converge, replaces both answers.
 *
 * The receivers that already work never reach here: a syntactic
 * `Object.prototype` / `Function.prototype` / `<Builtin>.prototype` receiver is
 * folded or walked by `native-is-prototype-of.ts` (#2916/#2994) and
 * `builtin-prototype-brand.ts` (#4556), and an `any`-typed receiver is resolved
 * by `tryExternClassMethodOnAny` (`calls-closures.ts`). What was uncovered is
 * the ordinary spelling on a receiver whose static type is a CLOSED object
 * shape — an object literal, a constructed instance — i.e. the ES5
 * `Object.create` / `S13.2.2` idiom.
 *
 * ## Why the chain walk is the right answer, on both lanes
 *
 * Both lanes already model the link this predicate asks about: measured on the
 * same branch, in BOTH lanes, `Object.getPrototypeOf(Object.create(P)) === P`
 * is **true**. So the receiver and the candidate are ordinary carriers whose
 * `[[Prototype]]` edge is exactly the one `__isPrototypeOf` follows:
 *
 *   - standalone/wasi → the WasmGC-native `$Object.$proto` walk registered by
 *     `object-runtime-prototype.ts` — a DEFINED function, so the host-free
 *     binary stays host-free;
 *   - JS host → the `env::__isPrototypeOf` import, which is literally
 *     `Object.prototype.isPrototypeOf.call(O, V)` (`src/runtime.ts`).
 *
 * Steps 1–2 of §20.1.3.4 (a non-object `V`, or a missing argument, is `false`)
 * are already the walk's own answers on both lanes — the native's opening
 * `ref.test (ref $Object)` fails on a primitive/null and the loop exits before
 * its first iteration; the host helper delegates to the real intrinsic.
 * Re-deriving them here would duplicate a decision the walk owns.
 *
 * ## Blast radius
 *
 * The arm runs after every other dispatcher in `compileCallExpression` has
 * declined and immediately before `compileTailDispatch`, whose only two answers
 * for this shape are the two wrong ones measured above. It cannot displace a
 * working path. It further declines, absent-not-wrong, when the module could
 * have installed its OWN `isPrototypeOf`:
 *
 *   - by assignment or `Object.defineProperty` anywhere in the file
 *     (`sourceHasMethodOverride`, #1397/#4482), or
 *   - by DECLARING a member of that name — an object-literal property, a class
 *     member, an interface/type member ({@link sourceDeclaresIsPrototypeOf}).
 *
 * Either way the call keeps its pre-existing lowering.
 *
 * ## Known residual (measured, deliberately NOT fixed here)
 *
 * `language/statements/function/S13.2.2_A1_T1/_T2` need a SECOND, independent
 * fact this arm does not provide. Measured on both lanes:
 * `function P(){}; function F(){}; F.prototype = P; var m = new F()` leaves
 * `Object.getPrototypeOf(m) === P` **false**, while the same shape with an
 * object literal (`F.prototype = {y:2}`) is true on standalone. A FUNCTION
 * assigned as `.prototype` cannot be held by the `(ref null $Object)` `$proto`
 * field — the fnctor-representation residual #4480 S2 already records in
 * `fnctor-instance-prototype.ts`. With no chain edge, a correct walk still
 * answers `false`, so those two rows stay red. See the issue file's Residuals.
 */
import ts from "typescript";

import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { coerceType, compileExpression, ensureLateImport } from "../shared.js";
import { sourceHasMethodOverride } from "./member-override-scan.js";
import { flushLateImportShifts } from "./late-imports.js";

/** The one member name this arm answers for. */
const MEMBER = "isPrototypeOf";

const _declaresCache = new WeakMap<ts.SourceFile, boolean>();

/**
 * True when the source DECLARES a member named `isPrototypeOf` — an
 * object-literal property (`{ isPrototypeOf: fn }`, shorthand, or a method),
 * a class member, or a type/interface member.
 *
 * `sourceHasMethodOverride` sees the two INSTALL routes (assignment,
 * `defineProperty`) but not a declaration, and a declared member is just as
 * much a program-owned `isPrototypeOf` as an assigned one. Whole-file and
 * cached, in the conservative direction: a false positive costs only this
 * arm's answer for that file, where the pre-existing lowering resumes.
 */
function sourceDeclaresIsPrototypeOf(anchor: ts.Node): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  const cached = _declaresCache.get(sf);
  if (cached !== undefined) return cached;

  let found = false;
  const named = (n: ts.PropertyName | undefined): boolean =>
    n !== undefined && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === MEMBER;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      named(node.name as ts.PropertyName)
    ) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  }
  visit(sf);
  _declaresCache.set(sf, found);
  return found;
}

/**
 * Lower `recv.isPrototypeOf(v)` as `__isPrototypeOf(recv, v)`.
 *
 * @returns the result `ValType` (a branded boolean `i32`) when the call was
 *          emitted, or `undefined` to leave the call to `compileTailDispatch`.
 */
export function tryEmitIsPrototypeOfCallArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  const callee = expr.expression;
  // `o.isPrototypeOf(v)` and its bracket twin `o["isPrototypeOf"](v)` are the
  // same §12.3.2 shape (the #4482 pairing); a non-literal key names no member
  // at compile time, so it is left alone.
  let recvExpr: ts.Expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (!ts.isIdentifier(callee.name) || callee.name.text !== MEMBER) return undefined;
    recvExpr = callee.expression;
  } else if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression;
    if (key === undefined || !ts.isStringLiteralLike(key) || key.text !== MEMBER) return undefined;
    recvExpr = callee.expression;
  } else {
    return undefined;
  }
  // Optional chaining short-circuits before the call; not this arm's job.
  if (callee.questionDotToken !== undefined || expr.questionDotToken !== undefined) return undefined;
  // §20.1.3.4 takes exactly one argument. A spread hides the count, and extra
  // arguments would still have to be evaluated in source order — both keep the
  // pre-existing lowering rather than being answered partially.
  if (expr.arguments.length > 1) return undefined;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  // A program that owns its own `isPrototypeOf` must keep whatever the existing
  // lowering does — folding to the intrinsic would answer for a method the
  // program replaced.
  if (sourceHasMethodOverride(ctx, expr, MEMBER)) return undefined;
  if (sourceDeclaresIsPrototypeOf(expr)) return undefined;

  // Reserve the walk BEFORE compiling any operand so a late funcIdx shift
  // reaches instructions that are not yet emitted (#1839/#117/#1886), then
  // re-read the index by name afterwards (compiling the operands can register
  // further helpers).
  const protoIdx = ensureLateImport(
    ctx,
    "__isPrototypeOf",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (protoIdx === undefined) return undefined;

  const pushAsExternref = (e: ts.Expression): void => {
    const t = compileExpression(ctx, fctx, e, { kind: "externref" });
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  };

  // O = the receiver, then V = the argument — the §13.3.6 evaluation order.
  pushAsExternref(recvExpr);
  const argExpr = expr.arguments[0];
  if (argExpr) pushAsExternref(argExpr);
  else fctx.body.push({ op: "ref.null.extern" });

  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__isPrototypeOf") ?? protoIdx });
  // The brand keeps `r === true` a boolean comparison rather than `1 !== true`.
  return { kind: "i32", boolean: true };
}
