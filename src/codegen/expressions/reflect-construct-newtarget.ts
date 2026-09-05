// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3371 r4 — runtime `GetPrototypeFromConstructor(NewTarget, …)` for
 * `Reflect.construct(target, args, NewTarget)` in `--target standalone`.
 *
 * ## What changed
 * The namespace-static `Reflect.construct` arm used to select the instance
 * prototype by SCANNING THE SOURCE for a prior `NewTarget.prototype = …`
 * assignment (`assignedNewTargetPrototype`). When that scan found nothing it
 * emitted a hard compile error — the "#3371 refusal" that made 23 ES2015 rows
 * `compile_error`. A source scan can never model the real operation, which is
 * `? Get(NewTarget, "prototype")` (ES §10.1.14 step 2): an ordinary property
 * read that can run a getter, throw, or mutate the world.
 *
 * This module supplies that real read. It is used ONLY on the branch that used
 * to `reportError`, so no program that compiled before reaches any of it — the
 * static-assignment path and the non-distinct path are untouched.
 *
 * ## Ordering
 * NewTarget is evaluated exactly once, BEFORE the argument list, into an
 * externref local; `Get(NT, "prototype")` runs AFTER the ordinary construction
 * completes. That order is what the ES2015 rows in this cluster pin:
 *
 *   - `DataView/byteOffset-validated-against-initial-buffer-length.js` — the
 *     RangeError from offset validation must win over the prototype getter, so
 *     the getter must NOT run before construction.
 *   - `TypedArrayConstructors/…/throw-type-error-before-custom-proto-access.js`
 *     — same shape: `ToIndex(Symbol())` must throw first.
 *   - the six `custom-proto-access-throws.js` rows — the getter throws, and the
 *     throw propagates out of `Reflect.construct` whichever side of the
 *     allocation it runs on.
 *
 * The rows that require the read to happen strictly BEFORE allocation
 * (`ArrayBuffer/data-allocation-after-object-creation.js`) are NOT served by
 * this shape and stay refused; see the issue file's residual list.
 *
 * ## Applying the result
 * `applyRuntimeNewTargetPrototype` writes the fetched prototype onto whichever
 * carrier the construction produced: the DataView window struct, the dynamic
 * typed-array view struct, or — for anything else — the ordinary
 * `__object_setPrototypeOf` path. Before this the "no carrier arm matched" case
 * was itself a compile error.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { MAX_NATIVE_CONSTRUCT_ARITY, reserveNativeConstructDriver } from "../native-construct.js";
import { coerceType, compileExpression } from "../shared.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Register the helpers the runtime NewTarget path calls, before any argument
 * or constructor code is emitted. Late-import registration shifts defined
 * function indices, so it has to happen while the surrounding body is still
 * empty of baked call indices for this site.
 */
export function prepareRuntimeNewTargetProto(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  // The generic [[SetPrototypeOf]] is built at finalize, so it is absent from
  // `funcMap` while this expression compiles unless it is registered here —
  // and a silently-missing writer is exactly how the first cut of this arm
  // left `Object.getPrototypeOf(result)` at null while every row still
  // "compiled".
  ensureLateImport(ctx, "__object_setPrototypeOf", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
}

/**
 * Push `? Get(newTarget, "prototype")` as an externref. `ntLocal` holds the
 * once-evaluated NewTarget value.
 */
export function emitRuntimeNewTargetPrototype(ctx: CodegenContext, fctx: FunctionContext, ntLocal: number): boolean {
  const getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) return false;
  fctx.body.push({ op: "local.get", index: ntLocal });
  const key = stringConstantExternrefInstrs(ctx, "prototype");
  for (let i = 0; i < key.length; i++) fctx.body.push(key[i]!);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return true;
}

/**
 * Write `proto` onto the constructed value.
 *
 * `carrierArms` are the nominal struct writes the caller already knows how to
 * do (DataView window, dynamic typed-array view); each is paired with the
 * `ref.test` type index that selects it. Anything else — an ordinary `$Object`,
 * a class instance, a wrapper — goes through `__object_setPrototypeOf`, which
 * is the same [[SetPrototypeOf]] the object model uses everywhere else.
 */
export function applyRuntimeNewTargetPrototype(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resultAny: number,
  resultExtern: number,
  protoLocal: number,
  carriers: readonly { typeIdx: number; fieldIdx: number }[],
): void {
  const handled = allocLocal(fctx, `__reflect_construct_nt_done_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: handled });
  for (let i = 0; i < carriers.length; i++) {
    const carrier = carriers[i]!;
    const then: Instr[] = [
      { op: "local.get", index: resultAny },
      { op: "ref.cast", typeIdx: carrier.typeIdx },
      { op: "local.get", index: protoLocal },
      { op: "struct.set", typeIdx: carrier.typeIdx, fieldIdx: carrier.fieldIdx },
      { op: "i32.const", value: 1 },
      { op: "local.set", index: handled },
    ];
    fctx.body.push({ op: "local.get", index: resultAny });
    fctx.body.push({ op: "ref.test", typeIdx: carrier.typeIdx });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then });
  }
  const setProtoIdx = ctx.funcMap.get("__object_setPrototypeOf");
  if (setProtoIdx === undefined) return;
  const generic: Instr[] = [
    { op: "local.get", index: resultExtern },
    { op: "local.get", index: protoLocal },
    { op: "call", funcIdx: setProtoIdx },
    { op: "drop" },
  ];
  fctx.body.push({ op: "local.get", index: handled });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: generic });
}

/**
 * Is `value` an ORDINARY user function (not a class, not a native builtin, not
 * a generator/async) whose binding is never reassigned in this source file?
 *
 * The reassignment scan is the load-bearing half. Resolving the identifier to
 * its `valueDeclaration` alone answers by DECLARATION SHAPE, which a later
 * `fn = somethingElse`, a parameter shadow, or a `with`/`eval` write can
 * falsify at runtime — the exact "resolved by name, not by single-assignment
 * proof" family every review of this cluster has caught. Decline unless the
 * proof holds.
 */
export function isUnreassignedOrdinaryFunction(ctx: CodegenContext, value: ts.Expression): boolean {
  if (ts.isFunctionExpression(value)) return isPlainFunctionLike(value);
  if (!ts.isIdentifier(value)) return false;
  const declarations = ctx.oracle.declarationsOf(value);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  if (!ts.isFunctionDeclaration(declaration) || !isPlainFunctionLike(declaration)) return false;
  return !isRebound(value.getSourceFile(), value.text);
}

function isPlainFunctionLike(node: ts.FunctionDeclaration | ts.FunctionExpression): boolean {
  return (
    node.asteriskToken === undefined &&
    !(node.modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false)
  );
}

/**
 * Any construct that could make `name` denote something other than the single
 * function declaration: an assignment, a `++`/`--`, a second binding (var /
 * let / const / parameter / catch / import / class), a destructuring target, or
 * a `with`/direct-`eval` that can write an unseen binding.
 */
function mentions(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  let found = false;
  forEachChild(node, (child) => {
    if (!found && mentions(child, name)) found = true;
  });
  return found;
}

function isRebound(source: ts.SourceFile, name: string): boolean {
  let rebound = false;
  const visit = (node: ts.Node): void => {
    if (rebound) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      // A destructuring target (`[fn] = …`, `({ fn } = …)`) is an assignment
      // whose left is not a bare identifier, so match the whole left subtree.
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment && mentions(node.left, name)) {
        rebound = true;
      }
    } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && mentions(node.initializer, name)) {
      rebound = true;
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      rebound = true;
    } else if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isClassDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      rebound = true;
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      const bound = node.variableDeclaration.name;
      if (ts.isIdentifier(bound) && bound.text === name) rebound = true;
    } else if (ts.isWithStatement(node)) {
      rebound = true;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      rebound = true;
    }
    if (!rebound) forEachChild(node, visit);
  };
  visit(source);
  return rebound;
}

/**
 * `Construct(target, args, NewTarget)` for an ordinary function target, with
 * the instance prototype taken from `? Get(NewTarget, "prototype")`.
 *
 * This is the only shape that can honour an arbitrary NewTarget for a user
 * function: the ordinary `new fn()` lowering builds a CLOSED struct with no
 * `$proto` field, so no later write can give the instance a different
 * prototype — which is why `Object.getPrototypeOf(result)` read back as null
 * when the post-construction [[SetPrototypeOf]] was tried on it. The driver
 * instead does `__object_create(proto)` first and runs the body against that
 * open `$Object`, so the constructor's own `Object.getPrototypeOf(this)` sees
 * the NewTarget prototype too.
 *
 * Returns false (emitting nothing) when the site does not qualify; the caller
 * then falls back to the ordinary construct-then-patch shape.
 */
export function tryEmitOrdinaryConstructWithNewTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  args: readonly ts.Expression[],
  ntLocal: number,
): boolean {
  if (!ctx.standalone) return false;
  if (args.length > MAX_NATIVE_CONSTRUCT_ARITY) return false;
  if (args.some((a) => ts.isSpreadElement(a))) return false;
  if (!isUnreassignedOrdinaryFunction(ctx, target)) return false;
  // Decline BEFORE emitting anything: a bail-out after the callee/argument
  // evaluation is already in the body would leave the fallback path to
  // evaluate them a second time.
  if (ctx.funcMap.get("__extern_get") === undefined) return false;
  ensureObjectRuntime(ctx);
  const driverIdx = reserveNativeConstructDriver(ctx, args.length, stringConstantExternrefInstrs(ctx, "prototype"));

  // Source order: callee, then every argument, then `Get(NT, "prototype")` —
  // the prototype read is the first step of [[Construct]], so it runs after the
  // whole argument list and before the body.
  const calleeTy = compileExpression(ctx, fctx, target, EXTERNREF);
  if (calleeTy && calleeTy.kind !== "externref") coerceType(ctx, fctx, calleeTy, EXTERNREF);
  else if (calleeTy === null) fctx.body.push({ op: "ref.null.extern" });
  const calleeLocal = allocLocal(fctx, `__rc_callee_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const argLocals: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const argTy = compileExpression(ctx, fctx, args[i]!, EXTERNREF);
    if (argTy && argTy.kind !== "externref") coerceType(ctx, fctx, argTy, EXTERNREF);
    else if (argTy === null) fctx.body.push({ op: "ref.null.extern" });
    const argLocal = allocLocal(fctx, `__rc_arg${i}_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }

  if (!emitRuntimeNewTargetPrototype(ctx, fctx, ntLocal)) return false;
  const protoLocal = allocLocal(fctx, `__rc_proto_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: protoLocal });

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: protoLocal });
  for (let i = 0; i < argLocals.length; i++) fctx.body.push({ op: "local.get", index: argLocals[i]! });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(`__native_construct_${args.length}`) ?? driverIdx });
  return true;
}
