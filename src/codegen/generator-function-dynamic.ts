// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A9) Calling or constructing `%GeneratorFunction%` in standalone mode.
 *
 * `GeneratorFunction(p1, …, pn, body)` and `new GeneratorFunction(…)` are both
 * CreateDynamicFunction with kind "generator" (§27.3.1.1, §20.2.1.1.1): the
 * source text is parsed at run time. A standalone module cannot parse, so — like
 * `Function(…)` — the work goes to the linked runtime-eval provider.
 *
 * ## Why the realm's own `GeneratorFunction`, and not a new provider entry
 *
 * The provider ABI (`js2wasm:runtime-eval`) is shared by three engines
 * (QuickJS, the bytecode interpreter, the refusal provider) and
 * `__runtime_new_function` has no kind parameter. Instead of widening that ABI,
 * this lowering asks the realm for ITS `%GeneratorFunction%` once (an indirect
 * eval of `(function* () {}).constructor`, memoized in a module global) and
 * calls it with the caller's arguments through the ordinary interpreted-callable
 * bridge (`__apply_closure`). The engine then performs the whole of
 * CreateDynamicFunction itself — ToString of every argument in order, the
 * parameter/body early errors (`yield` in a parameter is a SyntaxError), the
 * `anonymous` name, `length`, and the source text `toString` reports.
 *
 * The generator OBJECTS those functions return live in the realm and cross out
 * with their protocol methods (`scripts/quickjs-eval-provider.mjs`,
 * `qjsPublishGenerator`), so `.next()`/`.return()`/`.throw()` work from compiled
 * code; the generator state never leaves the engine.
 *
 * ## The claim, and the guard that keeps it sound
 *
 * A site is claimed only when the runtime-eval inventory recorded it
 * (`isStaticGeneratorFunctionConstructorSyntax`) AND, for an identifier callee,
 * the binding is never reassigned and its initializer precedes the read. That
 * still cannot see a hoisted function calling through the binding before its
 * initializer ran, or a program that redefined
 * `%GeneratorFunction.prototype%.constructor`, so the emitted code compares the
 * callee VALUE with the reified `%GeneratorFunction%` and throws the TypeError a
 * non-callable callee throws when they differ.
 *
 * ## The value's own `prototype`
 *
 * §20.2.1.1.1 step 34 gives a generator function a fresh `prototype` whose
 * `[[Prototype]]` is `%GeneratorPrototype%` ({w:T, e:F, c:F}, no
 * `constructor`). The realm's `prototype` does not cross the seam (the same
 * reason #4438 seeds one for `Function(…)`), so it is seeded here on the
 * caller-owned carrier.
 *
 * Not modelled (residuals, recorded in #6651): the value's `[[Prototype]]` is
 * `%Function.prototype%` rather than `%GeneratorFunction.prototype%` — a
 * carrier has no settable `[[Prototype]]` — and `class extends
 * GeneratorFunction` is not routed here.
 */
import type { Instr, ValType } from "../ir/types.js";
import { isStaticGeneratorFunctionConstructorSyntax } from "../ir/runtime-eval-boundary-plan.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitStandaloneIndirectEvalRuntime, ensureRuntimeEvalCallableCarrier } from "./expressions/eval-inline.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { isRuntimeEvalProviderAbsent } from "./expressions/standalone-dynamic-code.js";
import { generatorFunctionIntrinsicGlobals } from "./generator-function-intrinsic.js";
import { emitRegisterDynamicGeneratorFunction } from "./object-model/generator-function-proto-arm.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { emitRuntimeEvalInterpretedCallableAdapter } from "./runtime-eval-callable.js";
import { coerceType, compileExpression, skipTransparentExpressions } from "./shared.js";
import { sourceBindingIsSingleAssignment } from "./single-assignment-binding.js";

const EXTERNREF: ValType = { kind: "externref" };
/** WasmGC abstract `eq` heap type (the encoding `__extern_strict_eq` uses). */
const EQ_HEAP_TYPE = -19;
/** `__defineProperty_value` attribute word for `prototype`: writable only. */
const PROTOTYPE_WRITABLE_ONLY = 0x01;
/** The realm source whose completion value is the realm's `%GeneratorFunction%`. */
const REALM_GENERATOR_FUNCTION_SOURCE = "(function* () {}).constructor";
/** `builtinObjectGlobals` key of the memoized realm `%GeneratorFunction%`. */
const REALM_GENERATOR_FUNCTION_GLOBAL = "__runtime_eval_generator_function";

/** Did the runtime-eval inventory record `node` as a `%GeneratorFunction%` site? */
function inventoryRecorded(ctx: CodegenContext, node: ts.Node): boolean {
  const sourceFile = node.pos < 0 ? undefined : node.getSourceFile();
  if (sourceFile === undefined) return false; // synthesized node: never inventoried
  const start = node.getStart(sourceFile);
  return (
    ctx.runtimeEvalBoundaryPlan?.sites.some(
      (site) => site.kind === "generator-function-constructor" && site.start === start && site.end === node.end,
    ) ?? false
  );
}

/** Never reassigned, and its initializer precedes the read. */
function bindingPrecedesRead(ctx: CodegenContext, id: ts.Identifier): ts.Expression | undefined {
  if (!sourceBindingIsSingleAssignment(ctx, id)) return undefined;
  const init = ctx.oracle.variableInitializerOf(id);
  return init !== undefined && init.getSourceFile() === id.getSourceFile() && init.end <= id.getStart()
    ? init
    : undefined;
}

/**
 * Every binding the callee is read through is stable: an identifier callee, and
 * (#6651 A14) the identifier receiver of `P.constructor` (`var Generator =
 * Object.getPrototypeOf(function* () {}); Generator.constructor`).
 */
function calleeBindingIsStable(ctx: CodegenContext, callee: ts.Expression): boolean {
  let e = skipTransparentExpressions(callee);
  if (ts.isIdentifier(e)) {
    const init = bindingPrecedesRead(ctx, e);
    if (init === undefined) return false;
    e = skipTransparentExpressions(init);
  }
  if (!ts.isPropertyAccessExpression(e)) return true;
  const receiver = skipTransparentExpressions(e.expression);
  return !ts.isIdentifier(receiver) || bindingPrecedesRead(ctx, receiver) !== undefined;
}

/**
 * (#6651 A9) Is `id` a never-reassigned binding initialised by a claimed
 * `%GeneratorFunction%` call or construction — i.e. does it statically hold a
 * GENERATOR function, which has no `[[Construct]]`? Feeds the `new g()`
 * TypeError guard (#5141, §27.3.4).
 */
export function isDynamicGeneratorFunctionBinding(ctx: CodegenContext, id: ts.Identifier): boolean {
  let init = ctx.oracle.variableInitializerOf(id);
  while (init !== undefined && ts.isParenthesizedExpression(init)) init = init.expression;
  return (
    init !== undefined &&
    (ts.isCallExpression(init) || ts.isNewExpression(init)) &&
    isClaimedSite(ctx, init) &&
    sourceBindingIsSingleAssignment(ctx, id)
  );
}

/**
 * (#6651 A14) `Object.getPrototypeOf(g)` for `var g = GeneratorFunction(…)`.
 * §20.2.1.1.1 gives the product %GeneratorFunction.prototype% as its
 * `[[Prototype]]`, but the runtime-eval carrier has no `[[Prototype]]` slot, so
 * the answer is static — the A7 rule for a generator-expression binding: the
 * read follows the initializer in the text, and no `setPrototypeOf` /
 * `__proto__` in the file names the binding.
 */
export function isDynamicGeneratorFunctionValue(ctx: CodegenContext, expr: ts.Expression): boolean {
  const e = skipTransparentExpressions(expr);
  if (!ts.isIdentifier(e) || !isDynamicGeneratorFunctionBinding(ctx, e)) return false;
  const init = ctx.oracle.variableInitializerOf(e);
  if (init === undefined || init.getSourceFile() !== e.getSourceFile() || init.end > e.getStart()) return false;
  let replaced = false;
  const visit = (node: ts.Node): void => {
    if (replaced) return;
    const parent = node.parent as ts.Node | undefined;
    if (ts.isIdentifier(node) && node.text === e.text && parent !== undefined) {
      const key =
        ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? parent.name.text
          : ts.isElementAccessExpression(parent) && ts.isStringLiteralLike(parent.argumentExpression)
            ? parent.argumentExpression.text
            : undefined;
      const callee = ts.isCallExpression(parent) ? skipTransparentExpressions(parent.expression) : undefined;
      replaced =
        key === "__proto__" ||
        (callee !== undefined && ts.isPropertyAccessExpression(callee) && callee.name.text === "setPrototypeOf");
    }
    ts.forEachChild(node, visit);
  };
  visit(e.getSourceFile());
  return !replaced;
}

function isClaimedSite(ctx: CodegenContext, node: ts.CallExpression | ts.NewExpression): boolean {
  if (!ctx.standalone || isRuntimeEvalProviderAbsent(ctx)) return false;
  if ((node.arguments ?? []).some(ts.isSpreadElement)) return false;
  return (
    isStaticGeneratorFunctionConstructorSyntax(node.expression, ctx.oracle) &&
    inventoryRecorded(ctx, node) &&
    calleeBindingIsStable(ctx, node.expression)
  );
}

/**
 * Lower a claimed `%GeneratorFunction%(…)` / `new %GeneratorFunction%(…)`, or
 * return `undefined` (nothing emitted) so the caller keeps its existing path.
 */
export function tryEmitDynamicGeneratorFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  node: ts.CallExpression | ts.NewExpression,
): ValType | undefined {
  if (!isClaimedSite(ctx, node)) return undefined;
  if (!ensureRuntimeEvalCallableCarrier(ctx, fctx)) return undefined;
  ensureObjectRuntime(ctx);
  // The one piece that can decline is built first, detached, so a decline
  // leaves the caller's fallback an untouched body. It stays in `liveBodies`
  // until spliced, so late-import index shifts reach it.
  const fetch: Instr[] = [];
  const savedBody = fctx.body;
  ctx.liveBodies.add(savedBody);
  ctx.liveBodies.add(fetch);
  fctx.body = fetch;
  let fetched: ValType | undefined;
  try {
    fetched = emitStandaloneIndirectEvalRuntime(ctx, fctx, [
      ts.factory.createStringLiteral(REALM_GENERATOR_FUNCTION_SOURCE),
    ]);
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  try {
    return fetched === undefined ? undefined : emitClaimedSite(ctx, fctx, node, fetch);
  } finally {
    ctx.liveBodies.delete(fetch);
  }
}

function emitClaimedSite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  node: ts.CallExpression | ts.NewExpression,
  fetch: Instr[],
): ValType {
  // Evaluation order (§13.3.6.1 / §13.3.5.1): the callee, then every argument.
  const calleeLocal = allocLocal(fctx, `__genfn_callee_${fctx.locals.length}`, EXTERNREF);
  const calleeType = compileExpression(ctx, fctx, node.expression, EXTERNREF);
  if (calleeType === null) emitUndefined(ctx, fctx);
  else if (calleeType.kind !== "externref") coerceType(ctx, fctx, calleeType, EXTERNREF);
  fctx.body.push({ op: "local.set", index: calleeLocal });
  const argLocals: number[] = [];
  for (const arg of node.arguments ?? []) {
    const local = allocLocal(fctx, `__genfn_arg_${fctx.locals.length}`, EXTERNREF);
    const type = compileExpression(ctx, fctx, arg, EXTERNREF);
    if (type === null) emitUndefined(ctx, fctx);
    else if (type.kind !== "externref") coerceType(ctx, fctx, type, EXTERNREF);
    fctx.body.push({ op: "local.set", index: local });
    argLocals.push(local);
  }

  // Guard: the callee must BE `%GeneratorFunction%` (see the module note). The
  // intrinsic globals are READ, never built here (`generatorFunctionIntrinsicGlobals`).
  const intrinsics = generatorFunctionIntrinsicGlobals(ctx);
  const calleeAny = allocLocal(fctx, `__genfn_callee_any_${fctx.locals.length}`, { kind: "anyref" });
  const notCallable = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    ts.isNewExpression(node) ? "value is not a constructor" : "value is not a function",
    { flush: fctx },
  );
  fctx.body.push(
    { op: "local.get", index: calleeLocal },
    { op: "any.convert_extern" },
    { op: "local.tee", index: calleeAny },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: calleeAny },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "global.get", index: intrinsics.ctor },
        { op: "any.convert_extern" },
        { op: "ref.cast_null", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: notCallable },
  );

  // The realm's `%GeneratorFunction%`, fetched once.
  const realmLocal = allocLocal(fctx, `__genfn_realm_${fctx.locals.length}`, EXTERNREF);
  const memoIdx = realmGeneratorFunctionGlobal(ctx);
  fctx.body.push(
    { op: "global.get", index: memoIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [...fetch, { op: "global.set", index: memoIdx }] },
    { op: "global.get", index: memoIdx },
    { op: "local.set", index: realmLocal },
  );

  // F = realmGeneratorFunction(...args) — the realm runs CreateDynamicFunction.
  const applyIdx = reserveApplyClosure(ctx);
  const { newIdx: vecNewIdx, pushIdx: vecPushIdx } = ensureObjVecBuilders(ctx);
  const vecLocal = allocLocal(fctx, `__genfn_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: vecNewIdx }, { op: "local.set", index: vecLocal });
  for (const local of argLocals) {
    fctx.body.push(
      { op: "local.get", index: vecLocal },
      { op: "local.get", index: local },
      { op: "call", funcIdx: vecPushIdx },
    );
  }
  fctx.body.push({ op: "local.get", index: realmLocal });
  emitUndefined(ctx, fctx);
  fctx.body.push({ op: "local.get", index: vecLocal }, { op: "call", funcIdx: applyIdx });
  emitRuntimeEvalInterpretedCallableAdapter(ctx, fctx);
  seedGeneratorPrototype(ctx, fctx, intrinsics.generatorPrototype);
  emitRegisterDynamicGeneratorFunction(ctx, fctx); // (#6651 W8) its [[Prototype]]
  return EXTERNREF;
}

/**
 * `F.prototype = OrdinaryObjectCreate(%GeneratorPrototype%)`, {w:T, e:F, c:F}
 * (§20.2.1.1.1 step 34). Consumes F from the stack and leaves it there. The
 * prototype singleton is non-null here: the guard above only passes once the
 * `%GeneratorFunction%` init body — which also builds it — has run.
 */
function seedGeneratorPrototype(ctx: CodegenContext, fctx: FunctionContext, generatorPrototypeGlobal: number): void {
  const fnLocal = allocLocal(fctx, `__genfn_value_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: fnLocal });
  const createIdx = ctx.funcMap.get("__object_create");
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (createIdx !== undefined && defineIdx !== undefined) {
    addStringConstantGlobal(ctx, "prototype");
    fctx.body.push(
      { op: "local.get", index: fnLocal },
      ...stringConstantExternrefInstrs(ctx, "prototype"),
      { op: "global.get", index: generatorPrototypeGlobal },
      { op: "call", funcIdx: createIdx },
      { op: "f64.const", value: PROTOTYPE_WRITABLE_ONLY },
      { op: "call", funcIdx: defineIdx },
      { op: "drop" },
    );
  }
  fctx.body.push({ op: "local.get", index: fnLocal });
}

/** The mutable externref global that memoizes the realm's `%GeneratorFunction%`. */
function realmGeneratorFunctionGlobal(ctx: CodegenContext): number {
  let idx = ctx.builtinObjectGlobals.get(REALM_GENERATOR_FUNCTION_GLOBAL);
  if (idx === undefined) {
    idx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: REALM_GENERATOR_FUNCTION_GLOBAL,
      type: EXTERNREF,
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.builtinObjectGlobals.set(REALM_GENERATOR_FUNCTION_GLOBAL, idx);
  }
  return idx;
}
