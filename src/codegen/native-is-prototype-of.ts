// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2916) Host-free `Object.prototype.isPrototypeOf` for `--target standalone`
 * / `--target wasi`.
 *
 * ## The leak this closes
 *
 * `Object` is registered as the ROOT extern class (extern-declarations.ts), and
 * every extern class without a parent inherits its prototype methods. So any
 * `recv.isPrototypeOf(v)` whose receiver the checker types as an interface (not
 * `any`) reached `compileExternMethodCall` and emitted `env::Object_isPrototypeOf`
 * — an import a host-free binary cannot satisfy, so the module does not even
 * instantiate and the #2961 leak guard refuses the test. Measured on the ≤ES5
 * standalone baseline of 2026-08-07: **9 files name `Object_isPrototypeOf` as
 * their SOLE host import**.
 *
 * The `any`-receiver path (`tryExternClassMethodOnAny`, calls-closures.ts)
 * already answered host-free — it consults the #2994 static fold and then the
 * native `__isPrototypeOf`. This module gives the TYPED-receiver path the same
 * two-step answer, so the routing no longer depends on how well the checker
 * happened to type the receiver.
 *
 * ## The lowering — §20.1.3.4, two steps
 *
 * 1. **Static fold.** `tryStaticIsPrototypeOf` (#2994) proves the answer for an
 *    `Object.prototype` / `Function.prototype` receiver; `tryStaticBuiltinInstanceProto`
 *    below adds the sibling rule `X.prototype.isPrototypeOf(v)` where `v`'s type
 *    IS the builtin instance interface `X` (`new Number(2)` bound to a `var`,
 *    the `S15.7.2.1_A2` / `S15.10.4.1_A7_T2` shape). Both operands are still
 *    compiled and dropped, so evaluation order and side effects are preserved.
 * 2. **Native chain walk.** Otherwise call `__isPrototypeOf(recv, v)`, which
 *    `ensureLateImport` resolves to the WasmGC-native `$Object.$proto` walk
 *    (object-runtime-prototype.ts, #1472 Phase C) under `standalone`/`wasi` — a
 *    DEFINED function, not an import.
 *
 * ## Why this cannot regress a passing test
 *
 * The branch runs ONLY under `noJsHost`, where the shape it replaces ALWAYS
 * emitted `env::Object_isPrototypeOf`. A leaking module cannot instantiate, so
 * every test reaching this code path already fails: a native answer can only
 * CONVERT a failing test, never turn a passing one into a failure. The JS-host
 * lane never enters this function and stays byte-identical.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./js-errors.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression } from "./shared.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { identifierIsWrittenTo } from "./native-ordinary-instanceof.js";

/**
 * (#2994) Statically decide `Object.prototype.isPrototypeOf(arg)` /
 * `Function.prototype.isPrototypeOf(arg)` when the receiver is written
 * syntactically as `Object.prototype` or `Function.prototype` and the argument's
 * TypeScript type makes the answer provable:
 *   - `Object.prototype.isPrototypeOf(x)`   → true for any non-primitive object
 *     value (§20.1.3.4 / §10.4 — every ordinary object's [[Prototype]] chain
 *     ends at %Object.prototype%).
 *   - `Function.prototype.isPrototypeOf(x)`  → true when `x` is callable /
 *     constructable (its chain passes through %Function.prototype%).
 * Returns `true` for a provable yes, `undefined` otherwise (fall through to the
 * existing host dispatch — conservatively no false-negatives / no behaviour
 * change for undecidable shapes).
 *
 * (#2916) Moved here from calls-closures.ts so BOTH dispatchers that can reach
 * `isPrototypeOf` — the `any`-receiver extern resolver and the typed-receiver
 * `compileExternMethodCall` — share one fold without an import cycle.
 */
export function tryStaticIsPrototypeOf(
  ctx: CodegenContext,
  receiver: ts.Expression,
  argExpr: ts.Expression | undefined,
): boolean | undefined {
  if (!argExpr) return undefined;
  if (!ts.isPropertyAccessExpression(receiver)) return undefined;
  if (receiver.name.text !== "prototype") return undefined;
  if (!ts.isIdentifier(receiver.expression)) return undefined;
  const base = receiver.expression.text;
  if (base !== "Object" && base !== "Function") return undefined;

  // A `new X()` expression always evaluates to an object (§13.3.5 EvaluateNew /
  // OrdinaryCreateFromConstructor — even a constructor that returns a
  // non-object yields the freshly-created instance), regardless of what
  // TypeScript infers for its (possibly `any`) instance type. Every object
  // descends from %Object.prototype%, so `Object.prototype.isPrototypeOf(new X())`
  // is unconditionally true.
  if (base === "Object" && isProvablyObjectValuedExpression(ctx, argExpr)) return true;

  // `ctx.oracle.typeFactOf` is the registry-free restatement of the original
  // #2994 flag test: `any`/`unknown`/`union`/`unresolvable` and every primitive
  // fact fall outside NON_PRIMITIVE_FACTS and decline, exactly as the old
  // `Any|Unknown|…|Never` mask plus the `f & Object` requirement did (a union
  // type carries the Union flag, not Object, so it declined there too).
  const fact = ctx.oracle.typeFactOf(argExpr);
  if (!NON_PRIMITIVE_FACTS.has(fact.kind)) return undefined;
  if (base === "Object") return true;
  // base === "Function": the oracle reports `function` exactly when the type has
  // a call or construct signature — the original callable test.
  return fact.kind === "function" ? true : undefined;
}

/** Oracle fact kinds that denote a non-primitive (object) value. */
const NON_PRIMITIVE_FACTS = new Set(["object", "class", "array", "tuple", "builtin", "function"]);

/**
 * (#2916) True when `expr` provably evaluates to an OBJECT regardless of the
 * type the checker infers — a `new …` expression, an object/array/function
 * literal, or a single-assignment `var`/`let`/`const` binding initialized with
 * one of those. `var __device = new __FACTORY()` in untyped JS infers `any`, so
 * the flag test above declines; the binding is nonetheless provably an object.
 *
 * The single-assignment requirement is load-bearing: a binding reassigned
 * anywhere in the file could hold a primitive at the call site, and folding to
 * `true` would then be a WRONG answer rather than a missed optimization. Any
 * write to the name — plain assignment, compound assignment, `++`/`--` — makes
 * this decline.
 */
function isProvablyObjectValuedExpression(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (ts.isNewExpression(expr) || ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) return true;
  if (!ts.isIdentifier(expr)) return false;
  const decl = ctx.oracle.valueDeclarationOf(expr);
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  if (!ts.isNewExpression(decl.initializer) && !ts.isObjectLiteralExpression(decl.initializer)) return false;
  return !identifierIsWrittenTo(expr.getSourceFile(), expr.text);
}

/**
 * Builtin constructors whose `new X(…)` result has %X.prototype% as its
 * [[Prototype]] and whose lib.d.ts INSTANCE interface is spelled exactly `X`.
 * Deliberately excludes `Array` (instances are typed `T[]`, not the interface
 * name) and every shape whose [[Prototype]] we cannot see through.
 */
const BUILTIN_INSTANCE_PROTO_NAMES = new Set([
  "Number",
  "String",
  "Boolean",
  "RegExp",
  "Date",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

/**
 * `X.prototype.isPrototypeOf(v)` → `true` when `v`'s static type is the builtin
 * INSTANCE interface `X` for a builtin whose instances are created with
 * %X.prototype% as [[Prototype]] (§20.1.3.4 over an unmodified realm). Returns
 * `undefined` — never `false` — for every undecidable shape, so the caller
 * falls through to the runtime walk.
 */
function tryStaticBuiltinInstanceProto(
  ctx: CodegenContext,
  receiver: ts.Expression,
  argExpr: ts.Expression | undefined,
): boolean | undefined {
  if (!argExpr) return undefined;
  if (!ts.isPropertyAccessExpression(receiver)) return undefined;
  if (receiver.name.text !== "prototype") return undefined;
  if (!ts.isIdentifier(receiver.expression)) return undefined;
  const base = receiver.expression.text;
  if (!BUILTIN_INSTANCE_PROTO_NAMES.has(base)) return undefined;
  // A direct `new X(…)` argument is decidable without consulting the checker.
  if (ts.isNewExpression(argExpr) && ts.isIdentifier(argExpr.expression) && argExpr.expression.text === base) {
    return true;
  }
  // Otherwise the argument's type must BE the builtin INSTANCE interface (a
  // `Number` / `RegExp` / `Error` value, not the constructor). A union declines:
  // one constituent could be a primitive at the call site.
  if (ctx.oracle.typeFactOf(argExpr).kind === "union") return undefined;
  return ctx.oracle.declaredNameOf(argExpr) === base ? true : undefined;
}

/**
 * Answer `receiver.isPrototypeOf(arg)` without the extern-class host import:
 * the #2994 static folds first (BOTH lanes — this is where the gc lane's fold
 * lives too), then, host-free only, the native `$Object.$proto` walk. Leaves an
 * i32 (0/1) on the stack and returns its type, or `null` to decline — in which
 * case the caller falls through to its existing host dispatch unchanged.
 */
export function tryEmitStaticOrNativeIsPrototypeOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  callExpr: ts.CallExpression,
): InnerResult | null {
  const argExpr = callExpr.arguments[0];

  const staticResult =
    tryStaticIsPrototypeOf(ctx, receiver, argExpr) ?? tryStaticBuiltinInstanceProto(ctx, receiver, argExpr);
  if (staticResult !== undefined) {
    // §20.1.3.4 evaluates the receiver then the argument before the walk, so
    // both are still compiled (and their values discarded) for side effects.
    const recvType = compileExpression(ctx, fctx, receiver);
    if (recvType !== null) fctx.body.push({ op: "drop" });
    if (argExpr) {
      const argType = compileExpression(ctx, fctx, argExpr);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: staticResult ? 1 : 0 });
    return { kind: "i32", boolean: true };
  }
  // The runtime walk exists ONLY host-free; gc/host keeps its `env::` dispatch.
  if (!noJsHost(ctx)) return null;

  // Reserve the walk helper BEFORE any operand is compiled so a late funcIdx
  // shift reaches the already-emitted instructions through `currentFunc`. Under
  // standalone/wasi this resolves to the native `$Object.$proto` walk, so no
  // `env::` import is added.
  const protoIdx = ensureLateImport(
    ctx,
    "__isPrototypeOf",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (protoIdx === undefined) return null;

  // (#4480 S2, NOT taken — recorded because the absence is the finding) A
  // `F.prototype` receiver could additionally admit the BESPOKE-STRUCT
  // representation of `F`'s instances via `ref.test (ref $__fnctor_F)`, which
  // is what makes `x instanceof F` work in native-user-instanceof.ts and is
  // invisible to the `$Object.$proto` walk below (its opening
  // `ref.test (ref $Object)` fails on that struct, so the loop exits before its
  // first iteration and the walk answers 0). That arm was implemented and
  // MEASURED to be unreachable on this branch: writing `F.prototype.isPrototypeOf(i)`
  // is itself a dynamic method use on `F`'s prototype, so the #2660 escape gate
  // demotes `F` out of the approved set and `resolveUserFnctorName` — the
  // precondition that keeps the answer consistent with what `F.prototype`
  // READS — declines. Instrumented compile of
  // `function F(){this.x=1}; var i = new F(); F.prototype.isPrototypeOf(i)`
  // reports `struct=108 resolve=undefined`, versus `struct=17 resolve=F` for
  // the same module with `Object.getPrototypeOf(i)`. So the blocker for this
  // read point is the escape gate, not the walk; see the issue file's
  // Residuals section.
  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType && recvType.kind !== "externref") coerceType(ctx, fctx, recvType, { kind: "externref" });
  else if (!recvType) fctx.body.push({ op: "ref.null.extern" });
  if (argExpr) {
    const argType = compileExpression(ctx, fctx, argExpr);
    if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
    else if (!argType) fctx.body.push({ op: "ref.null.extern" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  // Re-read the index: compiling the operands may have registered helpers.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__isPrototypeOf") ?? protoIdx });
  return { kind: "i32", boolean: true };
}
