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
import { compileExpression, VOID_RESULT } from "../shared.js";
import { pushDefaultValue } from "../type-coercion.js";
import { resolveWasmType } from "../index.js";
import { getFuncParamTypes, getWasmFuncReturnType, isEffectivelyVoidReturn, wasmFuncReturnsVoid } from "./helpers.js";

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
  const sig = ctx.checker.getResolvedSignature(expr);
  let resultType: ValType | typeof VOID_RESULT = VOID_RESULT;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const fullName0 = `${firstCand.className}_${propAccess.name.text}`;
    if (!isEffectivelyVoidReturn(ctx, retType, fullName0)) {
      const wasmRet = getWasmFuncReturnType(ctx, firstCand.funcIdx);
      resultType = wasmRet ?? resolveWasmType(ctx, retType);
    }
  }
  if (resultType !== VOID_RESULT && wasmFuncReturnsVoid(ctx, firstCand.funcIdx)) {
    resultType = VOID_RESULT;
  }

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

  // Build the call body for one candidate. We need to ref.cast the
  // receiver to the candidate's struct type before calling, so the
  // function-type signature matches.
  function callBody(cand: { className: string; funcIdx: number; classTag: number }): Instr[] {
    const candParams = candParamTypes.get(cand.funcIdx);
    if (!candParams || candParams.length === 0) return [];
    const selfType = candParams[0]!;
    if (selfType.kind !== "ref" && selfType.kind !== "ref_null") return [];
    const selfTypeIdx = (selfType as { typeIdx: number }).typeIdx;
    const body: Instr[] = [];
    body.push({ op: "local.get", index: recvLocal });
    // ref.cast_null preserves nullability if the receiver might be null;
    // ref.cast (non-null) traps on null. Use ref.cast_null since the
    // receiver could be null at the static type level.
    body.push({ op: "ref.cast_null", typeIdx: selfTypeIdx });
    // (#4644) Exactly `candParams.length - 1` operands, no more and no fewer:
    // reuse the shared temps for the arguments this arm declares, pad the rest
    // with this arm's own default values, and drop temps the arm cannot
    // receive (a narrower override — the extra operand would be a stack leak
    // just as surely as a missing one is a shortfall).
    const candArgCount = candParams.length - 1;
    for (let i = 0; i < candArgCount; i++) {
      const shared = argLocals[i];
      if (shared !== undefined) {
        body.push({ op: "local.get", index: shared.idx });
        continue;
      }
      const padIdx = padLocals.get(padKey(candParams[i + 1]!));
      if (padIdx === undefined) return [];
      body.push({ op: "local.get", index: padIdx });
    }
    const finalIdx = ctx.funcMap.get(`${cand.className}_${propAccess.name.text}`) ?? cand.funcIdx;
    body.push({ op: "call", funcIdx: finalIdx });
    return body;
  }

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
    const branch: Instr[] = [
      { op: "local.get", index: recvLocal },
      { op: "struct.get", typeIdx: tagStructIdx, fieldIdx: 0 },
      { op: "i32.const", value: cand.classTag },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: freshBlockType(),
        then: callBody(cand),
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
