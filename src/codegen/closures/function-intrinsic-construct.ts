// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 W2a) `new <%Function% value>(…)` in `--target standalone` — the realm
 * `%Function%` reached as a VALUE rather than as the bare global identifier.
 *
 * ## The defect
 *
 * Only the bare identifier `new Function(…)` takes the #2924 compile-away
 * (`tryStaticNewFunction`, new-builtin-globals.ts). The same intrinsic reached
 * any other way did not, measured on the base with the real runner
 * (`--standalone`, QuickJS provider):
 *
 * | spelling                                         | base                          |
 * | ------------------------------------------------ | ----------------------------- |
 * | `new other.Function()` (realm global member)     | compile error rolled back → `typeof C === "undefined"` |
 * | `var OF = other.Function; new OF()`              | same                          |
 * | `var F = Function; new F()`                      | a provider function whose `prototype` reads `undefined` |
 *
 * Every `proto-from-ctor-realm` row builds its NewTarget with the first
 * spelling (`var C = new other.Function(); C.prototype = null;`).
 *
 * ## The fix — one runtime identity arm
 *
 * §20.2.1.1 `Function(…args)` is CreateDynamicFunction(%Function%, NewTarget,
 * normal, args). When the callee VALUE is `%Function%` the result is exactly
 * what the bare spelling produces, so the arm reuses the bare spelling's own
 * lowering (injected as `emitConstantFunction` — `tryStaticNewFunction`), which
 * mints a fresh ordinary function with its own `prototype` object
 * (`emitRuntimeEvalFunctionPrototypeSeed`).
 *
 * The callee and every argument are already evaluated into locals, in source
 * order, by the caller (`tryCompileNativeConstructFromValue`), so §13.3.5.1's
 * evaluation order is kept and nothing runs twice. The arm then tests the
 * callee against the realm `%Function%` with the module's own `===`
 * (`__extern_strict_eq`), NOT `ref.eq`: the provider lane publishes
 * `%Function%` through a marker whose reference is not stable across reads, so
 * `ref.eq` misses the realm-seeded `other.Function` that
 * `other.Function === Function` accepts. Any other callee value takes the
 * caller's unchanged native-construct lowering, so the callee's SPELLING only
 * decides whether the test is emitted (a byte cost), never what is
 * constructed.
 *
 * ## Scope (recorded residuals)
 *
 * - Only compile-time-constant arguments (the #2924 condition). A runtime
 *   argument list keeps the caller's previous lowering.
 * - GetPrototypeFromConstructor's §10.1.14 step-4 fallback and the
 *   bound/class/Proxy NewTarget routes are #6651 W2b, not this arm.
 *
 * Leaf module: every codegen service it needs is injected, so it adds no edge
 * to the codegen import-cycle SCC (`check:import-cycles`).
 */
import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { popBody, pushBody } from "../context/bodies.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

const EXTERNREF: ValType = { kind: "externref" };

function unwrapCallee(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A member read whose key is `Function` — `other.Function`, `g["Function"]`. */
function isFunctionNamedMemberRead(expression: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "Function";
  return (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    expression.argumentExpression.text === "Function"
  );
}

/**
 * Could the `new` callee hold the realm's `%Function%` VALUE, other than as the
 * bare global identifier (the #2924 compile-away owns that one)?
 *
 * Syntactic and over-approximate on purpose — the runtime identity test is
 * what decides, so a false positive costs one not-taken branch:
 *   - a member read named `Function` (`other.Function`, `g["Function"]`);
 *   - an identifier whose single variable initializer is, through further
 *     such identifiers, one of those reads or the bare `Function`
 *     (`var F = Function`, `var OF = other.Function`).
 *
 * `declarationOf` is injected (the oracle's `valueDeclarationOf`) so this
 * module stays a leaf.
 */
export function mayHoldFunctionIntrinsic(
  callee: ts.Expression,
  declarationOf: (id: ts.Identifier) => ts.Declaration | undefined,
): boolean {
  const seen = new Set<ts.Declaration>();
  let current = unwrapCallee(callee);
  for (let hop = 0; hop < 8; hop++) {
    if (isFunctionNamedMemberRead(current)) return true;
    if (!ts.isIdentifier(current)) return false;
    const declaration = declarationOf(current);
    if (current.text === "Function") {
      // The bare global is the compile-away's own site; only an alias of it
      // (reached through at least one hop) belongs here.
      return hop > 0 && (declaration === undefined || declaration.getSourceFile().isDeclarationFile);
    }
    if (declaration === undefined || seen.has(declaration)) return false;
    seen.add(declaration);
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer) {
      return false;
    }
    current = unwrapCallee(declaration.initializer);
  }
  return false;
}

/**
 * Standalone `new X(…)` whose callee may hold the realm `%Function%` as a
 * VALUE — {@link mayHoldFunctionIntrinsic}. A module that declares its own
 * `Function` class keeps its class arm.
 */
export function isFunctionIntrinsicValueCallee(ctx: CodegenContext, callee: ts.Expression): boolean {
  if (!ctx.standalone || ctx.classSet.has("Function")) return false;
  return mayHoldFunctionIntrinsic(callee, (id) => ctx.oracle.valueDeclarationOf(id));
}

/** The codegen services the arm needs, injected to keep this module a leaf. */
export interface FunctionIntrinsicConstructDeps {
  /** `[] → [externref]` the realm `%Function%`, or `undefined` having pushed nothing. */
  emitIntrinsic: (ctx: CodegenContext, fctx: FunctionContext) => ValType | undefined;
  /** `[] → [externref]` the bare `new Function(<args>)` lowering, or `undefined` having pushed nothing. */
  emitConstantFunction: (ctx: CodegenContext, fctx: FunctionContext) => ValType | undefined;
  /** `(externref, externref) -> i32` — the module's `===`. */
  strictEq: (ctx: CodegenContext) => number | undefined;
  /**
   * `[] → [externref]` a SECOND spelling of `%Function%` that may not be the
   * reference `emitIntrinsic` pushes, or absent. In a provider-linked module
   * that never reads the bare `Function` value, `emitIntrinsic` answers the
   * self-contained carrier while `globalThis.Function` — the read every realm
   * seed (`$262.createRealm().global.Function`) makes — answers the provider's
   * realm intrinsic (in a runtime-eval module the global object's `Function`
   * property comes from the eval boundary, not
   * `standalone-global-object-carriers.ts`). Both are the realm `%Function%`,
   * so the arm accepts either.
   */
  emitAlternateIntrinsic?: (ctx: CodegenContext, fctx: FunctionContext) => ValType | undefined;
}

/** The open arm returned by {@link beginFunctionIntrinsicConstruct}. */
export interface FunctionIntrinsicConstructArm {
  /** Close the arm: everything emitted since `begin` becomes the non-`%Function%` branch. */
  finish(): void;
}

/**
 * Open `callee === %Function% ? <new Function(args)> : <what the caller emits next>`.
 *
 * Call after the callee (in `calleeLocal`) and every argument are evaluated;
 * the caller's next emission must leave exactly one externref, and the caller
 * must call `finish()` after it. Returns `undefined` having emitted NOTHING
 * when the module is not standalone, the arguments are not compile-time
 * constants, or a helper is unavailable — the site then keeps its previous
 * lowering byte-for-byte.
 */
export function beginFunctionIntrinsicConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  calleeLocal: number,
  deps: FunctionIntrinsicConstructDeps,
): FunctionIntrinsicConstructArm | undefined {
  if (!ctx.standalone) return undefined;
  if (deps.strictEq(ctx) === undefined) return undefined;

  // Build both producers into detached bodies first, so a decline leaves the
  // caller's body untouched. A detached body stays registered with the
  // late-import shifter (`ctx.liveBodies`) until it is spliced in.
  const savedThen = pushBody(fctx);
  const fnTy = deps.emitConstantFunction(ctx, fctx);
  const thenInstrs: Instr[] = fctx.body;
  popBody(fctx, savedThen);
  if (fnTy === undefined || fnTy.kind !== "externref") {
    // `tryStaticNewFunction` declines before emitting; a non-externref result
    // never occurs, but would be a stack-type mismatch — refuse it.
    return undefined;
  }
  ctx.liveBodies.add(thenInstrs);

  const savedTest = pushBody(fctx);
  const intrinsicTy = deps.emitIntrinsic(ctx, fctx);
  const testInstrs: Instr[] = fctx.body;
  popBody(fctx, savedTest);
  ctx.liveBodies.add(testInstrs);
  let alternateInstrs: Instr[] | undefined;
  if (deps.emitAlternateIntrinsic !== undefined) {
    const savedAlternate = pushBody(fctx);
    const alternateTy = deps.emitAlternateIntrinsic(ctx, fctx);
    const instrs: Instr[] = fctx.body;
    popBody(fctx, savedAlternate);
    if (alternateTy !== undefined && alternateTy.kind === "externref") alternateInstrs = instrs;
  }
  ctx.liveBodies.delete(testInstrs);
  const strictEq = deps.strictEq(ctx);
  if (intrinsicTy === undefined || intrinsicTy.kind !== "externref" || strictEq === undefined) {
    // The constant function was hoisted but is never referenced; an unused
    // function is harmless, and declining keeps the site's previous lowering.
    ctx.liveBodies.delete(thenInstrs);
    return undefined;
  }

  fctx.body.push(...testInstrs, { op: "local.get", index: calleeLocal }, { op: "call", funcIdx: strictEq });
  if (alternateInstrs !== undefined) {
    // Short-circuit: the alternate spelling is only produced when the first
    // test missed (it runs the provider's global-Script seam).
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [...alternateInstrs, { op: "local.get", index: calleeLocal }, { op: "call", funcIdx: strictEq }],
    });
  }
  const savedElse = pushBody(fctx);
  return {
    finish(): void {
      const elseInstrs = fctx.body;
      popBody(fctx, savedElse);
      ctx.liveBodies.delete(thenInstrs);
      fctx.body.push({ op: "if", blockType: { kind: "val", type: EXTERNREF }, then: thenInstrs, else: elseInstrs });
    },
  };
}
