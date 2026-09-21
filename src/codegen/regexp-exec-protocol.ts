// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B2 — carries the pinned contract of #5198 Slice B /
 * draft PR #5393) §22.2.7.1 **RegExpExec**, the observable substrate under
 * `RegExp.prototype[@@match]`, `[@@replace]`, `[@@search]` and `[@@split]`,
 * standalone.
 *
 * ```
 * 22.2.7.1 RegExpExec ( R, S )
 *   1. Assert: Type(R) is Object.
 *   2. Assert: Type(S) is String.
 *   3. Let exec be ? Get(R, "exec").
 *   4. If IsCallable(exec) is true, then
 *      a. Let result be ? Call(exec, R, « S »).
 *      b. If Type(result) is neither Object nor Null, throw a TypeError.
 *      c. Return result.
 *   5. Perform ? RequireInternalSlot(R, [[RegExpMatcher]]).
 *   6. Return ? RegExpBuiltinExec(R, S).
 * ```
 *
 * ## Why this is a substrate and not four arms
 *
 * Step 3 is an ordinary `[[Get]]`, so **every** observable property of these
 * four methods hangs off it: a poisoned `exec` accessor throws (`get-exec-err`),
 * a callable `exec` is invoked with the regexp as `this` and exactly one
 * argument (`exec-invocation`), its abrupt completion propagates (`exec-err`),
 * and a primitive return is a TypeError (`exec-return-type-invalid`). Each of
 * the four `@@` methods calls RegExpExec — @@match once per match, @@search
 * once, @@replace/@@split once per iteration — so implementing it four times
 * would mean four chances to get step 4.b wrong. It is emitted here once and
 * inlined at each call site through {@link buildRegExpExecInstrs}.
 *
 * ## Why step 5 IS the brand-check widening
 *
 * `recoverRegExpStructFromExternref` (regexp-standalone.ts) is the standalone
 * RegExp brand check: a `this` that is not a `$NativeRegExp` throws
 * `Method called on incompatible receiver (RegExp brand check failed)`. Until
 * this module, that check ran as the FIRST instruction of every reflective
 * `RegExp.prototype.*` body — which is right for `.test`/`.flags` and **wrong**
 * for the four `@@` methods. §22.2.6.8/.11/.12/.14 step 2 requires only
 * `Type(rx) is Object`; the brand requirement appears later, in RegExpExec
 * **step 5**, and is reached only when `exec` is NOT callable. So
 * `RegExp.prototype[Symbol.search].call({exec: f}, s)` is spec-legal and the
 * old ordering rejected it before it could ever run `f`. That is why the 18
 * `brand check failed` rows are not an independent bucket: they are the same
 * defect as the 44 `exec` rows, observed one step earlier.
 *
 * The brand check is therefore not removed — it is MOVED to where the spec puts
 * it, and it still throws the identical message, so a genuinely wrong `this`
 * with no `exec` reports exactly what it reported before.
 *
 * ## What the emitted code uses
 *
 * `__extern_get` / `__extern_set` (real `[[Get]]`/`[[Set]]` — accessors run and
 * abrupt completions propagate), `__is_callable` (IsCallable, which unlike
 * `__typeof_function` excludes a class constructor — a class object reports
 * `typeof "function"` but has no [[Call]]), `__typeof_object` (Type(x) is
 * Object; note it answers 1 for a null externref under the #2106 singleton
 * regime, so the null test must come first and separately), `__objvec_new` /
 * `__objvec_push` / `__apply_closure` (the Call), `__extern_toString`,
 * `__box_number` / `__unbox_number` and `__same_value_zero`. No new host
 * import: every one of these is already part of the standalone object runtime.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/** Property keys the protocol reads or writes as ordinary string keys. */
const PROTOCOL_KEYS = ["exec", "lastIndex", "index"] as const;

/** Resolved indices of every native the protocol emits. All by NAME, late. */
interface RegExpExecProtocolDeps {
  readonly externGet: number;
  readonly externSet: number;
  readonly externToString: number;
  readonly isCallable: number;
  readonly typeofObject: number;
  readonly sameValueZero: number;
  readonly unboxNumber: number;
  readonly boxNumber: number;
  readonly objVecNew: number;
  readonly objVecPush: number;
  readonly applyClosure: number;
}

/**
 * Register every native the protocol needs, flush the resulting index shifts,
 * and resolve the indices in ONE batch.
 *
 * MUST run before any caller captures a `funcIdx`: registering an import shifts
 * every defined-function index at or above it (the #2043 late-shift class).
 * Returns `undefined` when any native is unavailable, in which case the caller
 * keeps its existing lowering unchanged.
 */
function prepareRegExpExecProtocol(ctx: CodegenContext, fctx: FunctionContext): RegExpExecProtocolDeps | undefined {
  ensureObjectRuntime(ctx);
  // `__str_indexOf` (the `flags`-contains-`g` test) lives in the native-string
  // helper set, which is registered lazily; ask for it before any index is read.
  ensureNativeStringHelpers(ctx);
  const applyClosure = reserveApplyClosure(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_set", [EXTERNREF, EXTERNREF, EXTERNREF], []);
  ensureLateImport(ctx, "__extern_toString", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__is_callable", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__same_value_zero", [EXTERNREF, EXTERNREF], [I32]);
  ensureLateImport(ctx, "__unbox_number", [EXTERNREF], [F64]);
  ensureLateImport(ctx, "__box_number", [F64], [EXTERNREF]);
  for (const key of PROTOCOL_KEYS) addStringConstantGlobal(ctx, key);
  flushLateImportShifts(ctx, fctx);

  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const externGet = get("__extern_get");
  const externSet = get("__extern_set");
  const externToString = get("__extern_toString");
  const isCallable = get("__is_callable");
  const typeofObject = get("__typeof_object");
  const sameValueZero = get("__same_value_zero");
  const unboxNumber = get("__unbox_number");
  const boxNumber = get("__box_number");
  const objVecNew = get("__objvec_new");
  const objVecPush = get("__objvec_push");
  if (
    externGet === undefined ||
    externSet === undefined ||
    externToString === undefined ||
    isCallable === undefined ||
    typeofObject === undefined ||
    sameValueZero === undefined ||
    unboxNumber === undefined ||
    boxNumber === undefined ||
    objVecNew === undefined ||
    objVecPush === undefined
  ) {
    return undefined;
  }
  return {
    externGet,
    externSet,
    externToString,
    isCallable,
    typeofObject,
    sameValueZero,
    unboxNumber,
    boxNumber,
    objVecNew,
    objVecPush,
    applyClosure,
  };
}

/** `[] → [externref]` — the boxed number `+0`, the SameValue comparand of §22.2.6.12 step 5. */
function boxedZero(deps: RegExpExecProtocolDeps): Instr[] {
  return [
    { op: "f64.const", value: 0 },
    { op: "call", funcIdx: deps.boxNumber },
  ];
}

/** `[] → [externref]` — an ordinary string key, resolved from the constant pool. */
function keyInstrs(ctx: CodegenContext, key: string): Instr[] {
  return stringConstantExternrefInstrs(ctx, key);
}

/** `[] → [externref]` — `? Get(objLocal, key)`. The accessor RUNS; an abrupt getter propagates. */
function buildGetInstrs(ctx: CodegenContext, deps: RegExpExecProtocolDeps, objLocal: number, key: string): Instr[] {
  return [{ op: "local.get", index: objLocal }, ...keyInstrs(ctx, key), { op: "call", funcIdx: deps.externGet }];
}

/** `[externref value] → []` — `? Set(objLocal, key, value, true)`. The setter RUNS. */
function buildSetInstrs(
  ctx: CodegenContext,
  deps: RegExpExecProtocolDeps,
  objLocal: number,
  key: string,
  value: Instr[],
): Instr[] {
  return [
    { op: "local.get", index: objLocal },
    ...keyInstrs(ctx, key),
    ...value,
    { op: "call", funcIdx: deps.externSet },
  ];
}

/**
 * `[] → [i32]` — §7.2.10 **SameValue**(a, b) for two arbitrary boxed values.
 *
 * `__same_value_zero` is SameValue everywhere except ±0, where SameValueZero
 * answers `true` and SameValue answers `false`. That single difference is
 * load-bearing here and is measured by two rows: `@@search`'s
 * `set-lastindex-init-samevalue` sets `lastIndex = -0` and requires the
 * `Set(rx, "lastIndex", +0)` to happen anyway, and
 * `set-lastindex-restore-samevalue` requires the restore after an `exec` that
 * wrote `-0`. `assert.sameValue` distinguishes `-0` from `+0`, so answering
 * "equal" there is a visible wrong answer, not a rounding detail.
 *
 * The correction: when SameValueZero holds AND both operands are numeric zeros,
 * compare their signs. `1 / x` is `+Infinity` for `+0` and `-Infinity` for `-0`,
 * which needs no `i64.reinterpret_f64` and no extra local.
 */
function buildSameValue(deps: RegExpExecProtocolDeps, aLocal: number, bLocal: number): Instr[] {
  const isZero = (local: number): Instr[] => [
    { op: "local.get", index: local },
    ...boxedZero(deps),
    { op: "call", funcIdx: deps.sameValueZero },
  ];
  // `1 / unbox(x) < 0` — true exactly for -0 among the zeros.
  const isNegZero = (local: number): Instr[] => [
    { op: "f64.const", value: 1 },
    { op: "local.get", index: local },
    { op: "call", funcIdx: deps.unboxNumber },
    { op: "f64.div" },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
  ];
  return [
    { op: "local.get", index: aLocal },
    { op: "local.get", index: bLocal },
    { op: "call", funcIdx: deps.sameValueZero },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        ...isZero(aLocal),
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          // both are ±0 (SameValueZero already holds) — signs must agree.
          then: [...isNegZero(aLocal), ...isNegZero(bLocal), { op: "i32.eq" }],
          else: [{ op: "i32.const", value: 1 }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * `[] → [externref]` — §22.2.7.1 **RegExpExec(R, S)**.
 *
 * `rxLocal` holds R (already proven to be an Object by the caller's step 2),
 * `sLocal` holds S (already `ToString`ed by the caller). `builtinExecArm` is the
 * step 5 + step 6 lowering: the caller's own brand recovery plus
 * `RegExpBuiltinExec`, leaving an externref (a match object, or null) on the
 * stack. It is passed in rather than emitted here because the builtin exec is a
 * `$NativeRegExp` operation and this module deliberately knows nothing about
 * that struct — keeping the substrate usable from any receiver shape.
 */
function buildRegExpExecInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: RegExpExecProtocolDeps,
  rxLocal: number,
  sLocal: number,
  builtinExecArm: Instr[],
): Instr[] {
  const execLocal = allocLocal(fctx, `__rx_exec_${fctx.locals.length}`, EXTERNREF);
  const argsLocal = allocLocal(fctx, `__rx_args_${fctx.locals.length}`, EXTERNREF);
  const resultLocal = allocLocal(fctx, `__rx_res_${fctx.locals.length}`, EXTERNREF);

  const invalidResult = buildThrowJsErrorInstrs(ctx, "TypeError", "RegExp exec must return an Object or null", {
    flush: fctx,
  });

  const customArm: Instr[] = [
    // step 4.a — Call(exec, R, «S»). One argument exactly: `exec-invocation`
    // asserts `arguments.length === 1`.
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: sLocal },
    { op: "call", funcIdx: deps.objVecPush },
    { op: "local.get", index: execLocal },
    { op: "local.get", index: rxLocal },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: deps.applyClosure },
    { op: "local.set", index: resultLocal },
    // step 4.b — neither Object nor Null is a TypeError. `undefined` is NOT
    // null here: under the #2106 singleton regime it is a tagged value that
    // `ref.is_null` does not answer for, and `__typeof_object` answers 0 for,
    // so it correctly lands in the throw arm.
    { op: "local.get", index: resultLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: resultLocal },
        { op: "call", funcIdx: deps.typeofObject },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: invalidResult, else: [] },
      ],
    },
    { op: "local.get", index: resultLocal },
  ];

  return [
    // step 3 — an ordinary [[Get]]; a poisoned accessor throws from here.
    ...buildGetInstrs(ctx, deps, rxLocal, "exec"),
    { op: "local.set", index: execLocal },
    { op: "local.get", index: execLocal },
    { op: "call", funcIdx: deps.isCallable },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: customArm,
      // steps 5-6 — RequireInternalSlot(R, [[RegExpMatcher]]) + RegExpBuiltinExec.
      else: builtinExecArm,
    },
  ];
}

/**
 * `[] → [i32]` — `Type(local) is Object`, §6.1.7.
 *
 * Two natives rather than one because `__typeof_object` implements `typeof`,
 * and `typeof null === "object"`: under the #2106 singleton regime it answers 1
 * for a null externref. A receiver test that trusted it alone would admit
 * `RegExp.prototype[Symbol.search].call(null)`, which `this-val-non-obj`
 * requires to be a TypeError.
 */
function buildIsObjectInstrs(deps: RegExpExecProtocolDeps, local: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: local },
        { op: "call", funcIdx: deps.typeofObject },
      ],
    },
  ];
}

/**
 * Step 2 of §22.2.6.8/.11/.12/.14: `If Type(rx) is not Object, throw a
 * TypeError`. Emitted with the same message the brand check uses, because from
 * the caller's side it is the same failure — an unusable receiver — and the two
 * rows that exercise it (`this-val-non-obj`, `this-val-non-regexp`) assert only
 * the error TYPE.
 */
function buildRequireObjectReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: RegExpExecProtocolDeps,
  rxLocal: number,
): Instr[] {
  const throwInstrs = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Method called on incompatible receiver (RegExp brand check failed)",
    { flush: fctx },
  );
  return [
    ...buildIsObjectInstrs(deps, rxLocal),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] },
  ];
}

/**
 * Emit `emit()` through the REAL function context and splice the result back
 * out. Every lowering in this subsystem registers locals, late imports and
 * string constants as a side effect of emission, so a branch arm cannot be
 * built in a detached buffer — it has to be emitted where those registrations
 * land and then moved into the branch.
 */
function captureInto(fctx: FunctionContext, emit: () => void): Instr[] {
  const start = fctx.body.length;
  emit();
  return fctx.body.splice(start);
}

/** How a `@@` method body reaches `RegExpBuiltinExec` for a genuine RegExp receiver. */
type BuiltinExecEmitter = (
  /** Local holding the externref `this`, still un-branded. */
  rxLocal: number,
  /** Local holding the already-`ToString`ed subject, as an externref. */
  sLocal: number,
) => void;

/**
 * §22.2.6.12 `RegExp.prototype[@@search](string)` — the FULL generic body, over
 * an arbitrary Object receiver.
 *
 * ```
 *   1-3. rx = this; if Type(rx) is not Object, throw TypeError; S = ? ToString(string)
 *   4. previousLastIndex = ? Get(rx, "lastIndex")
 *   5. If SameValue(previousLastIndex, +0) is false, ? Set(rx, "lastIndex", +0, true)
 *   6. result = ? RegExpExec(rx, S)
 *   7. currentLastIndex = ? Get(rx, "lastIndex")
 *   8. If SameValue(currentLastIndex, previousLastIndex) is false,
 *      ? Set(rx, "lastIndex", previousLastIndex, true)
 *   9. If result is null, return -1
 *  10. Return ? Get(result, "index")
 * ```
 *
 * Every step is observable and each has its own row: the two `Get`s
 * (`lastindex-no-restore` asserts there are exactly TWO reads, `get-lastindex-err`
 * poisons the first), the conditional `Set`s (`set-lastindex-init*`,
 * `set-lastindex-restore*` — two of which hinge on SameValue vs SameValueZero
 * for `-0`), the exec call (`match-err`, `cstm-exec-return-index`) and the
 * final `Get` (`success-get-index-err`). Writing the body as the spec writes it
 * is cheaper than deriving which of those effects the native engine happens to
 * reproduce, and it is the only shape in which the counts are right.
 *
 * Params are the reflective-closure ABI: index 1 is the externref `this`,
 * index 2 the first argument. Leaves an externref (boxed number) on the stack.
 */
export function emitRegExpSymbolSearchBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  thisParam: number,
  argParam: number,
  emitBuiltinExec: BuiltinExecEmitter,
): ValType | null {
  const deps = prepareRegExpExecProtocol(ctx, fctx);
  if (deps === undefined) return null;

  // steps 1-2 — Type(rx) is Object. NOT the RegExp brand: that moved to
  // RegExpExec step 5 (see the module header).
  for (const instr of buildRequireObjectReceiver(ctx, fctx, deps, thisParam)) fctx.body.push(instr);

  // step 3 — ToString(string), ONCE. `coerce-string-err` poisons the argument's
  // `toString`, so a second coercion anywhere below would double a side effect.
  const sLocal = allocLocal(fctx, `__rx_s_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: argParam });
  fctx.body.push({ op: "call", funcIdx: deps.externToString });
  fctx.body.push({ op: "local.set", index: sLocal });

  const zeroLocal = allocLocal(fctx, `__rx_zero_${fctx.locals.length}`, EXTERNREF);
  for (const instr of boxedZero(deps)) fctx.body.push(instr);
  fctx.body.push({ op: "local.set", index: zeroLocal });

  // step 4
  const prevLocal = allocLocal(fctx, `__rx_prev_${fctx.locals.length}`, EXTERNREF);
  for (const instr of buildGetInstrs(ctx, deps, thisParam, "lastIndex")) fctx.body.push(instr);
  fctx.body.push({ op: "local.set", index: prevLocal });

  // step 5
  const setZero = buildSetInstrs(ctx, deps, thisParam, "lastIndex", [{ op: "local.get", index: zeroLocal }]);
  for (const instr of buildSameValue(deps, prevLocal, zeroLocal)) fctx.body.push(instr);
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: setZero, else: [] });

  // step 6 — the substrate. The builtin arm is emitted FIRST so every local and
  // late import it registers is in place before the branch that hosts it, and
  // `deps` is RE-RESOLVED afterwards: the builtin lowering may register an
  // import, which shifts every defined-function index at or above it. The
  // shift rewrites what is still in `fctx.body`, but NOT the numbers already
  // captured in `deps` — so an index read before the arm and emitted after it
  // would be one import stale (the #2043 late-shift class, in its
  // easiest-to-miss form).
  const builtinArm = captureInto(fctx, () => emitBuiltinExec(thisParam, sLocal));
  const post = prepareRegExpExecProtocol(ctx, fctx) ?? deps;
  const resultLocal = allocLocal(fctx, `__rx_out_${fctx.locals.length}`, EXTERNREF);
  for (const instr of buildRegExpExecInstrs(ctx, fctx, post, thisParam, sLocal, builtinArm)) {
    fctx.body.push(instr);
  }
  fctx.body.push({ op: "local.set", index: resultLocal });

  // step 7
  const curLocal = allocLocal(fctx, `__rx_cur_${fctx.locals.length}`, EXTERNREF);
  for (const instr of buildGetInstrs(ctx, post, thisParam, "lastIndex")) fctx.body.push(instr);
  fctx.body.push({ op: "local.set", index: curLocal });

  // step 8
  const restore = buildSetInstrs(ctx, post, thisParam, "lastIndex", [{ op: "local.get", index: prevLocal }]);
  for (const instr of buildSameValue(post, curLocal, prevLocal)) fctx.body.push(instr);
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: restore, else: [] });

  // steps 9-10
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: [
      { op: "f64.const", value: -1 },
      { op: "call", funcIdx: post.boxNumber },
    ],
    else: buildGetInstrs(ctx, post, resultLocal, "index"),
  });
  return EXTERNREF;
}

/**
 * `[] → [i32]` — does the `ToString`ed `flags` value contain the code unit `g`?
 *
 * `__str_indexOf(haystack, needle, 0) >= 0` over the existing native-string
 * helper, which flattens both operands itself. The flags value arrives as an
 * externref (it came out of an ordinary `Get` + `ToString`), so both operands
 * are narrowed to `ref $AnyString` the same way every other externref-string
 * consumer narrows them.
 *
 * Availability is asked SEPARATELY, by {@link flagsContainAvailable}, so the
 * caller can decline before it has emitted anything — this builder is only
 * reached once the answer is known to be yes.
 */
function flagsContainAvailable(ctx: CodegenContext): boolean {
  return ctx.nativeStrHelpers.get("__str_indexOf") !== undefined && ctx.anyStrTypeIdx >= 0;
}

function buildFlagsContainInstrs(ctx: CodegenContext, flagsLocal: number, flag: string): Instr[] {
  const indexOf = ctx.nativeStrHelpers.get("__str_indexOf") ?? 0;
  addStringConstantGlobal(ctx, flag);
  return [
    { op: "local.get", index: flagsLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    ...stringConstantExternrefInstrs(ctx, flag),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: indexOf },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
  ];
}

/**
 * §22.2.6.8 `RegExp.prototype[@@match](string)`, generic over an Object receiver.
 *
 * ```
 *   1-3. rx = this; Type(rx) must be Object; S = ? ToString(string)
 *   4. flags = ? ToString(? Get(rx, "flags"))
 *   5. If flags does not contain "g", return ? RegExpExec(rx, S)
 *   6. else: ? Set(rx, "lastIndex", +0, true); then collect every match
 * ```
 *
 * The NON-GLOBAL arm is the whole method: step 5 returns RegExpExec's result by
 * identity, which is why `exec-return-type-valid` can assert the exec object
 * comes back unchanged and why no result property is read here.
 *
 * The GLOBAL arm is deliberately PARTIAL: it performs step 6's observable
 * prefix — the `Set(rx, "lastIndex", +0)` and the first `RegExpExec` — and then
 * answers `null`. The collect loop needs a runtime Array plus AdvanceStringIndex,
 * a second mechanism that belongs with the `@@replace`/`@@split` result loops.
 * Answering `null` is exactly what this closure answered BEFORE this change (its
 * body was a `ref.null.extern` placeholder), so the partial arm strictly adds
 * observable effects that the spec requires and removes none: a poisoned
 * `lastIndex` setter or a poisoned `exec` getter now throws where it previously
 * went unnoticed. A global match that actually matches still answers `null`, and
 * that residual is recorded in #6651 rather than papered over.
 *
 * Params are the reflective-closure ABI: 1 = `this`, 2 = the first argument.
 */
export function emitRegExpSymbolMatchBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  thisParam: number,
  argParam: number,
  emitBuiltinExec: BuiltinExecEmitter,
): ValType | null {
  const deps = prepareRegExpExecProtocol(ctx, fctx);
  if (deps === undefined) return null;
  // EVERY decline has to happen here, before the first `fctx.body.push`. A
  // body that bails half-emitted leaves the operand stack unbalanced and the
  // whole module fails to validate — which is a far worse failure than the
  // "keep the previous answer" the caller's decline path is written to give.
  // `__str_indexOf` is the one dependency that is not part of `deps`.
  if (!flagsContainAvailable(ctx)) return null;

  for (const instr of buildRequireObjectReceiver(ctx, fctx, deps, thisParam)) fctx.body.push(instr);

  const sLocal = allocLocal(fctx, `__rm_s_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: argParam });
  fctx.body.push({ op: "call", funcIdx: deps.externToString });
  fctx.body.push({ op: "local.set", index: sLocal });

  // step 4 — the `flags` Get and its ToString are both observable and ordered
  // before anything else (`get-flags-err` asserts `global`/`unicode` are NOT
  // read, which only holds if the flags value is taken as one Get).
  const flagsLocal = allocLocal(fctx, `__rm_flags_${fctx.locals.length}`, EXTERNREF);
  for (const instr of buildGetInstrs(ctx, deps, thisParam, "flags")) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: deps.externToString });
  fctx.body.push({ op: "local.set", index: flagsLocal });

  const zeroLocal = allocLocal(fctx, `__rm_zero_${fctx.locals.length}`, EXTERNREF);
  for (const instr of boxedZero(deps)) fctx.body.push(instr);
  fctx.body.push({ op: "local.set", index: zeroLocal });

  // Both builtin arms are emitted (and spliced out) BEFORE any further index is
  // read — see the same note in the `@@search` body. Everything below uses the
  // re-resolved `post`.
  const builtinArmGlobal = captureInto(fctx, () => emitBuiltinExec(thisParam, sLocal));
  const builtinArm = captureInto(fctx, () => emitBuiltinExec(thisParam, sLocal));
  const post = prepareRegExpExecProtocol(ctx, fctx) ?? deps;

  const hasG = buildFlagsContainInstrs(ctx, flagsLocal, "g");

  const globalArm: Instr[] = [
    ...buildSetInstrs(ctx, post, thisParam, "lastIndex", [{ op: "local.get", index: zeroLocal }]),
    ...buildRegExpExecInstrs(ctx, fctx, post, thisParam, sLocal, builtinArmGlobal),
    { op: "drop" },
    { op: "ref.null.extern" },
  ];
  const nonGlobalArm = buildRegExpExecInstrs(ctx, fctx, post, thisParam, sLocal, builtinArm);

  for (const instr of hasG) fctx.body.push(instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: globalArm,
    else: nonGlobalArm,
  });
  return EXTERNREF;
}
