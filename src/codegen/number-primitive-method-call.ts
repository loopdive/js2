// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5383 S23 / #6610) `__extern_method_call`'s missing NUMBER-PRIMITIVE receiver
 * arm — `x.toPrecision(p)` where `x`'s static type is `any`.
 *
 * ## What was broken
 *
 * `__extern_method_call` dispatches `ref.test $Object` → resolve-and-apply, ELSE
 * the vec / closure-prop arms, ELSE `buildProtoNamedMethodMissArm`'s terminal
 * miss. A bare number primitive (`$box_number` / i31) is none of those three, so
 * it reached the terminal, whose consult is the #4160/#4176 proto-index store —
 * the table of members a MODULE installed on a builtin prototype. The BUILTIN
 * members of `Number.prototype` are not in it, the consult answered null, and
 * the #4221 absent-callee guard turned that into
 * `TypeError: called value is not a function`.
 *
 * Measured on this branch's base, one standalone module, no polyfill, no link
 * (`.tmp/s23/c1.mjs`):
 *
 * | probe                                      | base                                 |
 * | ------------------------------------------ | ------------------------------------ |
 * | `(1234.5678).toPrecision(3)` static recv   | `"1.23e+3"`                          |
 * | `f(x){return x.toPrecision(3)}` `any` recv | **`called value is not a function`** |
 * | same for `toFixed` / `toExponential`       | **`called value is not a function`** |
 * | `x.toString()` 0-arg through `any`         | `"255"` (a different arm serves it)  |
 * | `x.valueOf()` / `x.toLocaleString()`       | already correct                      |
 *
 * So the ANSWER machinery was never missing — only the routing for one receiver
 * brand. The two halves that do work prove it end to end on the same base:
 * `Number.prototype["toPrecision"]` read through an `any` binding resolves to a
 * function, and `.call(1234.5678, 3)` on that value answers `"1.23e+3"` with a
 * PRIMITIVE `this`. This arm performs that same resolution at the call.
 *
 * ## Shape
 *
 * `block` + `br_if 0` ladder unshifted onto `__extern_method_call`, exactly the
 * `native-proto-method-call.ts` / `ta-dyn-method-call.ts` shape — the arm must
 * fall THROUGH to the untouched body on every decline, and `br_if 0` is the one
 * exit that leaves the stack empty on the way out.
 *
 *   1. `__typeof_number(recv)` — the receiver must be a number PRIMITIVE.
 *      Deliberately not a `typeof`-style widening: the predicate is
 *      `ref.test $box_number ∨ ref.test i31`, so a Number WRAPPER (`$Object`)
 *      never enters this arm and keeps the `$Object` route it already takes.
 *      (The wrapper spelling `new Number(x).toPrecision(3)` nevertheless goes
 *      from `called value is not a function` to `"1.23e+3"` — not from this
 *      arm, but from the #4619 mint below reaching `__extern_get`'s ladder,
 *      which that route already consults. Measured in `.tmp/s23/c5.mjs`.)
 *   2. `__extern_get(%Number.prototype%, name)` — the identity-stable
 *      `$NativeProto` singleton (`buildLazyNativeProtoGetInstrs`), whose members
 *      the #2175 companion seeder installs. Resolution is by NAME, so the arm
 *      has no per-member table and cannot drift from the prototype's own member
 *      set.
 *   3. Non-null ⇒ `__apply_closure(m, recv, args)` with the ORIGINAL primitive
 *      as `this`, which is what §21.1.3.x's `thisNumberValue` reads.
 *
 * ## Absent-not-wrong
 *
 * The arm claims the call ONLY when the member RESOLVES. `(5).nosuch()` still
 * reaches the terminal §13.3.6.2 step-5 TypeError, and every receiver brand but
 * a number primitive branches out at step 1, so nothing that answers correctly
 * today can be displaced.
 *
 * ## Why the demand gate, and why the scan is early while the arm is late
 *
 * Materializing `%Number.prototype%` pulls in its glue, its companion seeder and
 * the native member bodies. A module that never calls a Number format method
 * through a dynamic receiver must not pay for that, so the arm is gated on a
 * cheap, cached AST scan for a member CALL by one of the format names
 * ({@link NUMBER_PRIMITIVE_CALL_MEMBERS}) — the shapes that are broken today.
 * A module with no such call compiles byte-identically.
 *
 * The scan runs early (pure AST, one flag); the singleton is materialized in
 * {@link prepareNumberPrimitiveMethodCallArm} at finalize, BEFORE
 * `unshiftExternGetProtoMethodArm`; the arm itself is unshifted after it. That
 * ordering is load-bearing in both directions, and each half was measured:
 *
 * - Built during the source scan, `buildLazyNativeProtoGetInstrs` finds no
 *   `__protoidx_companion` in `funcMap` yet and skips the companion mint, so the
 *   singleton's dynamic member reads all miss.
 * - Built AFTER `unshiftExternGetProtoMethodArm`, the brand is not in that
 *   pass's minted/seeded set, so `__extern_get` has no ladder entry for it. The
 *   first cut of this slice did exactly that: the arm was emitted, the receiver
 *   test passed (verified with a probe throw), and the resolution answered null
 *   on every call — a fix that measures as a complete no-op.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNumberNativeProtoGlue } from "./array-object-proto.js";
import { buildLazyNativeProtoGetInstrs } from "./native-proto.js";
import { protoIndexRecvGetMissInstrs } from "./proto-index-store.js";
import { ensureWrapperProtoDynamicMember } from "./wrapper-proto-dynamic-demand.js";

/**
 * Member names whose DYNAMIC-receiver call this arm exists to repair.
 *
 * **`toPrecision` only, and the narrowness is measured, not cautious.** All
 * three §21.1.3 numeric-format methods report `called value is not a function`
 * through an `any` receiver on the base, but only `toPrecision` has a
 * REFLECTIVE native body (`number-proto-format.ts`, #5269 J-1). Widening the
 * list to `toFixed` / `toExponential` was tried and measured: they resolve to
 * `ensureStandaloneNativeMethodClosure`'s `refusalBodyFallback` stand-in and the
 * call answers `"Number.prototype.toFixed is not yet implemented in
 * --target standalone"`. That is a different TypeError, not a working call, and
 * no row in this slice's sample needs it — so the two are left exactly as they
 * are on the base and recorded as a named residual (their reflective bodies are
 * the next slice, not this one).
 *
 * `toString` is absent for the opposite reason: the 0-argument spelling already
 * answers correctly through another arm on the base. Its radix spelling
 * (`x.toString(16)` through an `any` receiver) is a separate residual.
 */
export const NUMBER_PRIMITIVE_CALL_MEMBERS: readonly string[] = ["toPrecision"];

const demandScanCache = new WeakMap<ts.SourceFile, boolean>();

function sourceNamesNumberFormatCall(sourceFile: ts.SourceFile): boolean {
  const cached = demandScanCache.get(sourceFile);
  if (cached !== undefined) return cached;
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && NUMBER_PRIMITIVE_CALL_MEMBERS.includes(callee.name.text)) {
        found = true;
        return;
      }
      if (
        ts.isElementAccessExpression(callee) &&
        callee.argumentExpression !== undefined &&
        ts.isStringLiteralLike(callee.argumentExpression) &&
        NUMBER_PRIMITIVE_CALL_MEMBERS.includes(callee.argumentExpression.text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  demandScanCache.set(sourceFile, found);
  return found;
}

/**
 * Record that this source file CALLS a `Number.prototype` format method by name.
 * Pure AST, cached per `SourceFile`, and additive across a multi-module realm.
 */
export function noteNumberPrimitiveMethodDemand(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (!ctx.standalone) return;
  if (sourceNamesNumberFormatCall(sourceFile)) ctx.numberPrimitiveMethodCallDemand = true;
}

/**
 * Materialize `%Number.prototype%` and stash its identity-stable singleton read.
 *
 * MUST run before `unshiftExternGetProtoMethodArm` — see the ordering note in
 * the module header.
 */
export function prepareNumberPrimitiveMethodCallArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (ctx.numberPrimitiveMethodCallDemand !== true) return;
  if (ctx.numberPrimitiveMethodProtoInstrs !== undefined) return;
  if (!ctx.funcMap.has("__extern_get") || !ctx.funcMap.has("__apply_closure")) return;
  if (!ctx.funcMap.has("__typeof_number")) return;
  if (!ctx.mod.functions.some((candidate) => candidate.name === "__extern_method_call")) return;
  const brand = ensureNumberNativeProtoGlue(ctx);
  if (brand === undefined) return;
  // Mint each format member's closure. `__extern_get`'s `$NativeProto` ladder
  // (#4248) is assembled from the brand's MINTED members, and a module that
  // only CALLS `x.toPrecision(p)` through an `any` receiver never names
  // `Number.prototype.toPrecision`, so nothing else mints them. This is the
  // #4619 `ensureWrapperProtoDynamicMember` demand hook, taken here rather than
  // at a lowering site because the receiver is not statically a wrapper.
  for (const member of NUMBER_PRIMITIVE_CALL_MEMBERS) {
    ensureWrapperProtoDynamicMember(ctx, "Number", member);
  }
  const protoInstrs = buildLazyNativeProtoGetInstrs(ctx, brand);
  if (protoInstrs) ctx.numberPrimitiveMethodProtoInstrs = protoInstrs;
}

/**
 * Prepend the number-primitive receiver arm onto `__extern_method_call`.
 *
 * No-op outside standalone, without the prepared singleton above, and whenever
 * any delegate is missing — in each case nothing can reach the arm, so emitting
 * it would only add dead bytes.
 *
 * ABI of the host function: param 0 = receiver externref, 1 = key externref,
 * 2 = args `$ObjVec` (as externref).
 */
export function unshiftExternMethodCallNumberPrimitiveArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const protoInstrs = ctx.numberPrimitiveMethodProtoInstrs;
  if (protoInstrs === undefined) return;
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  if (typeofNumberIdx === undefined || externGetIdx === undefined || applyClosureIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_method_call");
  if (!fn) return;

  const methodLocal = 3 + fn.locals.length;
  const newLocals: { name: string; type: ValType }[] = [{ name: "npmcall", type: { kind: "externref" } }];
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");

  // §10.5 OrdinaryGet — a member the MODULE put on `Number.prototype` (or on
  // `Object.prototype`) must outrank the builtin. That write lives in the
  // #4160/#4176 proto-index store, which is what the terminal miss arm this one
  // runs ahead of consults. Measured: without this the base answer for
  // `Number.prototype.toPrecision = f; x.toPrecision(2)` through an `any`
  // receiver went from `f`'s answer to the BUILTIN's — a wrong answer where the
  // base was right, which is the one failure mode a prepended arm can cause.
  // Declining (rather than answering the store here) keeps that whole shape on
  // the exact path it takes today.
  const storeConsult = protoIndexRecvGetMissInstrs(ctx, 0, 1);
  const declineOnUserOverride: Instr[] =
    storeConsult === undefined
      ? []
      : [
          ...storeConsult,
          ...(nullishToNullIdx === undefined ? [] : ([{ op: "call", funcIdx: nullishToNullIdx }] satisfies Instr[])),
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          { op: "br_if", depth: 0 },
        ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: typeofNumberIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    ...declineOnUserOverride,
    ...protoInstrs,
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: externGetIdx },
    // (#2106 S1) the undefined singleton normalises to null, so the
    // "did it resolve?" test below is a single `ref.is_null`.
    ...(nullishToNullIdx === undefined ? [] : ([{ op: "call", funcIdx: nullishToNullIdx }] satisfies Instr[])),
    { op: "local.tee", index: methodLocal },
    { op: "ref.is_null" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: methodLocal },
    { op: "local.get", index: 0 }, // `this` = the number PRIMITIVE, per §21.1.3.x
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "return" },
  ];

  fn.locals.push(...newLocals);
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}
