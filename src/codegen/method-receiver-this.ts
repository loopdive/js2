// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A11) The receiver of a method called WITHOUT its object — two halves
 * of one model: `var f = obj.m; f()` / `var g = C.prototype.g; g()`.
 *
 * ── Object-literal methods: `this` read as a JS value ────────────────────
 *
 * The struct-lane object-literal method (`literals.ts`) receives its receiver
 * as the literal's own closed struct, `(ref null $obj)`. Called through the
 * literal (`obj.m()`) that struct IS the receiver. Called any other way — the
 * method extracted and called bare (`var f = obj.m; f()`), or invoked with a
 * foreign receiver (`f.call(other)`) — the method-as-closure trampoline cannot
 * cast the receiver to `$obj` and passes `ref.null` (#2015/#2025, the designed
 * passthrough). A bare `this` then read as JS `null`.
 *
 * Per §10.2.1.2 OrdinaryCallBindThis the receiver is the caller's thisArg,
 * with sloppy code substituting the global object for `undefined`/`null`. So
 * where the consumer wants the receiver as a JS value (`externref`), a null
 * struct means "the receiver was not this object": answer from the thisArg
 * the dispatcher installed in `__current_this` — the exact rung
 * `this-keyword.ts` uses for a lifted closure body — and, when none was
 * installed (a bare call), from the method's own strictness.
 *
 * A native generator's RESUME function runs long after the call that bound
 * `this` returned, so `__current_this` means nothing there; it answers from
 * the strictness alone (the unbound call, which is what extracting a generator
 * method and calling it does).
 *
 * Deliberately narrow: only a `this` whose OWN function is an object-literal
 * method (an arrow in between inherits a lexical receiver the dispatcher never
 * saw), only a struct-typed receiver local, and only where the consumer asked
 * for `externref`. A struct-typed consumer (`this.x`, `return this` typed as
 * the literal) keeps the struct and its exact bytes.
 *
 * ── Class generator methods: the factory's receiver store is not a read ──
 *
 * The method-as-closure trampoline throws a TypeError for an absent receiver
 * when the method READS `this` (#2025), which it decides by finding
 * `local.get 0` in the compiled body. A native generator method's compiled
 * body is its FACTORY, which always stores param 0 into the frame's
 * `param_this` — so every class generator method threw when extracted, before
 * its body ran, whether or not the body ever looked at `this`. Class code is
 * strict, so the spec receiver is `undefined` and only a body that uses it can
 * fail. {@link classGeneratorMethodReadsReceiver} answers from that body.
 *
 * The same factory returns its private `$GenState` struct, and the cached
 * method closure (`C.prototype.g` as a value) copied that result into its
 * wrapper type. No dynamic call arm matches `-> (ref $GenState)`, so the call
 * threw "not a function". {@link methodValueWrapperResults} bridges it to the
 * JS-visible externref, exactly as `ensureFuncClosureSingleton` already does
 * for a generator DECLARATION used as a value.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { bodyReferencesOwnThis } from "./helpers/body-references-own-this.js";
import { hasAsyncModifier } from "./ast-modifiers.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildCurrentThisNonNullArm } from "./explicit-null-receiver.js";
import {
  nativeGeneratorFunctionValueNeedsResultBridge,
  nativeGeneratorFunctionValueWrapperResults,
} from "./generators-factory-prototype.js";
import { methodBodyUsesSuper } from "./generators-native-ast-scan.js";
import { emitUnboundThis } from "./helpers/sloppy-this-global.js";

/**
 * For the factory of a native class generator METHOD (`funcName` keys
 * `ctx.nativeGenerators`, synthesized receiver param): does the generator body
 * use its receiver (`this`, `super`, or a direct eval)? `undefined` for every
 * other function — the caller keeps its compiled-body scan.
 */
export function classGeneratorMethodReadsReceiver(ctx: CodegenContext, funcName: string): boolean | undefined {
  const info = ctx.nativeGenerators.get(funcName);
  if (!info?.synthesizedThis || !ts.isClassLike(info.decl.parent) || !info.decl.body) return undefined;
  return bodyReferencesOwnThis(info.decl.body) || methodBodyUsesSuper(info.decl.body);
}

/**
 * (#6789) An object-literal generator or async method: its compiled body only
 * stores the receiver into the frame its resume reads it from (a bare `this`
 * answered from the strictness alone, as above), so the method-as-closure
 * trampoline must pass an absent receiver through rather than throw at the
 * call — the frame store is not a dereference.
 */
export function objectLiteralMethodDefersReceiver(memberDecl: ts.Node | undefined): boolean {
  if (!memberDecl || !ts.isMethodDeclaration(memberDecl) || !ts.isObjectLiteralExpression(memberDecl.parent)) {
    return false;
  }
  return memberDecl.asteriskToken !== undefined || hasAsyncModifier(memberDecl);
}

/**
 * (#6789) Does a compiled method body read its receiver (param 0)? With
 * `guardedReadsAreSafe`, a `local.get 0` that `ref.is_null` tests is not a read,
 * nor is anything in the `else` arm of the `if` that test feeds — that arm only
 * runs with a receiver present, so a null one cannot trap there. The value read
 * {@link tryEmitObjectLiteralMethodReceiverValue} emits is that shape, so the
 * method-as-closure trampoline hands it the null receiver instead of throwing.
 * A receiver read straight into `return` is not a deref either.
 */
export function bodyReadsReceiver(instrs: readonly Instr[], guardedReadsAreSafe: boolean): boolean {
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i]!;
    if (instr.op === "local.get" && (instr as { index?: number }).index === 0) {
      if (guardedReadsAreSafe && instrs[i + 1]?.op === "return") continue; // `return this`: no deref
      if (!guardedReadsAreSafe || instrs[i + 1]?.op !== "ref.is_null") return true;
      const guard = instrs[i + 2] as { op: string; then?: Instr[] } | undefined;
      if (guard?.op !== "if") continue;
      if (Array.isArray(guard.then) && bodyReadsReceiver(guard.then, true)) return true;
      i += 2; // past the `if`: its `else` arm is the present-receiver arm
      continue;
    }
    for (const key of ["body", "then", "else", "catchAll"] as const) {
      const nested = (instr as Record<string, unknown>)[key];
      if (Array.isArray(nested) && bodyReadsReceiver(nested, guardedReadsAreSafe)) return true;
    }
    const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
    if (Array.isArray(catches)) {
      for (const c of catches) if (Array.isArray(c.body) && bodyReadsReceiver(c.body, guardedReadsAreSafe)) return true;
    }
  }
  return false;
}

/**
 * The wrapper results of a method's closure VALUE, and whether its trampoline
 * must `extern.convert_any` the direct call's result into them.
 */
export function methodValueWrapperResults(
  ctx: CodegenContext,
  directResults: readonly ValType[],
): { results: ValType[]; resultBridge: boolean } {
  return {
    results: nativeGeneratorFunctionValueWrapperResults(ctx, directResults),
    resultBridge: nativeGeneratorFunctionValueNeedsResultBridge(ctx, directResults),
  };
}

/**
 * The first non-arrow function that owns `thisNode` is a method of an object
 * literal — or, (#6774 S9) standalone only, an INSTANCE method / accessor of a
 * class. A class method's `this` is typed to the instance struct too, so a
 * call whose receiver is not a `$C` (`C.prototype.m()`, `super.m()` from such
 * a call — the caller published the receiver, super-receiver-publish.ts)
 * leaves it null where §10.2.1.2 binds the receiver.
 */
function thisOwnedByReceiverMethod(thisNode: ts.Node, standalone: boolean): boolean {
  let child: ts.Node = thisNode;
  for (let current = thisNode.parent; current; child = current, current = current.parent) {
    if (ts.isArrowFunction(current)) return false;
    if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isSourceFile(current)) {
      if (!ts.isMethodDeclaration(current) && !ts.isAccessor(current)) return false;
      // A computed key belongs to the scope AROUND the method.
      if (child === current.name) return false;
      if (ts.isMethodDeclaration(current) && ts.isObjectLiteralExpression(current.parent)) return true;
      return (
        standalone &&
        ts.isClassLike(current.parent) &&
        !current.modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.StaticKeyword)
      );
    }
  }
  return false;
}

/**
 * Emit the receiver of an object-literal method as `externref`, or return
 * `false` (nothing emitted) when the shape is not the one described above.
 */
export function tryEmitObjectLiteralMethodReceiverValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Node,
  selfIdx: number,
  selfType: ValType,
  expectedType: ValType | undefined,
): boolean {
  if (expectedType?.kind !== "externref") return false;
  if (selfType.kind !== "ref" && selfType.kind !== "ref_null") return false;
  if (!thisOwnedByReceiverMethod(expr, ctx.standalone)) return false;

  const saved = pushBody(fctx);
  if (fctx.localMap.has("__gen_self") || ctx.currentThisGlobalIdx < 0) {
    emitUnboundThis(ctx, fctx, expr);
  } else {
    const thisTmp = allocTempLocal(fctx, { kind: "externref" });
    const elseArm: Instr[] = buildCurrentThisNonNullArm(ctx, fctx, expr, thisTmp);
    const outer = pushBody(fctx);
    emitUnboundThis(ctx, fctx, expr);
    const unbound = fctx.body;
    popBody(fctx, outer);
    fctx.body.push(
      { op: "global.get", index: ctx.currentThisGlobalIdx },
      { op: "local.tee", index: thisTmp },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then: unbound, else: elseArm },
    );
    releaseTempLocal(fctx, thisTmp);
  }
  const nullArm = fctx.body;
  popBody(fctx, saved);
  fctx.body.push(
    { op: "local.get", index: selfIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: nullArm,
      else: [{ op: "local.get", index: selfIdx }, { op: "extern.convert_any" }],
    },
  );
  return true;
}
