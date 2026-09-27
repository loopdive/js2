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
import { prepareStandaloneExternrefToNumberProviders } from "./tonumber-fast-paths.js";
import { ensureSpecExternrefToStringProvider } from "./coercion-engine.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/** Property keys the protocol reads or writes as ordinary string keys. */
const PROTOCOL_KEYS = ["exec", "lastIndex", "index"] as const;

/** Resolved indices of every native the protocol emits. All by NAME, late. */
export interface RegExpExecProtocolDeps {
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
export function prepareRegExpExecProtocol(
  ctx: CodegenContext,
  fctx: FunctionContext,
): RegExpExecProtocolDeps | undefined {
  ensureObjectRuntime(ctx);
  // `__str_indexOf` (the `flags`-contains-`g` test) lives in the native-string
  // helper set, which is registered lazily; ask for it before any index is read.
  ensureNativeStringHelpers(ctx);
  const applyClosure = reserveApplyClosure(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_set", [EXTERNREF, EXTERNREF, EXTERNREF], []);
  // (#6651 B6) Every `Set` in §22.2.6/§22.2.7 is `Set(R, "lastIndex", v, true)`:
  // a refused write (non-writable `lastIndex`, getter-only accessor) THROWS.
  ensureLateImport(ctx, "__extern_set_strict", [EXTERNREF, EXTERNREF, EXTERNREF], []);
  ensureLateImport(ctx, "__extern_toString", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__is_callable", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__same_value_zero", [EXTERNREF, EXTERNREF], [I32]);
  ensureLateImport(ctx, "__unbox_number", [EXTERNREF], [F64]);
  ensureLateImport(ctx, "__box_number", [F64], [EXTERNREF]);
  for (const key of PROTOCOL_KEYS) addStringConstantGlobal(ctx, key);
  flushLateImportShifts(ctx, fctx);
  // (#6651 B6) Every ToString in §22.2.6 is the spec's, which REJECTS a Symbol
  // (§7.1.17) — `@@split/coerce-{flags,string}-err`, `@@search/coerce-string-err`.
  // Provisioned before the index batch below: it may mint/flush.
  const specToString = ensureSpecExternrefToStringProvider(ctx, fctx);

  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const externGet = get("__extern_get");
  const externSet = get("__extern_set_strict") ?? get("__extern_set");
  const externToString =
    (specToString !== undefined ? get("__extern_to_string_spec") : undefined) ?? get("__extern_toString");
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
export function buildGetInstrs(
  ctx: CodegenContext,
  deps: RegExpExecProtocolDeps,
  objLocal: number,
  key: string,
): Instr[] {
  return [{ op: "local.get", index: objLocal }, ...keyInstrs(ctx, key), { op: "call", funcIdx: deps.externGet }];
}

/** `[externref value] → []` — `? Set(objLocal, key, value, true)`. The setter RUNS. */
export function buildSetInstrs(
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
export function buildRegExpExecInstrs(
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
export function buildRequireObjectReceiver(
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
export function captureInto(fctx: FunctionContext, emit: () => void): Instr[] {
  const start = fctx.body.length;
  emit();
  return fctx.body.splice(start);
}

/** How a `@@` method body reaches `RegExpBuiltinExec` for a genuine RegExp receiver. */
export type BuiltinExecEmitter = (
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
export function flagsContainAvailable(ctx: CodegenContext): boolean {
  return ctx.nativeStrHelpers.get("__str_indexOf") !== undefined && ctx.anyStrTypeIdx >= 0;
}

/**
 * (#6651 B3) Everything §22.2.6.8 step 6's COLLECT LOOP needs beyond
 * {@link RegExpExecProtocolDeps}: the flat-string reader behind
 * AdvanceStringIndex and the empty-match test, and the standalone
 * `externref → f64` ToNumber chain behind ToLength.
 *
 * Asked as one question, BEFORE the body emits anything — a `@@match` body that
 * declines half-emitted leaves the operand stack unbalanced and the whole
 * module fails to validate (B2's late correctness fix, same hazard).
 */
export interface MatchLoopDeps {
  readonly flatten: number;
  readonly anyStr: number;
  readonly nativeStr: number;
  readonly dataTypeIdx: number;
  readonly toPrimitive?: number;
}

export function prepareMatchLoopDeps(ctx: CodegenContext, fctx: FunctionContext): MatchLoopDeps | undefined {
  const flatten = ctx.nativeStrHelpers.get("__str_flatten");
  if (flatten === undefined || ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0 || ctx.nativeStrDataTypeIdx < 0) {
    return undefined;
  }
  // ToLength's input is `Get(rx, "lastIndex")`, an arbitrary value: the
  // canonical standalone chain is `__unbox_number(__to_primitive(v, "number"))`,
  // which is what makes a poisoned `valueOf` on `lastIndex` throw from where the
  // spec says it does. A context without `__to_primitive` degrades to the bare
  // unbox rather than declining the whole arm.
  const providers = prepareStandaloneExternrefToNumberProviders(ctx, fctx);
  if (providers !== undefined) addStringConstantGlobal(ctx, "number");
  return {
    flatten,
    anyStr: ctx.anyStrTypeIdx,
    nativeStr: ctx.nativeStrTypeIdx,
    dataTypeIdx: ctx.nativeStrDataTypeIdx,
    toPrimitive: providers?.toPrimitive,
  };
}

/** `[externref] → [ref $NativeString]` — narrow a string externref and flatten it. */
export function flattenExternStringInstrs(loop: MatchLoopDeps): Instr[] {
  return [
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: loop.anyStr },
    { op: "call", funcIdx: loop.flatten },
  ];
}

/**
 * `[] → [i32]` — §22.2.7.3 **AdvanceStringIndex**(S, index, unicode).
 *
 * `index + 1`, except that in unicode mode a lead surrogate followed by a trail
 * surrogate advances by 2 so the loop never splits an astral code point. The
 * code units are read straight out of the flattened subject's backing array
 * (`data[off + i]`), the same reader the matcher itself uses.
 */
export function buildAdvanceStringIndexInstrs(
  loop: MatchLoopDeps,
  flatLocal: number,
  idxLocal: number,
  unicodeLocal: number,
): Instr[] {
  const next1: Instr[] = [{ op: "local.get", index: idxLocal }, { op: "i32.const", value: 1 }, { op: "i32.add" }];
  const unit = (offset: number): Instr[] => [
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: loop.nativeStr, fieldIdx: 2 },
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: loop.nativeStr, fieldIdx: 1 },
    { op: "local.get", index: idxLocal },
    { op: "i32.add" },
    { op: "i32.const", value: offset },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: loop.dataTypeIdx },
  ];
  const isSurrogate = (offset: number, lo: number): Instr[] => [
    ...unit(offset),
    { op: "i32.const", value: 0xfc00 },
    { op: "i32.and" },
    { op: "i32.const", value: lo },
    { op: "i32.eq" },
  ];
  return [
    { op: "local.get", index: unicodeLocal },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        // index + 1 >= len ⇒ there is no trail unit to pair with.
        ...next1,
        { op: "local.get", index: flatLocal },
        { op: "struct.get", typeIdx: loop.nativeStr, fieldIdx: 0 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: next1,
          else: [
            ...isSurrogate(0, 0xd800),
            {
              op: "if",
              blockType: { kind: "val", type: I32 },
              then: [
                ...isSurrogate(1, 0xdc00),
                {
                  op: "if",
                  blockType: { kind: "val", type: I32 },
                  then: [{ op: "local.get", index: idxLocal }, { op: "i32.const", value: 2 }, { op: "i32.add" }],
                  else: next1,
                },
              ],
              else: next1,
            },
          ],
        },
      ],
      else: next1,
    },
  ];
}

export function buildFlagsContainInstrs(ctx: CodegenContext, flagsLocal: number, flag: string): Instr[] {
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
 * `[] → [externref]` — §22.2.6.8 **step 6**, the global collect loop, in full.
 *
 * ```
 *  6. else,
 *     a. Assert: flags contains "g"
 *     b. fullUnicode = flags contains "u"
 *     c. ? Set(rx, "lastIndex", +0, true)
 *     d. A = ! ArrayCreate(0);  e. n = 0
 *     f. repeat:
 *        i.   result = ? RegExpExec(rx, S)
 *        ii.  if result is null, return n = 0 ? null : A
 *        iii. matchStr = ? ToString(? Get(result, "0"))
 *             CreateDataProperty(A, ToString(n), matchStr)
 *             if matchStr is "":
 *                thisIndex = ℝ(? ToLength(? Get(rx, "lastIndex")))
 *                ? Set(rx, "lastIndex", AdvanceStringIndex(S, thisIndex, fullUnicode), true)
 *             n = n + 1
 * ```
 *
 * Three things this shape is load-bearing for, each with its own row:
 *
 * - **`Get(result, "0")` is a real `[[Get]]` and its result is `ToString`ed.**
 *   `g-get-result-err` poisons that getter and `g-coerce-result-err` poisons the
 *   returned object's `toString`; both must throw from inside the loop.
 * - **The empty-match advance is the loop's only termination guarantee.** A
 *   custom `exec` that keeps matching the empty string at a fixed `lastIndex`
 *   would spin forever without it; the spec's answer is AdvanceStringIndex, and
 *   its unicode arm is what keeps an astral code point from being split.
 * - **`n = 0 ⇒ null`.** The array is built eagerly, so the "no match at all"
 *   answer is decided by the counter, not by the carrier.
 *
 * The array carrier is the standalone `$ObjVec` (`__objvec_new` /
 * `__objvec_push`) — the same host-import-free, `[i]`/`.length`-readable
 * builder `Array.prototype.filter`/`map` use in this target. Pushing
 * sequentially IS `CreateDataProperty(A, ToString(n), …)` here because `n`
 * increases by exactly one per push, so the vec's dense index and the spec's
 * property key are the same number by construction.
 */
function buildMatchGlobalArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: RegExpExecProtocolDeps,
  loop: MatchLoopDeps,
  rxLocal: number,
  sLocal: number,
  flagsLocal: number,
  zeroLocal: number,
  builtinArm: Instr[],
): Instr[] {
  addStringConstantGlobal(ctx, "0");
  const aLocal = allocLocal(fctx, `__rm_a_${fctx.locals.length}`, EXTERNREF);
  const nLocal = allocLocal(fctx, `__rm_n_${fctx.locals.length}`, I32);
  const mLocal = allocLocal(fctx, `__rm_m_${fctx.locals.length}`, EXTERNREF);
  const resLocal = allocLocal(fctx, `__rm_res_${fctx.locals.length}`, EXTERNREF);
  const uLocal = allocLocal(fctx, `__rm_u_${fctx.locals.length}`, I32);
  const idxLocal = allocLocal(fctx, `__rm_i_${fctx.locals.length}`, I32);
  const flatSLocal = allocLocal(fctx, `__rm_fs_${fctx.locals.length}`, { kind: "ref", typeIdx: loop.nativeStr });

  // ToNumber, then §7.1.20 ToLength's clamp. `i32.trunc_sat_f64_s` answers 0
  // for NaN, which is ToLength's own answer for it; the explicit test below
  // covers the negative case.
  const toNumber: Instr[] =
    loop.toPrimitive === undefined
      ? [{ op: "call", funcIdx: deps.unboxNumber }]
      : [
          ...stringConstantExternrefInstrs(ctx, "number"),
          { op: "call", funcIdx: loop.toPrimitive },
          { op: "call", funcIdx: deps.unboxNumber },
        ];

  const emptyMatchArm: Instr[] = [
    ...buildGetInstrs(ctx, deps, rxLocal, "lastIndex"),
    ...toNumber,
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: idxLocal },
    { op: "local.get", index: idxLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: idxLocal },
      ],
      else: [],
    },
    ...buildSetInstrs(ctx, deps, rxLocal, "lastIndex", [
      ...buildAdvanceStringIndexInstrs(loop, flatSLocal, idxLocal, uLocal),
      { op: "f64.convert_i32_s" },
      { op: "call", funcIdx: deps.boxNumber },
    ]),
  ];

  const body: Instr[] = [
    // steps 6.b-6.e — the loop's invariants, established once.
    ...buildFlagsContainInstrs(ctx, flagsLocal, "u"),
    { op: "local.set", index: uLocal },
    { op: "local.get", index: sLocal },
    ...flattenExternStringInstrs(loop),
    { op: "local.set", index: flatSLocal },
    ...buildSetInstrs(ctx, deps, rxLocal, "lastIndex", [{ op: "local.get", index: zeroLocal }]),
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: aLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: nLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // step 6.f.i-ii
            ...buildRegExpExecInstrs(ctx, fctx, deps, rxLocal, sLocal, builtinArm),
            { op: "local.set", index: resLocal },
            { op: "local.get", index: resLocal },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            // step 6.f.iii.1-2
            ...buildGetInstrs(ctx, deps, resLocal, "0"),
            { op: "call", funcIdx: deps.externToString },
            { op: "local.set", index: mLocal },
            { op: "local.get", index: aLocal },
            { op: "local.get", index: mLocal },
            { op: "call", funcIdx: deps.objVecPush },
            { op: "local.get", index: nLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: nLocal },
            // step 6.f.iii.3 — the empty-match advance.
            { op: "local.get", index: mLocal },
            ...flattenExternStringInstrs(loop),
            { op: "struct.get", typeIdx: loop.nativeStr, fieldIdx: 0 },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: emptyMatchArm, else: [] },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // step 6.f.ii's answer, decided by the counter.
    { op: "local.get", index: nLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "ref.null.extern" }],
      else: [{ op: "local.get", index: aLocal }],
    },
  ];
  return body;
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
 * The GLOBAL arm (#6651 B3) is now step 6 in full — see
 * {@link buildMatchGlobalArm}. B2 shipped it as a PARTIAL arm (the
 * `Set(rx, "lastIndex", +0)` and the first `RegExpExec`, then `null`), which was
 * honest about its effects but could not answer a global match that matches.
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
  const deps0 = prepareRegExpExecProtocol(ctx, fctx);
  if (deps0 === undefined) return null;
  // EVERY decline has to happen here, before the first `fctx.body.push`. A
  // body that bails half-emitted leaves the operand stack unbalanced and the
  // whole module fails to validate — which is a far worse failure than the
  // "keep the previous answer" the caller's decline path is written to give.
  // `__str_indexOf` and the step-6 loop's readers are the dependencies that are
  // not part of `deps`.
  if (!flagsContainAvailable(ctx)) return null;
  // (#6651 B3) The loop deps REGISTER `__to_primitive` (ToLength's ToNumber),
  // and a late import shifts every defined-function index at or above it — so
  // this runs BEFORE the first `fctx.body.push` and `deps` is re-resolved
  // immediately after it. Registering it here rather than next to the loop also
  // keeps the whole decline set in one place. (Measured, not theorised: with the
  // registration left where the loop reads it, `deps` pointed one import short
  // and the collect loop's `__objvec_push` was calling a different function —
  // the array came back empty and the loop ran once.)
  const loop0 = prepareMatchLoopDeps(ctx, fctx);
  if (loop0 === undefined) return null;
  const deps = prepareRegExpExecProtocol(ctx, fctx) ?? deps0;

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
  // The loop's own indices are re-read here for the same reason `post` is: the
  // builtin arms may have registered an import. Every registration inside is
  // idempotent, so this adds nothing to the module.
  const loop = prepareMatchLoopDeps(ctx, fctx) ?? loop0;

  const hasG = buildFlagsContainInstrs(ctx, flagsLocal, "g");

  const globalArm: Instr[] = buildMatchGlobalArm(
    ctx,
    fctx,
    post,
    loop,
    thisParam,
    sLocal,
    flagsLocal,
    zeroLocal,
    builtinArmGlobal,
  );
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
