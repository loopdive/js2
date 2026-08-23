// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4655) `Array.prototype.toLocaleString` — the ELEMENT step that makes it a
 * different method from `join`.
 *
 * ## The measured defect
 *
 * Since #2863 Phase 2 the standalone/wasi lane has dispatched `toLocaleString`
 * into the `join`/`toString` lowering, on the reasoning that the
 * locale-independent default separator is the same comma. That is right about
 * the SEPARATOR and wrong about the ELEMENT: §23.1.3.32 step 6.c.i is
 * `ToString(? Invoke(nextElement, "toLocaleString"))`, not `ToString(
 * nextElement)`. Measured on the campaign head (`3e8adf0d8`, `--target
 * standalone`), with a positive control that isolates the root to the method
 * NAME rather than to "element methods are never consulted":
 *
 * ```js
 * var n = 0, obj = { toLocaleString: function () { n++; return "L"; } };
 * [obj, obj].toLocaleString();   // n === 0  ✗   spec: 2, result "L,L"
 *
 * var m = 0, o2 = { toString: function () { m++; return "T"; } };
 * [o2, o2].toString();           // m === 2  ✓   — the ToString path IS reflective
 * ```
 *
 * So the element's own override is reachable; only the wrong method is being
 * asked for. That control is what separates this from the String-conversion
 * `toString`/`valueOf` root another lane is chasing — that one is not this.
 *
 * ## Why the tail, and not a second join
 *
 * Everything else about the two methods agrees: same iteration, same separator,
 * and §23.1.3.32 step 6.c renders `undefined`/`null` as the empty string
 * exactly as §23.1.3.18 step 4.b does — so the existing `joinEmptyElementTest`
 * guard is already the spec's nullish check. Only the "element → string" TAIL
 * differs. This module supplies that tail and nothing else, so the join fold,
 * its bounds check, its hole handling and the #4491 lane-J prototype-hole
 * fallback stay byte-identical for `join`/`toString`.
 *
 * ## Deliberate scope: BOXED elements only
 *
 * The tail is installed on the arms whose element can actually CARRY a user
 * `toLocaleString` — the boxed-any (`externref`) and non-string GC-ref element
 * arms, plus the prototype-hole fallback. The primitive arms (f64/i32 numeric,
 * the #2105 boolean arm) keep rendering through `number_toString` /
 * `"true"`/`"false"`. That is not a shortcut for its own sake: routing every
 * numeric element through a reflective `Invoke` would put a method dispatch in
 * `[1,2,3].toLocaleString()`, and the answer it would compute is the one
 * already emitted, because host-free there is no `Intl` and
 * `Number.prototype.toLocaleString` degrades to `ToString`. The residual it
 * leaves is real and pinned rather than hidden: an element whose PRIMITIVE
 * prototype method is overridden (`Boolean.prototype.toString = …`, test262
 * `toLocaleString/primitive_this_value.js`) is still rendered natively.
 *
 * **That residual is NOT this module's to fix, and boxing here would not fix
 * it** — an earlier draft of this paragraph claimed it would, and a probe
 * refuted that. With `Boolean.prototype.toString` overridden to return
 * `typeof this`: `typeof true.toLocaleString` is already `"function"` (the
 * reflective read resolves), yet `true.toLocaleString()` answers `"true"` and
 * so does `String(true)`. The override is ignored by primitive→string
 * conversion itself, one level below this lowering, so a boxed element routed
 * through the Invoke above would inherit the same wrong answer while paying for
 * a method dispatch per numeric element.
 *
 * ## Why the Invoke is `__extern_get` + `__apply_closure`, not `__extern_method_call`
 *
 * The obvious spelling is the generic dispatcher, and it was the first cut. It
 * throws `TypeError: called value is not a function` on the very shape this
 * issue is about, and the reason is worth recording because it is not obvious
 * from the call site: `__extern_method_call`'s method-resolution arm is gated
 * on `ref.test $Object(recv)` — the OPEN dynamic-object carrier. An object
 * LITERAL with known fields is a CLOSED `$__anon_N` struct, which fails that
 * test and falls to the `$Vec`/closure-own-property else arm, where nothing
 * matches and the resolved method is null (`buildVecOrClosurePropMethodCallElseArm`,
 * vec-props.ts). Measured: `[obj, obj].toLocaleString()` with
 * `obj = { toLocaleString: … }` threw; the same object reached through a
 * COMPUTED member call `arr[0][k]()` worked, because that spelling is a typed
 * member dispatch and never enters `__extern_method_call` at all. So a probe of
 * the dynamic call in JS does NOT establish that this lowering can use it.
 *
 * `__extern_get` has no such gate (the member-get dispatcher answers for closed
 * structs too), so the tail resolves the method itself and hands it to
 * `__apply_closure` — exactly what the `$Object` arm does after its test, minus
 * the test.
 *
 * ## Absent-not-wrong on the method miss
 *
 * A null resolution falls back to `ToString(elem)`, today's answer, instead of
 * §23.1.3.32's TypeError. That is deliberate: the reflective read does not see
 * every builtin prototype method, so a `toLocaleString` this lowering cannot
 * find is far more likely to be one it cannot SEE than one that is genuinely
 * absent — and throwing on a value that stringifies fine today would turn a
 * partially-right answer into a hard failure. The narrower conformance loss
 * (no TypeError for a truly absent/non-callable `toLocaleString`) is recorded
 * as a residual rather than paid for with a regression.
 *
 * ## Zero-argument Invoke
 *
 * `__apply_closure` treats a null args carrier as an empty argument list
 * (`guardNullableApplyArguments`, apply-closure-args.ts), so `ref.null.extern`
 * IS the zero-argument call and no `$ObjVec` is allocated per element. That is
 * also the spec shape: §23.1.3.32's reserved `locales`/`options` are NOT
 * forwarded to the element (test262
 * `toLocaleString/invoke-element-tolocalestring.js` asserts exactly that), and
 * they must not be read as `join`'s separator either — which the caller
 * enforces by never compiling `callExpr.arguments[0]` as a separator in this
 * mode.
 */
import type { Instr, ValType } from "../ir/types.js";
import { joinEmptyElementTest } from "./array-holes.js";
import { buildJoinBoxedElementToString } from "./array-join-element.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

/** The method name §23.1.3.32 step 6.c.i invokes on every non-nullish element. */
const ELEMENT_METHOD = "toLocaleString";

/**
 * §7.1.17 ToString, named once. Step 6.c.i applies it to the Invoke RESULT, and
 * the absent-method fallback applies it to the element — three call sites for
 * one operation, so the name is a constant rather than three string literals.
 */
const TO_STRING = "__extern_toString";

/** Scratch slots {@link elementToLocaleStringTail} needs, or `undefined` when unarmed. */
export interface ElementToLocaleStringArm {
  readonly recvLocal: number;
  readonly methodLocal: number;
}

/**
 * Register everything {@link elementToLocaleStringTail} needs, flush the
 * resulting index shifts, and allocate its two scratch locals.
 *
 * MUST run before the caller captures any other `funcIdx`: registering an
 * import shifts every defined-function index at or above it (the #2043
 * late-shift class). The tail itself re-resolves every index by NAME for the
 * same reason.
 *
 * Returns `undefined` when a required native is unavailable, in which case the
 * caller keeps the unchanged `join` tail — a `toLocaleString` that renders like
 * `toString` is today's answer, so declining costs nothing that was not already
 * lost.
 */
export function ensureElementToLocaleStringInvoke(
  ctx: CodegenContext,
  fctx: FunctionContext,
): ElementToLocaleStringArm | undefined {
  const externref: ValType = { kind: "externref" };
  ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
  ensureLateImport(ctx, "__apply_closure", [externref, externref, externref], [externref]);
  ensureLateImport(ctx, TO_STRING, [externref], [externref]);
  // The nullish→"" guard (§23.1.3.32 step 6.c) needs this too; the externref
  // join lane never registered it because it had no such guard.
  ensureLateImport(ctx, "__extern_is_undefined", [externref], [{ kind: "i32" }]);
  addStringConstantGlobal(ctx, ELEMENT_METHOD);
  addStringConstantGlobal(ctx, "");
  flushLateImportShifts(ctx, fctx);
  for (const name of ["__extern_get", "__apply_closure", TO_STRING]) {
    if (ctx.funcMap.get(name) === undefined) return undefined;
  }
  return {
    recvLocal: allocLocal(fctx, `__tls_recv_${fctx.locals.length}`, externref),
    methodLocal: allocLocal(fctx, `__tls_m_${fctx.locals.length}`, externref),
  };
}

/**
 * `[externref elem] → [ref $AnyString]` —
 * `ToString(Invoke(elem, "toLocaleString"))`.
 *
 * Shaped as a drop-in replacement for the `__extern_toString` chain the join
 * arms already use, so a call site swaps ONE array and changes nothing else.
 * Returns `undefined` when unarmed, so every caller can keep its existing tail
 * with a `??`.
 */
export function elementToLocaleStringTail(
  ctx: CodegenContext,
  anyStrTypeIdx: number,
  arm: ElementToLocaleStringArm | undefined,
): Instr[] | undefined {
  if (arm === undefined || anyStrTypeIdx < 0) return undefined;
  const getIdx = ctx.funcMap.get("__extern_get");
  const applyIdx = ctx.funcMap.get("__apply_closure");
  const toStrIdx = ctx.funcMap.get(TO_STRING);
  if (getIdx === undefined || applyIdx === undefined || toStrIdx === undefined) return undefined;
  const toStringTail: Instr[] = [
    { op: "call", funcIdx: toStrIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
  ];
  const nullishToNull = ctx.funcMap.get("__nullish_to_null");
  return [
    { op: "local.tee", index: arm.recvLocal },
    ...stringConstantExternrefInstrs(ctx, ELEMENT_METHOD),
    { op: "call", funcIdx: getIdx },
    // `undefined` and `null` are the same miss here; the singleton would
    // otherwise sail past `ref.is_null` and reach `__apply_closure` as a value.
    ...(nullishToNull !== undefined ? ([{ op: "call", funcIdx: nullishToNull }] satisfies Instr[]) : []),
    { op: "local.tee", index: arm.methodLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: anyStrTypeIdx } },
      // Miss ⇒ today's answer (see "Absent-not-wrong" in the module header).
      then: [{ op: "local.get", index: arm.recvLocal }, ...toStringTail],
      else: [
        { op: "local.get", index: arm.methodLocal },
        { op: "local.get", index: arm.recvLocal },
        { op: "ref.null.extern" },
        { op: "call", funcIdx: applyIdx },
        ...toStringTail,
      ],
    },
  ];
}

/**
 * `[externref elem] → [ref $AnyString]` for the EXTERN-receiver join lane
 * (`compileArrayJoinExternNative`): the unchanged `__extern_toString` chain, or
 * — under `arm` — the §23.1.3.32 element invoke behind the same nullish→`""`
 * guard the boxed-vec lane already uses.
 *
 * That guard is ADDED, not shared, on this lane: `join`'s extern path renders
 * an `undefined` element through plain ToString and this function must not
 * change that, so the guard is emitted only when `arm` is present.
 * `buildJoinBoxedElementToString` supplies the shape so the two lanes cannot
 * drift apart in how they answer step 6.c / step 4.b.
 */
export function buildExternJoinElementToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anyStrTypeIdx: number,
  externToStrIdx: number,
  arm: ElementToLocaleStringArm | undefined,
): Instr[] {
  const tail = elementToLocaleStringTail(ctx, anyStrTypeIdx, arm);
  if (tail === undefined) {
    return [
      { op: "call", funcIdx: ctx.funcMap.get(TO_STRING) ?? externToStrIdx },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
    ];
  }
  const empty = joinEmptyElementTest(ctx, fctx, () => ctx.funcMap.get("__extern_is_undefined"));
  return buildJoinBoxedElementToString(ctx, anyStrTypeIdx, empty, externToStrIdx, false, tail);
}

/**
 * Is this join-shaped call actually `Array.prototype.toLocaleString`?
 *
 * Read off the property access rather than threaded from the dispatcher: the
 * two lowerings this arms (`compileArrayJoinNative`,
 * `compileArrayJoinExternNative`) already receive the access, and every route
 * into them — the direct dispatch, the `Array.prototype.<m>.call` synthetic
 * rewrite in array-prototype-borrow.ts, and the #3342 `any`-receiver `join`
 * shortcut in calls-closures.ts — carries the real method name on it. Deriving
 * it here keeps the god-file's dispatch switch byte-identical.
 */
export function isLocalizedJoin(propAccess: { readonly name: { readonly text: string } }): boolean {
  return propAccess.name.text === ELEMENT_METHOD;
}
