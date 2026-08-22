// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4232) Decline #3133's STATIC `.constructor → Object` fold when the receiver
 * is provably `ToObject(<primitive>)` — i.e. a primitive WRAPPER, whose
 * `.constructor` is `String`/`Number`/`Boolean`, not `Object`.
 *
 * ## Why the fold is wrong here, and why it looks right
 *
 * `new Object(str)` / `Object(5)` has TS type `Object`, so
 * `classifyPlainCtorReceiverNamespace` (property-access.ts) classifies the
 * receiver as `"Object"` and answers the `__builtin_Object` namespace singleton
 * BEFORE any runtime read happens. That fold is correct for `new Object()`,
 * `Object({})`, `Object.prototype` — every case where ToObject really does
 * produce an ordinary object. It is wrong for exactly one input class: a
 * primitive argument, where §20.1.1.1 routes to ToObject and yields a
 * String/Number/Boolean exotic wrapper.
 *
 * The failure is silent and reads as a near-miss: the assertion compares two
 * real objects (`«[object Object]» vs «[object Object]»` in the test262 text),
 * so it looks like an identity/carrier bug rather than a mis-fold. #4223's arm
 * already answers this receiver CORRECTLY at runtime — the fold just never lets
 * it run.
 *
 * ## Why the receiver EXPRESSION alone is not enough (measured)
 *
 * #4223's agent implemented and measured the obvious version — match a
 * `new Object(<primitive>)` receiver expression at the read site — and it
 * flipped **zero** files. The whole corpus binds first:
 *
 * ```js
 * var n_obj = new Object(str);   // ← the construction
 * n_obj.constructor === String;  // ← the read; receiver is a bare identifier
 * ```
 *
 * So the guard has to trace the identifier back to its initializer. That is
 * only sound if the binding is single-assignment, which `var`/`let` do not give
 * for free — hence the syntactic reassignment proof below rather than a bare
 * `oracle.variableInitializerOf`.
 *
 * ## Conservatism
 *
 * Every uncertainty answers `false` (keep the fold, keep today's behavior):
 * an unresolvable initializer, a rebound or reassigned name, a name declared
 * more than once in the file, a non-primitive or unprovable argument. A
 * `false` costs nothing new; a wrong `true` would send an ordinary object's
 * `.constructor` to the runtime path, where it currently reads `undefined`.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { bindingIsSingleAssignment } from "./single-assignment-binding.js";

/**
 * Names that are ASSIGNED, updated, or bound more than once anywhere in a
 * source file — cached per file. A name in this set cannot be traced to a
 * single initializer.
 *
 * Deliberately NAME-based, not symbol-based: a name-level answer over-rejects
 * on shadowing (two unrelated `x` bindings in different scopes both poison the
 * name) and that direction is the safe one. A symbol-based scan would be
 * sharper but has to resolve every occurrence through the checker, and the
 * extra precision buys nothing for the corpus this serves.
 */
const rebindingCache = new WeakMap<ts.SourceFile, Set<string>>();

function rebindingNames(sourceFile: ts.SourceFile): Set<string> {
  let names = rebindingCache.get(sourceFile);
  if (names !== undefined) return names;
  names = new Set<string>();
  const declared = new Set<string>();
  const poison = (n: string): void => {
    names!.add(n);
  };
  const walk = (node: ts.Node): void => {
    // `x = …`, `x += …`, and every other compound assignment.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      poison(node.left.text);
    }
    // `x++` / `--x`.
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      poison(node.operand.text);
    }
    // A second binding of the same name anywhere (redeclared `var`, a
    // parameter, a catch clause, a nested `let`) makes the name ambiguous.
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      if (declared.has(node.name.text)) poison(node.name.text);
      declared.add(node.name.text);
    }
    // A for-in/for-of loop variable is re-assigned on every iteration.
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isIdentifier(node.initializer)) {
      poison(node.initializer.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  rebindingCache.set(sourceFile, names);
  return names;
}

/**
 * Trace a receiver expression to the expression that produced its value:
 * itself, or — for a single-assignment identifier binding — its initializer.
 * `undefined` when the trace cannot be proven.
 */
function traceToProducer(ctx: CodegenContext, expr: ts.Expression): ts.Expression | undefined {
  let cur: ts.Expression = expr;
  // A short chain is enough for the corpus (`var a = new Object(x); a.ctor`);
  // the bound keeps a pathological alias chain from costing compile time.
  for (let hops = 0; hops < 4; hops++) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (!ts.isIdentifier(cur)) return cur;
    // (#4491 wave-5 T2) The name-level scan below is kept as a cheap PREFILTER:
    // a spelling nothing writes needs no checker work at all. When the spelling
    // IS written somewhere, ask the sharper per-BINDING question rather than
    // rejecting — in test262 the harness is concatenated into this same source
    // file, so short spellings (`a`, `obj`, `x`) are written by harness
    // parameters in every single file and the name-level answer is always
    // "poisoned". See single-assignment-binding.ts.
    if (rebindingNames(cur.getSourceFile()).has(cur.text) && !bindingIsSingleAssignment(ctx, cur)) return undefined;
    const init = ctx.oracle.variableInitializerOf(cur);
    if (init === undefined) return undefined;
    cur = init;
  }
  return undefined;
}

/**
 * Is `expr` a call/construct of the global `Object` whose FIRST argument is a
 * provable primitive (string / number / boolean)?
 *
 * `Object` must resolve to the ambient global: a user `function Object(){}` or
 * an imported binding is a different function entirely, and its result is not a
 * wrapper. `valueDeclarationOf` in a declaration file is the proof.
 *
 * Arity is deliberately NOT pinned to 1 — §20.1.1.1 ignores the extra
 * arguments, and `new Object(1, 2, 3)` (S15.2.2.1_A6_T1) is in the corpus.
 */
function isPrimitiveObjectCoercionCall(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isNewExpression(expr) && !ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "Object") return false;
  const decl = ctx.oracle.valueDeclarationOf(callee);
  if (decl !== undefined && !decl.getSourceFile().isDeclarationFile) return false;
  const arg = expr.arguments?.[0];
  if (arg === undefined) return false;
  const tag = ctx.oracle.staticJsTypeOf(arg);
  return tag === "string" || tag === "number" || tag === "boolean";
}

/**
 * The guard #3133's fold consults: `true` ⇒ this receiver is a primitive
 * wrapper, so the `Object` fold must stand down and let the runtime
 * `.constructor` arm (#4223's `wrapper-constructor-carrier.ts`) answer.
 *
 * Standalone-only by construction — the only caller is standalone-gated — but
 * the analysis itself is target-independent.
 */
export function receiverIsPrimitiveWrapper(ctx: CodegenContext, recvExpr: ts.Expression): boolean {
  const producer = traceToProducer(ctx, recvExpr);
  if (producer === undefined) return false;
  return isPrimitiveObjectCoercionCall(ctx, producer);
}
