// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1299) Tag-based virtual method dispatch.
 *
 * Extracted from `calls.ts` (a god file under the #3102 LOC budget) so this
 * emitter can carry the explanation its two 2026-08-23 stack-discipline fixes
 * need. Behaviour is unchanged by the move; `calls.ts` re-exports the entry
 * point so existing call sites are untouched.
 */
import { ts } from "../../ts-api.js";

import type { Instr, ValType } from "../../ir/types.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "../context/speculative.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { InnerResult } from "../shared.js";
import { compileExpression, ensureLateImport, flushLateImportShifts, VOID_RESULT } from "../shared.js";
import { pushDefaultValue } from "../type-coercion.js";
import { resolveWasmType } from "../index.js";
import { getFuncParamTypes, getWasmFuncReturnType, isEffectivelyVoidReturn, wasmFuncReturnsVoid } from "./helpers.js";

/**
 * (#5178) How an arm's own result type reaches a cascade widened to `externref`.
 *
 * `extern.convert_any` is the whole conversion for anything on the internal
 * (`any`) side of the GC type hierarchy — a struct ref, `eqref`, `anyref`.
 * Values that are already external need nothing. Everything else (`funcref`,
 * `i32`/`f64`/`v128`, …) is NOT an `anyref` subtype, so no widening exists that
 * does not box, and the caller must bail to the static path instead.
 */
function armWideningKind(t: ValType): "convert" | "none" | "unrepresentable" {
  switch (t.kind) {
    case "ref":
    case "ref_null":
    case "eqref":
    case "anyref":
      return "convert";
    case "externref":
    case "ref_extern":
      return "none";
    default:
      return "unrepresentable";
  }
}

/**
 * (#5352) An `f64` arm can still reach an `externref` cascade — by BOXING.
 *
 * `armWideningKind` above answers "is there a free representation change", and
 * for a number there is not: `f64` is not an `anyref` subtype. But the compiler
 * already has a universal boxed-number representation (`__box_number`, the same
 * one `coerceType` uses for every other f64→externref edge), so "no free
 * widening" is not the same as "no widening". Treating the two as identical is
 * what made a mixed numeric/ref cascade decline — and a decline is not neutral:
 * the caller then static-binds the whole dispatch to `candidates[0]`.
 *
 * Deliberately `f64` ONLY. `i32` is also this compiler's BOOLEAN
 * representation, and nothing in an arm's Wasm result type distinguishes
 * `boolean` from a native-`i32` number, so `__box_number` would box half the
 * i32 arms as the wrong JS type. An i32 arm therefore still declines.
 */
function armIsBoxableNumber(t: ValType): boolean {
  return t.kind === "f64";
}

/**
 * (#5352) Register the boxing helper BEFORE the emitter captures any function
 * index — the ordering is the whole reason this is a separate pre-pass.
 *
 * `ensureLateImport` can add an import, and adding one shifts every DEFINED
 * function index up by the number added. `emitVirtualMethodDispatchByTag`
 * snapshots `candFinalIdx` into a plain `Map<number, number>` that no shift
 * pass can reach, so a boxing helper registered after that capture would leave
 * every arm calling one function too low. Running it here — before the
 * speculative snapshot, before the receiver is compiled, before any index is
 * read — means the shift lands while nothing is holding a stale index, and the
 * arms read `ctx.funcMap.get("__box_number")` fresh at build time (funcMap IS
 * shifted, so that read is always current).
 *
 * Only registers when the cascade would actually need it: at least one boxable
 * numeric arm AND at least one arm already on the `any`/external side. An
 * all-numeric cascade agrees on `f64` and must keep it; registering the helper
 * for it would add a host import nothing calls.
 *
 * @returns true when `__box_number` is available for the arms to call
 */
function ensureCascadeNumericBoxing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  candidates: readonly { className: string; funcIdx: number }[],
  methodName: string,
): boolean {
  let hasBoxable = false;
  let hasRefSide = false;
  for (const cand of candidates) {
    const ret = getWasmFuncReturnType(ctx, ctx.funcMap.get(`${cand.className}_${methodName}`) ?? cand.funcIdx);
    // A void arm is a different (unrepresentable) divergence; boxing cannot
    // help it, so do not pay for the helper.
    if (ret === undefined) return false;
    if (armIsBoxableNumber(ret)) {
      hasBoxable = true;
      continue;
    }
    if (armWideningKind(ret) === "unrepresentable") return false;
    hasRefSide = true;
  }
  if (!hasBoxable || !hasRefSide) return false;
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  return boxIdx !== undefined;
}

/**
 * (#5178) Pick one block type for a tag cascade whose arms may not agree.
 *
 * Overrides do NOT have to share a Wasm RESULT type — the exact mirror of the
 * arity divergence #4644 fixed one signature field over. The cascade used to be
 * typed from the FIRST candidate alone while each arm calls its own body, so a
 * subclass whose method returns a differently-shaped object literal pushed the
 * wrong struct into a block declared for another one. Measured on
 * `@js-temporal/polyfill`: `estimateIsoDate` has SEVEN implementations across
 * the `HelperBase` hierarchy returning FIVE distinct structs, which V8 rejects
 * as `type error in fallthru[0] (expected (ref null 109), got (ref null 142))`
 * — on a module `compile()` reports clean.
 *
 * Unification, in the only two directions that are sound here:
 *   * all arms already agree             → keep that type (the common case);
 *   * all arms return GC/`any`-side refs → widen to `externref` and
 *     `extern.convert_any` each arm's value. That is the compiler's own
 *     universal object representation, and the consumer of a heterogeneous
 *     dispatch coerces to it anyway.
 *
 * Anything else — mixed void/value, mixed numeric-and-ref, `funcref` — has no
 * representation every arm can produce without boxing, and boxing would have to
 * emit a `call` INSIDE an arm array, exactly the late-import index-shift hazard
 * the padding comment in the caller rules out. Those return `undefined`, i.e.
 * "decline, use the static path", which replaces an invalid module rather than
 * a working one.
 *
 * (#5352) `canBoxNumbers` relaxes the "mixed numeric-and-ref" refusal above:
 * with `__box_number` already registered (see `ensureCascadeNumericBoxing`) an
 * `f64` arm CAN produce the widened `externref`, so that mix unifies instead of
 * declining into a static bind.
 *
 * @param proposed the caller's first-candidate/TS-signature guess
 * @param candRets each arm's own Wasm result, `undefined` for a void arm
 * @param canBoxNumbers whether `__box_number` is available to the arms
 * @returns the unified block type, or `undefined` to decline
 */
function unifyCascadeResultType(
  proposed: ValType | typeof VOID_RESULT,
  candRets: readonly (ValType | undefined)[],
  canBoxNumbers: boolean,
): { resultType: ValType | typeof VOID_RESULT; widenArms: boolean } | undefined {
  const voidArms = candRets.filter((r) => r === undefined).length;
  // An `empty` block obliges every arm to leave the stack untouched; one
  // value-returning arm among void ones (or the reverse) is unvalidatable.
  if (proposed === VOID_RESULT) {
    return voidArms === candRets.length ? { resultType: VOID_RESULT, widenArms: false } : undefined;
  }
  if (voidArms !== 0) return undefined;
  const rets = candRets as readonly ValType[];
  const matchesProposed = (t: ValType): boolean =>
    t.kind === proposed.kind && (t as { typeIdx?: number }).typeIdx === (proposed as { typeIdx?: number }).typeIdx;
  if (rets.every(matchesProposed)) return { resultType: proposed, widenArms: false };
  const reachesExternref = (t: ValType): boolean =>
    armWideningKind(t) !== "unrepresentable" || (canBoxNumbers && armIsBoxableNumber(t));
  if (!rets.every(reachesExternref)) return undefined;
  return { resultType: { kind: "externref" }, widenArms: true };
}

/** Everything one cascade arm needs from the enclosing emission. */
interface DispatchArmEnv {
  readonly recvLocal: number;
  readonly candParamTypes: ReadonlyMap<number, ValType[]>;
  readonly candFinalIdx: ReadonlyMap<number, number>;
  readonly argLocals: readonly { idx: number; type: ValType }[];
  readonly padLocals: ReadonlyMap<string, number>;
  readonly padKey: (t: ValType) => string;
  readonly widenArmsToExternref: boolean;
}

/**
 * Build the call body for one candidate: `ref.cast` the receiver to this
 * candidate's struct type (so the function-type signature matches), push
 * exactly its declared operands, call it, and bring its result up to the
 * cascade's block type.
 *
 * Returns `[]` when the arm cannot be built — the caller must treat that as a
 * decline, NOT as an empty arm (#5178): an empty `then` under a block type that
 * declares a value leaves the cascade one operand short.
 */
function buildDispatchArmCall(
  ctx: CodegenContext,
  cand: { className: string; funcIdx: number; classTag: number },
  env: DispatchArmEnv,
): Instr[] {
  const candParams = env.candParamTypes.get(cand.funcIdx);
  if (!candParams || candParams.length === 0) return [];
  const selfType = candParams[0]!;
  if (selfType.kind !== "ref" && selfType.kind !== "ref_null") return [];
  const body: Instr[] = [{ op: "local.get", index: env.recvLocal }];
  // ref.cast_null preserves nullability if the receiver might be null;
  // ref.cast (non-null) traps on null. Use ref.cast_null since the receiver
  // could be null at the static type level.
  body.push({ op: "ref.cast_null", typeIdx: (selfType as { typeIdx: number }).typeIdx });
  // (#4644) Exactly `candParams.length - 1` operands, no more and no fewer:
  // reuse the shared temps for the arguments this arm declares, pad the rest
  // with this arm's own default values, and drop temps the arm cannot receive
  // (a narrower override — the extra operand would be a stack leak just as
  // surely as a missing one is a shortfall).
  for (let i = 0; i < candParams.length - 1; i++) {
    const shared = env.argLocals[i];
    if (shared !== undefined) {
      body.push({ op: "local.get", index: shared.idx });
      continue;
    }
    const padIdx = env.padLocals.get(env.padKey(candParams[i + 1]!));
    if (padIdx === undefined) return [];
    body.push({ op: "local.get", index: padIdx });
  }
  const finalIdx = env.candFinalIdx.get(cand.funcIdx) ?? cand.funcIdx;
  body.push({ op: "call", funcIdx: finalIdx });
  // (#5178) Bring this arm's own result up to a widened cascade's block type.
  // `extern.convert_any` is a pure representation change with no import behind
  // it, so it is safe to emit inside an arm array.
  //
  // (#5352) A boxing `call` is safe here TOO, but only because the helper was
  // already registered by `ensureCascadeNumericBoxing` before this emission
  // began. What the #5178 comment ruled out was *minting* an import while
  // building an arm array — that shifts indices the fixup pass cannot reach,
  // because the arm array is not in `fctx.body` yet. Calling an
  // already-registered function does not mint anything, and the index is read
  // from `funcMap` (which every shift pass updates) at the moment of use.
  if (env.widenArmsToExternref) {
    const ret = getWasmFuncReturnType(ctx, finalIdx);
    if (ret === undefined) return [];
    if (armWideningKind(ret) === "convert") body.push({ op: "extern.convert_any" });
    else if (armIsBoxableNumber(ret)) {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx === undefined) return [];
      body.push({ op: "call", funcIdx: boxIdx });
    }
  }
  return body;
}

/**
 * (#1299) Emit a tag-based virtual method dispatch for a base-typed
 * receiver where multiple subclasses provide overriding implementations.
 * Mirrors the `instanceof` codegen: load the receiver's `__tag` field
 * (i32, set in each subclass's constructor) and compare against each
 * candidate's known `classTag` value, calling the matching subclass's
 * method body. Receiver and arguments are evaluated once and saved to
 * temp locals so each branch can reference them.
 *
 * Returns the call's IR result type, or undefined if dispatch could not
 * be emitted (caller falls back to the existing static path).
 */
export function emitVirtualMethodDispatchByTag(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  candidates: { className: string; funcIdx: number; classTag: number }[],
  baseClassName: string,
): InnerResult | undefined {
  // Resolve the base struct typeIdx for `struct.get __tag` (field 0).
  const baseStructIdx = ctx.structMap.get(baseClassName);
  if (baseStructIdx === undefined) return undefined;

  // Validate first candidate's signature (used as the schema for arg
  // type hints and return-type lookup; all overrides share the same
  // user-visible signature).
  const firstCand = candidates[0]!;
  const firstParamTypes = getFuncParamTypes(ctx, firstCand.funcIdx);
  if (!firstParamTypes || firstParamTypes.length === 0) return undefined;

  // (#5352) Register the numeric boxing helper HERE, before the snapshot and
  // before any function index is captured — see `ensureCascadeNumericBoxing`
  // for why the ordering is load-bearing. Nothing has been emitted yet, so an
  // index shift at this point is harmless.
  const canBoxNumbers = ensureCascadeNumericBoxing(ctx, fctx, candidates, propAccess.name.text);

  // EVERY bail-out from here on must be transactional. This function emits
  // into `fctx.body` as it probes, and returning `undefined` tells the caller
  // "I emitted nothing, use the static path" — so an un-rewound partial
  // emission is left stranded on the operand stack while the fallback compiles
  // the same receiver and arguments again.
  //
  // That is not hypothetical: it is why lit's implementation module failed to
  // validate (`type error in fallthru[0] (expected i32, got externref)`).
  // `class extends HTMLElement` makes the receiver EXTERNREF, so the
  // ref/ref_null check below rejects it — after the receiver push had already
  // landed. The static path then re-pushed the receiver, the call consumed
  // only its own two operands, and one externref survived to the end of the
  // enclosing `&&` arm, whose block type was i32. Every lit test file inherits
  // that invalid module, which is what drives the halving-retry cascade in the
  // upstream-suite runner.
  const snap = snapshotSpeculative(ctx, fctx);

  // Compile the receiver expression — produces a ref-typed value.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }

  const recvLocalType: ValType = { kind: "ref_null", typeIdx: (recvType as { typeIdx: number }).typeIdx };
  const recvLocal = allocTempLocal(fctx, recvLocalType);
  fctx.body.push({ op: "local.set", index: recvLocal });

  // (#4644) Overrides do NOT have to share an arity. `class A { m(a,b,c=1){} }`
  // and `class B extends A { m(a,b,c=1,d=false){} }` are both legal JS and both
  // land in `candidates`, with 4 and 5 Wasm params respectively (self + user
  // params). The old code sized the shared argument temps from
  // `firstParamTypes` alone and then pushed that same fixed list into EVERY
  // arm, so an arm whose callee declared one more parameter got `need 5, got 4`
  // — a module that `compile()` reports as clean and `WebAssembly.compile()`
  // rejects. Measured on @js-temporal/polyfill: `adjustCalendarDate` is
  // declared with 3 params on `GregorianBaseHelper` and 4 on
  // `ChineseBaseHelper`.
  //
  // Fix in two halves:
  //   * evaluate each SOURCE argument once, into a shared temp, capped by the
  //     WIDEST candidate (not the first) so a wider arm's argument is not
  //     dropped on the floor; and
  //   * pad/truncate PER ARM inside `callBody`, from that arm's own signature.
  //     Padding is `undefined`/zero, so materializing it per arm is observably
  //     identical to hoisting it — and it is the only way one temp list can
  //     serve arms of different arity.
  const candParamTypes = new Map<number, ValType[]>();
  // (#5178) The index we will ACTUALLY `call`, resolved once. Both the
  // parameter list and the RESULT type have to be read off this index — see
  // the return-type unification below.
  const candFinalIdx = new Map<number, number>();
  let widestParamTypes = firstParamTypes;
  for (const cand of candidates) {
    const finalIdx = ctx.funcMap.get(`${cand.className}_${propAccess.name.text}`) ?? cand.funcIdx;
    // Read the signature off the index we will ACTUALLY call. `funcMap` can
    // resolve to a different (e.g. per-subclass synthesized) body than
    // `cand.funcIdx`, and a signature read from the wrong one is exactly the
    // arity mismatch this fix exists to prevent.
    const params = getFuncParamTypes(ctx, finalIdx);
    if (!params || params.length === 0) {
      rollbackSpeculative(ctx, fctx, snap);
      return undefined;
    }
    candParamTypes.set(cand.funcIdx, params);
    candFinalIdx.set(cand.funcIdx, finalIdx);
    if (params.length > widestParamTypes.length) widestParamTypes = params;
  }

  // Evaluate args and save each to a temp local. Padding to each callee's
  // declared arity happens per-arm in `callBody`.
  const argLocals: { idx: number; type: ValType }[] = [];
  const userParamCount = widestParamTypes.length - 1; // exclude self
  const argCount = Math.min(expr.arguments.length, userParamCount);
  for (let i = 0; i < argCount; i++) {
    const expectedArgType = widestParamTypes[i + 1];
    const aType = compileExpression(ctx, fctx, expr.arguments[i]!, expectedArgType);
    if (!aType) {
      rollbackSpeculative(ctx, fctx, snap);
      return undefined;
    }
    const local = allocTempLocal(fctx, aType);
    fctx.body.push({ op: "local.set", index: local });
    argLocals.push({ idx: local, type: aType });
  }

  // (#4644) Padding values, one temp per DISTINCT padded param type, all
  // materialized here in `fctx.body` — never inside an arm. `pushDefaultValue`
  // can emit a `call` (the `undefined` externref helper), and a late import
  // added while building the arm arrays would shift function indices that the
  // fixup pass cannot reach, because those arrays are not in `fctx.body` yet.
  const padKey = (t: ValType): string => JSON.stringify(t);
  const padLocals = new Map<string, number>();
  const padTypes: ValType[] = [];
  for (const cand of candidates) {
    const params = candParamTypes.get(cand.funcIdx)!;
    for (let i = argLocals.length; i < params.length - 1; i++) {
      const t = params[i + 1]!;
      if (!padLocals.has(padKey(t))) {
        padLocals.set(padKey(t), -1);
        padTypes.push(t);
      }
    }
  }
  for (const t of padTypes) {
    pushDefaultValue(fctx, t, ctx);
    const local = allocTempLocal(fctx, t);
    fctx.body.push({ op: "local.set", index: local });
    padLocals.set(padKey(t), local);
  }

  // Determine return type from the first candidate's signature.
  const firstFinalIdx = candFinalIdx.get(firstCand.funcIdx)!;
  const sig = ctx.checker.getResolvedSignature(expr);
  let resultType: ValType | typeof VOID_RESULT = VOID_RESULT;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const fullName0 = `${firstCand.className}_${propAccess.name.text}`;
    if (!isEffectivelyVoidReturn(ctx, retType, fullName0)) {
      const wasmRet = getWasmFuncReturnType(ctx, firstFinalIdx);
      resultType = wasmRet ?? resolveWasmType(ctx, retType);
    }
  }
  if (resultType !== VOID_RESULT && wasmFuncReturnsVoid(ctx, firstFinalIdx)) {
    resultType = VOID_RESULT;
  }

  // (#5178) The cascade's block type has to describe EVERY arm, not the first.
  const unified = unifyCascadeResultType(
    resultType,
    candidates.map((cand) => getWasmFuncReturnType(ctx, candFinalIdx.get(cand.funcIdx)!)),
    canBoxNumbers,
  );
  if (unified === undefined) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  resultType = unified.resultType;
  const widenArmsToExternref = unified.widenArms;

  const resultIsRef = resultType !== VOID_RESULT && (resultType.kind === "ref" || resultType.kind === "ref_null");

  // (#2564) Each nested `if` in the tag cascade below MUST get its own
  // `blockType` object — never a single shared one. `dead-elimination`'s
  // `remapTypeIdxInBody` remaps a `ref`/`ref_null` block-type via `remapVT`,
  // and its double-remap guard (`seen` WeakSet, #1302) keys on the *instruction*
  // object, not on the `blockType.type` sub-object. The cascade builds one
  // distinct `if` instruction per candidate; if they all alias the SAME
  // `blockType.type` ValType, the second nested `if`'s visit chain-remaps the
  // already-remapped index a second time (observed: 20→16 on the first `if`,
  // then 16→13 on the second — the compaction map shifts each survivor down, so
  // 13 is the fn-wrapper type), while the callee func's result type — remapped
  // exactly once in the type table — lands on 16. The mismatch surfaces as
  // `type error in fallthru[0] (expected (ref null 13), got (ref null 16))`.
  // A fresh `{ ...resultType }` per `if` keeps each block-type remapped once.
  const freshBlockType = (): { kind: "val"; type: ValType } | { kind: "empty" } =>
    resultType === VOID_RESULT
      ? { kind: "empty" }
      : { kind: "val", type: resultIsRef ? { ...(resultType as ValType) } : (resultType as ValType) };

  const callBody = (cand: { className: string; funcIdx: number; classTag: number }): Instr[] =>
    buildDispatchArmCall(ctx, cand, {
      recvLocal,
      candParamTypes,
      candFinalIdx,
      argLocals,
      padLocals,
      padKey,
      widenArmsToExternref,
    });

  // Load `__tag` through the RECEIVER's own struct type, not the base's.
  //
  // These class structs are NOT declared in a Wasm subtype relation with each
  // other (`$__anonClass_0` is emitted as a bare `(sub (struct …))`, not
  // `(sub $y …)`), so `struct.get $base` over a local typed `(ref null
  // $__anonClass_0)` is a validation error, not a widening. It fires whenever
  // this method is compiled as a synthesised per-subclass COPY: the copy's
  // `this` is the copy's struct while `baseClassName` still names the original,
  // which is how lit's `y_get_updateComplete` failed with `struct.get[0]
  // expected type (ref null 54), found local.tee of type (ref null 44)`.
  //
  // Field 0 is `__tag` in every class struct this path can see — the same
  // assumption the base-typed read already made — so reading it through the
  // receiver's own type is well-typed and loads the identical field. Only do
  // that for a type we can confirm IS a class struct; anything else bails out,
  // now safely, because the snapshot above rewinds what we emitted.
  const recvTypeIdx = (recvType as { typeIdx: number }).typeIdx;
  let tagStructIdx = baseStructIdx;
  if (recvTypeIdx !== baseStructIdx) {
    let recvIsClassStruct = false;
    for (const idx of ctx.structMap.values()) {
      if (idx === recvTypeIdx) {
        recvIsClassStruct = true;
        break;
      }
    }
    if (!recvIsClassStruct) {
      rollbackSpeculative(ctx, fctx, snap);
      return undefined;
    }
    tagStructIdx = recvTypeIdx;
  }

  // (#4644) VERIFY the assumption the paragraph above states — do not just
  // assert it. "Field 0 is `__tag` in every class struct this path can see" is
  // false for an OBJECT-LITERAL struct: `__anon_0`'s field 0 is its first
  // property (an `externref`), so the cascade emitted `struct.get` → `i32.eq`
  // and the module was rejected with `i32.eq[0] expected type i32, found
  // struct.get of type externref`. Reached whenever an object literal's method
  // calls `this.m(…)` and `m` is defined only on unrelated classes. There is no
  // tag to compare in such a struct, so bail to the static path — the snapshot
  // rewinds everything emitted so far.
  // The test is deliberately "field 0 is present AND is not i32", not "field 0
  // is i32". Class struct field lists are filled progressively, so an ABSENT
  // field 0 means "not known yet", not "no tag" — an abstract base whose
  // members have not been emitted has an empty field list at this point, and
  // refusing on that alone silently demoted #1299's dict dispatch back to the
  // first candidate (`dict["a"].id() * 1000 + dict["b"].id()` answered 1001
  // instead of 1002). Only a field 0 that EXISTS and is the wrong type proves
  // there is no tag to read.
  const tagStructDef = ctx.mod.types[tagStructIdx];
  const emittedField0 = tagStructDef?.kind === "struct" ? tagStructDef.fields[0] : undefined;
  const tagStructName = ctx.typeIdxToStructName.get(tagStructIdx);
  const trackedField0 = tagStructName === undefined ? undefined : ctx.structFields.get(tagStructName)?.[0];
  if (
    (emittedField0 !== undefined && emittedField0.type.kind !== "i32") ||
    (trackedField0 !== undefined && trackedField0.type.kind !== "i32")
  ) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }

  // Build the cascade: load __tag, compare to each candidate's classTag.
  // Outermost: candidates[0]; deepest else: unreachable.
  let elseInstrs: Instr[] = [{ op: "unreachable" }];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const cand = candidates[i]!;
    // (#5178) An arm that could not be built is EMPTY, not absent: dropping it
    // into a `then` whose block type declares a value leaves the cascade one
    // operand short. Bail transactionally instead of emitting that.
    const hit = callBody(cand);
    if (hit.length === 0) {
      rollbackSpeculative(ctx, fctx, snap);
      return undefined;
    }
    const branch: Instr[] = [
      { op: "local.get", index: recvLocal },
      { op: "struct.get", typeIdx: tagStructIdx, fieldIdx: 0 },
      { op: "i32.const", value: cand.classTag },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: freshBlockType(),
        then: hit,
        else: elseInstrs,
      },
    ];
    elseInstrs = branch;
  }
  for (const instr of elseInstrs) fctx.body.push(instr);

  for (const a of argLocals) releaseTempLocal(fctx, a.idx);
  for (const idx of padLocals.values()) if (idx >= 0) releaseTempLocal(fctx, idx);
  releaseTempLocal(fctx, recvLocal);

  return resultType;
}
