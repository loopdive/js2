// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Receiver-correct direct `.call` for stable named function declarations.
 *
 * A named FunctionDeclaration is emitted as a plain Wasm function. Its own
 * `this` reads the ambient `__current_this` slot, but the legacy
 * `fn.call(thisArg, ...args)` path evaluated and discarded `thisArg` before
 * calling that exact function. This module reserves one exact-target
 * trampoline whose ABI is `(externref thisArg, ...targetParams) ->
 * targetResults`.
 *
 * The live-receiver arm saves/installs/restores `__current_this`. Restoration
 * is exception-safe: catch_all restores the prior receiver and rethrows the
 * original exception. A null receiver uses the pre-existing unbound exact call
 * instead, so this narrow fast path does not redefine the legacy nullish case.
 *
 * That last sentence is load-bearing for admission (#4025): because the split
 * is on the receiver's RUNTIME value, the gate does not need — and must not
 * demand — a static proof of non-nullishness. See `factIsStaticallyNullish`.
 */
import { ts } from "../ts-api.js";
import type { TypeFact } from "../checker/oracle.js";
import type { FuncHandle, Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { explicitNullReceiverLane, explicitNullThisExternInstrs } from "./explicit-null-receiver.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { bodyReferencesOwnThis } from "./helpers/body-references-own-this.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { thisReceiverIsGlobalObject } from "./helpers/sloppy-this-global.js";
import { addFuncType } from "./registry/types.js";
import { ensureExnTag } from "./registry/imports.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";
import { buildStandardTryTable } from "../ir/try-table.js";

interface NamedThisCallTarget {
  readonly trampolineFuncIdx: FuncHandle;
}

interface CachedTrampoline {
  readonly funcIdx: FuncHandle;
  readonly func: WasmFunction;
}

const trampolineCache = new WeakMap<CodegenContext, WeakMap<WasmFunction, CachedTrampoline>>();

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * (#4025) Is the receiver's static type nullish through and through?
 *
 * This is deliberately the NEGATIVE of "proven non-nullish". The gate used to
 * demand a *proof of non-nullishness*, which no `any`/`unknown`/unresolvable
 * receiver can ever supply — so every untyped-JS receiver (the entire corpus
 * this path exists for) fell through to the generic lowering, which evaluates
 * `thisArg` and DROPS it. That was a silent wrong answer, not a refusal.
 *
 * A statically-unprovable receiver is safe to admit because the trampoline
 * splits on the receiver's runtime value (`ref.is_null`) and routes a null one
 * to the pre-existing unbound exact call — verified against the emitted body
 * in `ensureNamedThisCallTrampoline` below. Only a receiver the oracle can
 * prove is *always* nullish stays out of the fast arm: emitting a trampoline
 * whose null branch is the only reachable one is pure cost, and keeping those
 * shapes (`f.call(null)`, `f.call(undefined)`) bit-identical to the legacy
 * lowering is what keeps the `this === undefined` test262 rows passing.
 *
 * `void` counts as nullish here for a second reason: a void-typed receiver
 * expression is the one shape whose compiled form could leave no value on the
 * stack at all.
 */
function factIsStaticallyNullish(fact: TypeFact): boolean {
  if (fact.kind === "union") {
    return fact.parts.length > 0 && fact.parts.every((part) => factIsStaticallyNullish(part));
  }
  return fact.kind === "null" || fact.kind === "undefined" || fact.kind === "void";
}

/**
 * (#4203) Nullish through and through AND never `undefined`/`void` — i.e. the
 * receiver is provably the value `null`.
 *
 * `factIsStaticallyNullish` above lumps `null` and `undefined` together because
 * the legacy lowering answered the same thing for both. It no longer does: a
 * STRICT callee must see `null` for `f.call(null)` and `undefined` for
 * `f.call(undefined)`. Only the first is admitted to the trampoline, because
 * only the first has a marker; `undefined` keeps the legacy drop-and-fall-
 * through, which already produces the right answer through the body's
 * `ref.is_null` arm.
 */
function factIsStaticallyNull(fact: TypeFact): boolean {
  if (fact.kind === "union") {
    return fact.parts.length > 0 && fact.parts.every((part) => factIsStaticallyNull(part));
  }
  return fact.kind === "null";
}

function receiverIsAdmitted(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  explicitNullAdmitted: boolean,
): boolean {
  const inner = unwrap(receiver);
  // Acorn's exact wrappers use `finishNodeAt.call(this, ...)`. A body whose
  // own `this` is live reads the receiver installed by the enclosing method
  // dispatch. The trampoline still runtime-splits a null value to the legacy
  // unbound call, so a detached/nullish reach does not enter the fast arm.
  if (inner.kind === ts.SyntaxKind.ThisKeyword) {
    return fctx.readsCurrentThis === true || thisReceiverIsGlobalObject(ctx, fctx, inner);
  }
  const fact = ctx.oracle.typeFactOf(inner);
  if (!factIsStaticallyNullish(fact)) return true;
  // (#4203) A provably-null receiver is worth a trampoline only when the null
  // arm now says something new — i.e. the target is strict and the marker is
  // available. For a sloppy target the trampoline's null arm and the legacy
  // lowering agree (both end at the global object), so admitting it would be
  // pure cost and a gratuitous byte diff.
  return explicitNullAdmitted && factIsStaticallyNull(fact);
}

function resolveDeclaration(ctx: CodegenContext, callee: ts.Identifier): ts.FunctionDeclaration | undefined {
  const declaration = ctx.oracle.valueDeclarationOf(callee);
  // This slice only has an exact allocator identity for unique source-file
  // declarations. Requiring the declaration in the callee's source file also
  // refuses imported aliases without exposing checker Symbols outside Oracle.
  // Nested declarations can shadow a top-level function with the same funcMap
  // key; name equality is not declaration identity.
  if (
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.body === undefined ||
    declaration.name?.text !== callee.text ||
    declaration.asteriskToken !== undefined ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true ||
    declaration.parent !== declaration.getSourceFile() ||
    declaration.getSourceFile() !== callee.getSourceFile()
  ) {
    return undefined;
  }
  return declaration;
}

function declarationOwnsHandle(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  targetFuncIdx: FuncHandle,
): boolean {
  const registry = ctx.programAbiSourceCallables;
  const identity = registry?.identityContext;
  const unitId = identity?.unitIdByDeclaration.get(declaration);
  return (
    unitId !== undefined &&
    identity?.declarationByUnitId.get(unitId) === declaration &&
    registry?.handleForUnit(unitId) === targetFuncIdx
  );
}

function callTarget(targetFuncIdx: FuncHandle, paramCount: number): Instr[] {
  const body: Instr[] = [];
  for (let i = 0; i < paramCount; i++) body.push({ op: "local.get", index: i + 1 });
  body.push({ op: "call", funcIdx: targetFuncIdx });
  return body;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function ensureNamedThisCallTrampoline(
  ctx: CodegenContext,
  targetName: string,
  targetFuncIdx: FuncHandle,
  targetFunc: WasmFunction,
  params: readonly ValType[],
  results: readonly ValType[],
  // (#4203) Emit the marker-installing null arm instead of the plain unbound
  // call. True only for a STRICT target on the standalone/native-strings lane.
  markerNullArm: boolean,
): FuncHandle {
  let byTarget = trampolineCache.get(ctx);
  if (!byTarget) {
    byTarget = new WeakMap();
    trampolineCache.set(ctx, byTarget);
  }
  const cached = byTarget.get(targetFunc);
  // Speculative compilation can roll module state back while the CodegenContext
  // remains alive. Accept a cache hit only while it still owns the exact
  // published function object at that stable handle.
  if (cached && definedFuncAt(ctx, cached.funcIdx) === cached.func) return cached.funcIdx;

  if (definedFuncAt(ctx, targetFuncIdx) !== targetFunc) {
    throw new Error(`named-this trampoline target changed before reserving ${targetName}`);
  }
  const targetOrdinal = ctx.mod.functions.indexOf(targetFunc);
  const helperName = `__named_this_call_${safeName(targetName)}_${targetOrdinal}`;
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  const trampolineParams: ValType[] = [{ kind: "externref" }, ...params];
  const typeIdx = addFuncType(ctx, trampolineParams, [...results], `$${helperName}_type`);
  const trampolineFuncIdx = mintDefinedFunc(ctx);
  const prevThisLocal = trampolineParams.length;
  const resultType = results[0];
  const resultLocal = resultType === undefined ? -1 : prevThisLocal + 1;
  const standardizedEh = ctx.wasi || ctx.standalone;
  const unwindExnLocal = resultType === undefined ? prevThisLocal + 1 : resultLocal + 1;
  const exactCall = (): Instr[] => callTarget(targetFuncIdx, params.length);

  // Save the ambient receiver, install `receiver`, run the exact call, restore
  // on both the normal and the unwinding exit.
  const installAndCall = (receiver: readonly Instr[]): Instr[] => {
    const blockType =
      resultType === undefined ? ({ kind: "empty" } as const) : ({ kind: "val", type: resultType } as const);
    const protectedCall: Instr = standardizedEh
      ? buildStandardTryTable(blockType, exactCall(), [
          {
            kind: "catch",
            tagIdx: ensureExnTag(ctx),
            payloadType: { kind: "externref" },
            body: [
              { op: "local.set", index: unwindExnLocal },
              { op: "local.get", index: prevThisLocal },
              { op: "global.set", index: currentThisGlobalIdx },
              { op: "local.get", index: unwindExnLocal },
              { op: "throw", tagIdx: ensureExnTag(ctx) },
            ],
          },
        ])
      : {
          op: "try",
          blockType,
          body: exactCall(),
          catches: [],
          catchAll: [
            { op: "local.get", index: prevThisLocal },
            { op: "global.set", index: currentThisGlobalIdx },
            { op: "rethrow", depth: 0 },
          ],
        };
    return [
      { op: "global.get", index: currentThisGlobalIdx },
      { op: "local.set", index: prevThisLocal },
      ...receiver,
      { op: "global.set", index: currentThisGlobalIdx },
      protectedCall,
      ...(resultLocal < 0 ? [] : ([{ op: "local.set", index: resultLocal }] satisfies Instr[])),
      { op: "local.get", index: prevThisLocal },
      { op: "global.set", index: currentThisGlobalIdx },
      ...(resultLocal < 0 ? [] : ([{ op: "local.get", index: resultLocal }] satisfies Instr[])),
    ];
  };

  const liveCall: Instr[] = installAndCall([{ op: "local.get", index: 0 }]);

  // (#4203) Param 0 is null at runtime. The trampoline is only ever reached
  // from a `.call`/`.apply`/`.bind` site that PASSED an argument, so this is
  // not "no receiver" — it is "the receiver is `null`", and §10.4.3 makes a
  // strict callee observe exactly that. Install the marker so the callee's
  // `this` reader can tell the two apart. A sloppy target keeps the plain
  // unbound call: its answer (the global object) is already correct and the
  // emitted bytes stay identical.
  const markerReceiver = markerNullArm ? explicitNullThisExternInstrs(ctx) : undefined;
  const nullArm: Instr[] = markerReceiver ? installAndCall(markerReceiver) : callTarget(targetFuncIdx, params.length);

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: resultType === undefined ? { kind: "empty" } : { kind: "val", type: resultType },
      then: nullArm,
      else: liveCall,
    },
  ];
  const trampolineFunc: WasmFunction = {
    name: helperName,
    typeIdx,
    locals: [
      { name: "__previous_this", type: { kind: "externref" } },
      ...(resultType === undefined ? [] : [{ name: "__result", type: resultType }]),
      ...(standardizedEh ? [{ name: "__unwind_exception", type: { kind: "externref" } as const }] : []),
    ],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, trampolineFuncIdx, trampolineFunc);
  byTarget.set(targetFunc, { funcIdx: trampolineFuncIdx, func: trampolineFunc });
  return trampolineFuncIdx;
}

/**
 * Resolve and reserve the narrow named `.call` target, or return undefined so
 * the existing generic lowering remains authoritative.
 */
export function resolveNamedThisCallTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Identifier,
  targetFuncIdx: FuncHandle,
  receiver: ts.Expression,
  userArguments: readonly ts.Expression[],
): NamedThisCallTarget | undefined {
  const declaration = resolveDeclaration(ctx, callee);
  // (#4203) Strictness of the TARGET, not of the call site: §10.4.3 keys the
  // receiver's treatment on the callee's own code. Only a strict target can
  // observe explicit-null differently from absent, so only a strict target
  // needs (or gets) the marker.
  const markerNullArm =
    declaration?.body !== undefined &&
    explicitNullReceiverLane(ctx) &&
    isStrictContext(declaration.body, ctx.inferModuleStrictArguments);
  if (
    !declaration?.body ||
    ctx.liveFuncBindingGlobals?.has(callee.text) === true ||
    !declarationOwnsHandle(ctx, declaration, targetFuncIdx) ||
    declaration.parameters.some((parameter) => parameter.dotDotDotToken !== undefined) ||
    userArguments.length !== declaration.parameters.length ||
    userArguments.some((argument) => ts.isSpreadElement(argument)) ||
    (declaration.parameters[0] &&
      ts.isIdentifier(declaration.parameters[0].name) &&
      declaration.parameters[0].name.text === "this") ||
    !bodyReferencesOwnThis(declaration.body) ||
    !receiverIsAdmitted(ctx, fctx, receiver, markerNullArm)
  ) {
    return undefined;
  }

  const targetFunc = definedFuncAt(ctx, targetFuncIdx);
  if (!targetFunc || targetFunc.name !== callee.text) return undefined;
  const signature = ctx.mod.types[targetFunc.typeIdx];
  if (
    signature?.kind !== "func" ||
    signature.params.length !== declaration.parameters.length ||
    signature.results.length > 1
  ) {
    return undefined;
  }
  const trampolineFuncIdx = ensureNamedThisCallTrampoline(
    ctx,
    callee.text,
    targetFuncIdx,
    targetFunc,
    signature.params,
    signature.results,
    markerNullArm,
  );
  return { trampolineFuncIdx };
}

/**
 * (#3983) `.apply(thisArg[, argsArray])` counterpart to the `.call` path above.
 *
 * `.apply` used to fall through to a lowering that evaluated `thisArg` and
 * DROPPED it, so the callee's `this` was the ambient receiver rather than the
 * requested one — a silent wrong answer, not a refusal.
 *
 * `.apply(t, [a, b])` is exactly `.call(t, a, b)` whenever the argv array is
 * statically known, so rather than duplicating the receiver-install lowering
 * this returns the equivalent `.call` CallExpression for the caller to compile.
 * Returns undefined — leaving every existing lowering authoritative — unless
 * the trampoline actually resolves, so only shapes that are wrong today change.
 *
 * The argv check here is deliberately narrower than the caller's general
 * `flattenStaticArrayElements`: only a spread-free, hole-free array literal
 * qualifies. Anything else (dynamic argv, spreads, elisions) keeps its existing
 * behaviour.
 */
export function tryReshapeApplyToNamedThisCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  callee: ts.Identifier,
  targetFuncIdx: FuncHandle,
): ts.CallExpression | undefined {
  if (expr.arguments.length === 0) return undefined;
  let argv: readonly ts.Expression[] | undefined;
  if (expr.arguments.length === 1) {
    argv = [];
  } else if (expr.arguments.length === 2) {
    const spread = expr.arguments[1]!;
    if (
      ts.isArrayLiteralExpression(spread) &&
      !spread.elements.some((el) => ts.isSpreadElement(el) || ts.isOmittedExpression(el))
    ) {
      argv = spread.elements;
    }
  }
  if (argv === undefined) return undefined;
  if (resolveNamedThisCallTarget(ctx, fctx, callee, targetFuncIdx, expr.arguments[0]!, argv) === undefined) {
    return undefined;
  }
  const reshaped = ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(callee, "call"),
    undefined,
    [expr.arguments[0]!, ...argv],
  );
  ts.setTextRange(reshaped, expr);
  (reshaped as { parent?: ts.Node }).parent = expr.parent;
  return reshaped;
}

/**
 * (#4203) `f.bind(thisArg, ...partial)(...rest)` counterpart to the two above.
 *
 * The immediate bind-and-call form in `call-tail-dispatch.ts` reshapes to a
 * direct `call $f` and evaluates `thisArg` only for its side effects — the same
 * evaluate-and-DROP wrong answer #4025 removed for `.call` and #3983 for
 * `.apply`, still standing for the third surface. It is `10.4.3-1-{77,79,80,98}`
 * and their `gs` twins.
 *
 * For an immediately-invoked bind, `f.bind(t, p)(a)` IS `f.call(t, p, a)`: the
 * bound function object is never observed, so its `.length`/`.name`/
 * [[Construct]] cannot be either. Reshaping is therefore exact, not an
 * approximation — and it inherits the trampoline's admission gate wholesale,
 * so any shape the gate refuses keeps its current lowering.
 *
 * `f.bind()()` (no thisArg at all) is deliberately NOT reshaped: that is an
 * ABSENT receiver, which the legacy path already answers correctly.
 */
export function tryReshapeBindToNamedThisCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  outer: ts.CallExpression,
  bindCall: ts.CallExpression,
  callee: ts.Identifier,
  targetFuncIdx: FuncHandle,
): ts.CallExpression | undefined {
  if (bindCall.arguments.length === 0) return undefined;
  const receiver = bindCall.arguments[0]!;
  const args = [...bindCall.arguments.slice(1), ...outer.arguments];
  if (resolveNamedThisCallTarget(ctx, fctx, callee, targetFuncIdx, receiver, args) === undefined) {
    return undefined;
  }
  const reshaped = ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(callee, "call"),
    undefined,
    [receiver, ...args],
  );
  ts.setTextRange(reshaped, outer);
  (reshaped as { parent?: ts.Node }).parent = outer.parent;
  return reshaped;
}
