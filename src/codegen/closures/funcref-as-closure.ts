// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Funcref-as-closure wrapping for js2wasm.
 *
 * Extracted verbatim from `closures.ts` (issue #3270). Wraps a capture-carrying
 * nested function DECLARATION as a memoized closure struct + per-function
 * trampoline (`emitFuncRefAsClosure`), with its private memoized-instance
 * emitter (`emitMemoizedNestedFnClosure`). Depends on the extracted
 * funcref-wrapper-types registry.
 */

import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import { ts } from "../../ts-api.js";
import { captureSourceSlot, pushBoxedTdzFlagRef } from "./capture-source-slot.js";
import type { FieldDef, Instr, ValType } from "../../ir/types.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import { popBody, pushBody } from "../context/bodies.js";
import { getOrRegisterRefCellType } from "../index.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { observeProgramAbiFunctionValue } from "../program-abi-source-callable-planning.js";
import { noJsHost } from "../js-errors.js";
import { emitCachedFuncClosureAccess } from "./method-trampolines.js";
// (#4437) per-declaration `name` / §15.1.5 `length` carrier
import { ensureFnMetaSubtype, fnMetaSlot, registerFnMetaFamily } from "../function-instance-meta.js";
import { fnMetaSlotForMemberName } from "../function-instance-meta-methods.js"; // (#4440) static methods
import {
  CLOSURE_CAPTURE_FIELD_BASE,
  closureArityField,
  closureBagField,
  closureBagInitInstr,
  getFuncSignature,
  getOrCreateConstructibleFuncRefWrapperTypes,
  getOrCreateFuncRefWrapperTypes,
} from "./funcref-wrapper-types.js";

/**
 * (#2976) Emit the memoized, `ref.is_null`-guarded VALUE instance of a
 * capture-carrying nested function declaration:
 *
 *   local.get $memo
 *   ref.is_null
 *   if (empty)                       ;; first DYNAMIC reference only
 *     ref.func $tramp
 *     <capture pushes>               ;; unchanged from the per-site build
 *     struct.new $__fn_cap_<name>
 *     local.set $memo
 *   end
 *   local.get $memo
 *   ref.as_non_null
 *
 * The memo local is allocated once per enclosing activation
 * (`fctx.nestedFnClosureMemos`), so every reference yields the SAME struct
 * instance — `f === f` holds and sidecar/static writes (`f.resolve = fn`)
 * are visible through later references. The runtime guard (not a prologue
 * hoist, not compile-order memoization) is load-bearing twice over:
 *   - it preserves value-capture semantics — immutable captures copy their
 *     value at the first DYNAMIC reference, exactly where the old per-site
 *     build copied them (a prologue hoist would run before hoisted-over
 *     initializers);
 *   - it is control-flow-safe — with compile-order memoization, a reference
 *     in a runtime-skipped branch would leave a later branch reading an
 *     uninitialized local.
 * The capture-push block keeps its compile-time side effects (mutable-capture
 * boxing + localMap rebind, TDZ flag boxing) — they now occur while compiling
 * the guard arm, same net effect as before.
 */
function emitMemoizedNestedFnClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  structTypeIdx: number,
  trampolineFuncIdx: number,
  nestedCaptures: NonNullable<ReturnType<CodegenContext["nestedFuncCaptures"]["get"]>>,
  tdzFlaggedNested: NonNullable<ReturnType<CodegenContext["nestedFuncCaptures"]["get"]>>,
  constructible: boolean,
  arity: number,
  /**
   * (#4437) The `$fnmeta` operand, when this closure's struct carries the slot.
   * Pushed LAST — the field is appended after `__constructible`, so the
   * `struct.new` operand order has to match or the emitter rejects it.
   */
  metaInit?: Instr[],
): void {
  const numCaptures = nestedCaptures.length;
  const numTdzFlags = tdzFlaggedNested.length;

  let memoLocal = fctx.nestedFnClosureMemos?.get(funcName);
  if (memoLocal === undefined) {
    memoLocal = allocLocal(fctx, `__fnmemo_${funcName}_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: structTypeIdx,
    });
    (fctx.nestedFnClosureMemos ??= new Map()).set(funcName, memoLocal);
  }

  fctx.body.push({ op: "local.get", index: memoLocal });
  fctx.body.push({ op: "ref.is_null" });

  // Build the construction sequence into the guard's then-arm.
  const savedBody = pushBody(fctx);

  // struct.new fields: func, (#3673) $arity, (#4241) $bag, cap0, cap1, ..., __tdz_*...
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  fctx.body.push({ op: "i32.const", value: arity });
  fctx.body.push(closureBagInitInstr());
  // (#1312) Self-reference inside the lifted body of `funcName` itself —
  // e.g. `function next() { return call(next); }`. The captures are
  // already in scope as the leading params [0..numCaptures-1] of the
  // lifted fn (mutable captures arrive as boxed ref cells, immutable as
  // raw values). We re-push them by param index instead of trying to
  // dereference `cap.outerLocalIdx`, which points into a different
  // (outer) scope and yields garbage / null when reused inside the
  // current lifted body.
  const isSelfRef = fctx.name === funcName;
  for (let i = 0; i < nestedCaptures.length; i++) {
    const cap = nestedCaptures[i]!;
    if (isSelfRef) {
      // Captures arrive at param index `i` in the lifted fn (#1312).
      fctx.body.push({ op: "local.get", index: i });
      continue;
    }
    // An identity-observed FunctionDeclaration has one stable lexical value,
    // materialized at its first dynamic use. A sibling closure that captures
    // that binding is itself such a use: reading the preallocated externref
    // local directly would otherwise snapshot its initial null value. Keep the
    // lazy timing (important when the function captures later initializers),
    // but fill the binding immediately before this closure copies it.
    materializeHoistedFunctionValueBinding(ctx, fctx, cap.name);
    // (#2029 family A) Cross-fctx capture sourcing. `cap.outerLocalIdx` is a
    // slot in the function that DECLARED the nested fn; when this
    // materialization runs inside a DIFFERENT function (an object-literal
    // accessor body — the enclosing fn's locals are unreachable), baking it
    // emit-crashes ("local index out of range") or silently reads the wrong
    // local. `promoteAccessorCapturesToGlobals` promotes such captures to
    // module globals (shared ref-cell box for mutable, value global for
    // immutable); prefer those whenever the current fctx cannot resolve the
    // name itself. Guarded on localMap-absence so owner-fctx behavior is
    // unchanged (see the #1177 revert note in calls.ts for why a blanket
    // localMap-first lookup is NOT safe).
    const liveBoxLocalIdx = fctx.localMap.get(cap.name);
    const capUnresolvedHere = liveBoxLocalIdx === undefined;
    const liveBox = fctx.boxedCaptures?.get(cap.name);
    const liveBoxType = liveBoxLocalIdx === undefined ? undefined : getLocalType(fctx, liveBoxLocalIdx);
    const recordedSlotType = getLocalType(fctx, cap.outerLocalIdx);
    const recordedSlotHasLiveBoxType =
      liveBox !== undefined &&
      (recordedSlotType?.kind === "ref" || recordedSlotType?.kind === "ref_null") &&
      recordedSlotType.typeIdx === liveBox.refCellTypeIdx;
    // A source function expression can be emitted into more than one Wasm
    // frame (for example, once as a stored closure and again through a direct
    // call). Nested-function metadata is source-name keyed, so an immutable
    // capture can retain the first frame's slot while the second frame has
    // re-boxed the same binding at a different slot. Select the live cell only
    // when the capture's expected type, boxed-capture registry, and current
    // local all identify the same ref-cell type, and the recorded slot no
    // longer has that representation. This is intentionally narrower than
    // #1177's reverted blanket localMap-first lookup.
    const useLiveImmutableBox =
      !cap.mutable &&
      liveBoxLocalIdx !== undefined &&
      liveBox !== undefined &&
      cap.valType !== undefined &&
      (cap.valType.kind === "ref" || cap.valType.kind === "ref_null") &&
      cap.valType.typeIdx === liveBox.refCellTypeIdx &&
      (liveBoxType?.kind === "ref" || liveBoxType?.kind === "ref_null") &&
      liveBoxType.typeIdx === liveBox.refCellTypeIdx &&
      !recordedSlotHasLiveBoxType;
    const useLiveImmutableBoxValue =
      !cap.mutable &&
      liveBoxLocalIdx !== undefined &&
      liveBox !== undefined &&
      liveBoxType !== undefined &&
      (liveBoxType.kind === "ref" || liveBoxType.kind === "ref_null") &&
      liveBoxType.typeIdx === liveBox.refCellTypeIdx &&
      cap.valType !== undefined &&
      cap.valType.kind !== "ref" &&
      cap.valType.kind !== "ref_null";
    if (cap.mutable && cap.valType) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
      const boxGlobal = capUnresolvedHere ? ctx.capturedBoxGlobals?.get(cap.name) : undefined;
      if (fctx.boxedCaptures?.has(cap.name)) {
        const currentLocalIdx = fctx.localMap.get(cap.name)!;
        fctx.body.push({ op: "local.get", index: currentLocalIdx });
      } else if (boxGlobal !== undefined) {
        // Shared ref-cell box promoted to a module global — live
        // write-through semantics with the declaring function.
        fctx.body.push({ op: "global.get", index: boxGlobal.globalIdx });
        fctx.body.push({ op: "ref.as_non_null" });
      } else if (capUnresolvedHere && ctx.capturedGlobals.has(cap.name)) {
        // Value global (the capture is also directly referenced by the
        // accessor body) — box a copy. Best-effort: writes through the
        // closure do not propagate back, but the previous behavior was an
        // out-of-scope local read (emit crash / wrong local).
        fctx.body.push({ op: "global.get", index: ctx.capturedGlobals.get(cap.name)! });
        if (ctx.capturedGlobalsWidened.has(cap.name)) {
          fctx.body.push({ op: "ref.as_non_null" });
        }
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
      } else {
        // Stage 1 localMap-first lookup reverted — see calls.ts comment.
        fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.valType });
      }
    } else if (useLiveImmutableBoxValue) {
      fctx.body.push({ op: "local.get", index: liveBoxLocalIdx! });
      fctx.body.push({ op: "struct.get", typeIdx: liveBox!.refCellTypeIdx, fieldIdx: 0 });
    } else if (useLiveImmutableBox) {
      fctx.body.push({ op: "local.get", index: liveBoxLocalIdx });
    } else if (capUnresolvedHere && ctx.capturedGlobals.has(cap.name)) {
      // (#2029 family A) Immutable capture promoted to a value global by
      // the accessor-capture pass — read it instead of the out-of-scope
      // declaring-function local slot.
      fctx.body.push({ op: "global.get", index: ctx.capturedGlobals.get(cap.name)! });
      if (ctx.capturedGlobalsWidened.has(cap.name)) {
        fctx.body.push({ op: "ref.as_non_null" });
      }
    } else {
      const capSourceIdx = captureSourceSlot(fctx, cap);
      const sourceType = getLocalType(fctx, capSourceIdx);
      // The enclosing frame may expose an immutable capture through the
      // canonical ref-cell created for a sibling/earlier nested function. The
      // closure ABI for this capture remains its raw value type, so store the
      // cell's value in the new closure rather than the cell object itself.
      // Without this unwrap a later `new CapturedConstructor()` receives a
      // Wasm struct and the host constructor bridge reports "not a
      // constructor".
      const sourceIsCanonicalBox =
        !cap.mutable &&
        liveBox !== undefined &&
        sourceType !== undefined &&
        (sourceType.kind === "ref" || sourceType.kind === "ref_null") &&
        sourceType.typeIdx === liveBox.refCellTypeIdx &&
        cap.valType !== undefined &&
        cap.valType.kind !== "ref" &&
        cap.valType.kind !== "ref_null";
      fctx.body.push({ op: "local.get", index: capSourceIdx });
      if (sourceIsCanonicalBox) {
        fctx.body.push({ op: "struct.get", typeIdx: liveBox!.refCellTypeIdx, fieldIdx: 0 });
      }
    }
  }
  // #1205 Stage 3: after all value captures, push the boxed TDZ flag refs
  // (one per TDZ-flagged capture). Sourcing rules mirror calls.ts — see
  // the FNDECL-A4 cap-prepend block there for the full rationale. The
  // short version: only trust the LIVE `fctx.tdzFlagLocals[name]` lookup
  // when it points to an i32 in the current fctx. Otherwise (block-shadow
  // or cross-fctx transitive) push `i32.const 1` (treat as initialized) —
  // matches pre-#1205 behavior where the lifted body had no flag check.
  if (numTdzFlags > 0) {
    const i32RefCellTypeIdxForFlags = getOrRegisterRefCellType(ctx, { kind: "i32" });
    for (let ti = 0; ti < tdzFlaggedNested.length; ti++) {
      const cap = tdzFlaggedNested[ti]!;
      if (isSelfRef) {
        // (#1312) Self-reference inside the lifted body — the TDZ-flag
        // boxed refs arrive as params at index `numCaptures + ti` (after
        // all value captures). Re-push from there.
        fctx.body.push({ op: "local.get", index: numCaptures + ti });
        continue;
      }
      const existingBox = fctx.boxedTdzFlags?.get(cap.name);
      if (existingBox) {
        // (#4394) Null-guarded reuse — the teeing site may not dominate this one.
        pushBoxedTdzFlagRef(fctx, existingBox);
      } else {
        const liveFlagIdx = fctx.tdzFlagLocals?.get(cap.name);
        const liveType = liveFlagIdx !== undefined ? getLocalType(fctx, liveFlagIdx) : undefined;
        const liveOk = liveType?.kind === "i32";
        if (liveOk && liveFlagIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: liveFlagIdx });
          fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdxForFlags });
        } else {
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdxForFlags });
        }
        const flagBoxLocal = allocLocal(fctx, `__tdz_box_${cap.name}`, {
          kind: "ref",
          typeIdx: i32RefCellTypeIdxForFlags,
        });
        fctx.body.push({ op: "local.tee", index: flagBoxLocal });
        if (liveOk) {
          if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
          fctx.boxedTdzFlags.set(cap.name, {
            refCellTypeIdx: i32RefCellTypeIdxForFlags,
            localIdx: flagBoxLocal,
            // (#4394) Raw i32 source for non-dominated reuse re-init.
            srcFlagIdx: liveFlagIdx,
          });
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          fctx.tdzFlagLocals.set(cap.name, flagBoxLocal);
        }
      }
    }
  }
  if (constructible) fctx.body.push({ op: "i32.const", value: 1 });
  if (metaInit) for (const instr of metaInit) fctx.body.push(instr);
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: memoLocal });

  const thenArm = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenArm, else: [] });
  fctx.body.push({ op: "local.get", index: memoLocal });
  fctx.body.push({ op: "ref.as_non_null" });
}

/**
 * Emit a closure struct wrapping a plain function. Creates a per-function
 * trampoline that delegates to the original function.  Struct types are shared
 * across functions with the same signature so they can be reassigned.
 * Pushes the closure struct ref onto the stack and returns its type.
 */
export function emitFuncRefAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  funcIdx: number,
  constructible = false,
): ValType | null {
  const sig = getFuncSignature(ctx, funcIdx);
  if (!sig) return null;

  // (#4437) The declaration behind `funcName`, for the `$fnmeta` slot. Resolved
  // ONCE here (both paths below need it) but materialized lazily — `fnMetaSlot`
  // mints an interned string global, and a path that ends up not carrying the
  // slot should not leave one behind.
  const metaDecl = ctx.funcMapOwnerDecl.get(funcName) ?? ctx.topLevelFunctionDeclarations.get(funcName);
  // Constructibility belongs to the source function, not to whichever value
  // read happened to materialize its cached capture struct first. A self-read
  // can mint an ordinary function's artifact with `__constructible`, followed
  // by another lowering path that historically passed the default `false`.
  // Since artifacts are keyed by function identity, that disagreement omitted
  // one operand from the later `struct.new`. Normalize ordinary declarations
  // here so every materialization uses one stable layout.
  constructible =
    constructible ||
    ((noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first") &&
      metaDecl !== undefined &&
      ts.isFunctionDeclaration(metaDecl) &&
      metaDecl.asteriskToken === undefined &&
      !(metaDecl.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false));
  // (#4440) A STATIC class method reaches this helper (not the cached-singleton
  // one — `property-access-dispatch.ts` reads `C.m` through `emitFuncRefAsClosure`),
  // and its `funcName` is the physical `ClassName_m`, which neither map above
  // holds. The member side table does; consulting it second keeps a real
  // function declaration's own metadata winning wherever both could answer.
  const metaSlotOf = (): ReturnType<typeof fnMetaSlot> =>
    fnMetaSlot(ctx, metaDecl) ?? fnMetaSlotForMemberName(ctx, funcName);

  const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
  if (nestedCaptures && nestedCaptures.length > 0) {
    // Functions with captures: create a closure struct that stores the capture values.
    // The trampoline extracts captures from the struct and passes them to the original function. (#857)
    //
    // (#2976) IDENTITY: the struct type + trampoline are minted ONCE per
    // funcName (module-level `nestedFnClosureArtifacts` dedupe below), and the
    // INSTANCE is memoized per enclosing activation in a `ref.is_null`-guarded
    // local (`fctx.nestedFnClosureMemos`). Previously every reference site
    // built a fresh struct type + trampoline + instance, so
    // `Constructor === Constructor` was false and a static/sidecar write
    // (`Constructor.resolve = fn`) landed on a dead instance the next
    // reference never saw (the #2671 Promise capability sub-bucket). The
    // lazy guard — rather than a prologue hoist — preserves the existing
    // value-capture semantics exactly: immutable captures copy their value at
    // the FIRST DYNAMIC reference, the same point the old per-site build
    // copied them; mutable captures were already live through ref cells.
    const numCaptures = nestedCaptures.length;
    // #1205 Stage 3: TDZ-flag captures get extra ref-cell fields after the
    // value captures, mirroring the leading-param layout of the lifted fn.
    const tdzFlaggedNested = nestedCaptures.filter((c) => c.hasTdzFlag);
    const numTdzFlags = tdzFlaggedNested.length;
    // The lifted fn's signature is [valueCaps..., tdzFlagBoxes..., userParams...].
    const userParams = sig.params.slice(numCaptures + numTdzFlags);
    const results = sig.results;

    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
    if (!wrapperTypes) return null;

    const cachedArtifacts = ctx.nestedFnClosureArtifacts?.get(funcName);
    if (cachedArtifacts) {
      const trampIdx = ctx.funcMap.get(cachedArtifacts.trampolineName);
      if (trampIdx !== undefined) {
        emitMemoizedNestedFnClosure(
          ctx,
          fctx,
          funcName,
          cachedArtifacts.structTypeIdx,
          trampIdx,
          nestedCaptures,
          tdzFlaggedNested,
          constructible,
          userParams.length,
          // Re-derived rather than cached alongside the struct type: the
          // metadata is a pure function of `metaDecl`, and the global it reads
          // is interned by key, so this yields the same instrs the mint site
          // emitted. A cached Instr[] would be ALIASED into two bodies, which
          // double-remaps on a late-import shift.
          metaSlotOf()?.init,
        );
        return { kind: "ref", typeIdx: cachedArtifacts.structTypeIdx };
      }
    }

    // Create a custom struct with func + capture fields + TDZ-flag fields
    // (subtype of the base wrapper).
    const captureFields: FieldDef[] = nestedCaptures.map((_cap, i) => {
      const capParamType = sig.params[i]!;
      return { name: `cap${i}`, type: capParamType, mutable: false };
    });
    // #1205 Stage 3: append TDZ-flag ref-cell fields after the value captures
    // so the trampoline's struct.get of the flag uses the correct field index.
    let i32RefCellTypeIdxForFlags = -1;
    if (numTdzFlags > 0) {
      i32RefCellTypeIdxForFlags = getOrRegisterRefCellType(ctx, { kind: "i32" });
      for (const cap of tdzFlaggedNested) {
        captureFields.push({
          name: `__tdz_${cap.name}`,
          type: { kind: "ref" as const, typeIdx: i32RefCellTypeIdxForFlags },
          mutable: false,
        });
      }
    }
    if (constructible) {
      captureFields.push({ name: "__constructible", type: { kind: "i32" }, mutable: false });
    }
    // (#4437) This struct is ALREADY per-function, so the `$fnmeta` slot is
    // appended in place — no extra subtype. Last, after `__constructible`.
    const metaSlot = metaSlotOf();
    if (metaSlot) captureFields.push(metaSlot.field);
    const closureName = `__fn_cap_${funcName}_${ctx.closureCounter++}`;
    const structTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name: `${closureName}_struct`,
      fields: [
        { name: "func", type: { kind: "funcref" as const }, mutable: false },
        closureArityField(),
        closureBagField(),
        ...captureFields,
      ],
      superTypeIdx: wrapperTypes.structTypeIdx,
    });
    if (constructible) ctx.constructibleClosureTypeIdxs.add(structTypeIdx);
    if (metaSlot) {
      registerFnMetaFamily(ctx, structTypeIdx, CLOSURE_CAPTURE_FIELD_BASE + captureFields.length - 1);
    }

    // Use the base wrapper's func type so call_ref works via subtype cast
    const liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;

    const trampolineName = `__fn_tramp_${funcName}_${ctx.closureCounter++}`;
    const trampolineBody: Instr[] = [];
    const trampolineLocals: { name: string; type: ValType }[] = [];

    // We always need the casted-self local when we have either >1 value captures
    // OR any TDZ-flag fields, because each requires a separate `struct.get`.
    const totalCapFields = numCaptures + numTdzFlags;
    if (totalCapFields > 1) {
      trampolineLocals.push({ name: "__casted_self", type: { kind: "ref", typeIdx: structTypeIdx } });
    }
    const castedSelfLocal = 1 + userParams.length;

    // Cast self from base struct to custom struct to access capture fields
    trampolineBody.push({ op: "local.get", index: 0 });
    trampolineBody.push({ op: "ref.cast", typeIdx: structTypeIdx });

    if (totalCapFields === 1) {
      // Exactly one capture field (a value capture; TDZ-flag-only with zero
      // value captures is impossible because each flag is paired with a value).
      trampolineBody.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: CLOSURE_CAPTURE_FIELD_BASE });
    } else {
      trampolineBody.push({ op: "local.set", index: castedSelfLocal });
      // Push value captures first, then TDZ-flag captures, mirroring the
      // lifted fn's leading-param order.
      for (let i = 0; i < totalCapFields; i++) {
        trampolineBody.push({ op: "local.get", index: castedSelfLocal });
        trampolineBody.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + CLOSURE_CAPTURE_FIELD_BASE });
      }
    }
    for (let i = 0; i < userParams.length; i++) {
      trampolineBody.push({ op: "local.get", index: i + 1 });
    }
    trampolineBody.push({ op: "call", funcIdx });

    const trampolineFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, trampolineFuncIdx, {
      name: trampolineName,
      typeIdx: liftedFuncTypeIdx,
      locals: trampolineLocals,
      body: trampolineBody,
      exported: false,
    });
    observeProgramAbiFunctionValue(ctx, funcIdx, trampolineFuncIdx);
    ctx.funcMap.set(trampolineName, trampolineFuncIdx);

    // Register closureInfo so array method callbacks can use call_ref.
    // (#4394) Carry `hasRestParam` from the source declaration: the generic
    // call-of-expression paths (call-tail-dispatch.ts) consult it to pack
    // trailing args into the rest vec — without it a dynamic call of a
    // rest-param nested fn coerced arg0 straight to the vec param (guarded
    // cast → null) and the callee trapped reading `rest.length`.
    const ownerDecl = ctx.funcMapOwnerDecl.get(funcName);
    const ownerHasRest =
      ownerDecl !== undefined &&
      ts.isFunctionLike(ownerDecl) &&
      ownerDecl.parameters.some((p) => p.dotDotDotToken !== undefined);
    const closureInfo: ClosureInfo = {
      structTypeIdx,
      funcTypeIdx: wrapperTypes.closureInfo.funcTypeIdx,
      returnType: results.length > 0 ? results[0]! : null,
      paramTypes: userParams,
      ...(ownerHasRest ? { hasRestParam: true } : {}),
    };
    ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);

    // (#2976) Register the module-level artifacts so every later reference —
    // in this or any other fctx — reuses this ONE struct type + trampoline
    // instead of minting fresh ones per site. Stored by trampoline NAME
    // (re-resolved via funcMap at emission) so late-import shifts can't
    // desync a cached raw index.
    (ctx.nestedFnClosureArtifacts ??= new Map()).set(funcName, { structTypeIdx, trampolineName });

    emitMemoizedNestedFnClosure(
      ctx,
      fctx,
      funcName,
      structTypeIdx,
      trampolineFuncIdx,
      nestedCaptures,
      tdzFlaggedNested,
      constructible,
      userParams.length,
      metaSlot?.init,
    );
    return { kind: "ref", typeIdx: structTypeIdx };
  }

  const userParams = sig.params;

  const wrapperTypes = constructible
    ? getOrCreateConstructibleFuncRefWrapperTypes(ctx, userParams, sig.results)
    : getOrCreateFuncRefWrapperTypes(ctx, userParams, sig.results);
  if (!wrapperTypes) return null;

  const { structTypeIdx, liftedFuncTypeIdx, closureInfo } = wrapperTypes;

  // Create a trampoline function for THIS specific function.
  // The trampoline takes (self, ...userParams) and calls the original function.
  const trampolineName = `__fn_tramp_${funcName}_${ctx.closureCounter++}`;
  const trampolineBody: Instr[] = [];

  // Push the user-visible params (skip self at param 0)
  for (let i = 0; i < userParams.length; i++) {
    trampolineBody.push({ op: "local.get", index: i + 1 });
  }
  trampolineBody.push({ op: "call", funcIdx });

  const trampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, trampolineFuncIdx, {
    name: trampolineName,
    typeIdx: liftedFuncTypeIdx,
    locals: [],
    body: trampolineBody,
    exported: false,
  });
  ctx.funcMap.set(trampolineName, trampolineFuncIdx);

  // (#4437) `structTypeIdx` here is the SHARED per-signature wrapper, so the
  // metadata slot needs a per-base subtype. Falling back to the bare wrapper
  // when the subtype cannot be minted keeps this path's previous behaviour
  // (reflective `length` from `$arity`, no `name`) rather than failing.
  const metaSlot = metaSlotOf();
  const metaTypeIdx = metaSlot ? ensureFnMetaSubtype(ctx, structTypeIdx) : undefined;
  const allocTypeIdx = metaTypeIdx ?? structTypeIdx;

  // Emit: ref.func $trampoline, (#3673) $arity, (#4241) $bag, struct.new $closure_struct
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  fctx.body.push({ op: "i32.const", value: userParams.length });
  fctx.body.push(closureBagInitInstr());
  if (constructible) fctx.body.push({ op: "i32.const", value: 1 });
  if (metaTypeIdx !== undefined && metaSlot) for (const instr of metaSlot.init) fctx.body.push(instr);
  fctx.body.push({ op: "struct.new", typeIdx: allocTypeIdx });

  return { kind: "ref", typeIdx: allocTypeIdx };
}

/**
 * Materialize the stable lexical value of a hoisted FunctionDeclaration at
 * its first dynamic value use. Returns true when the binding is already ready
 * or was filled by this call.
 */
export function materializeHoistedFunctionValueBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): boolean {
  if (
    !fctx.hoistedFunctionValueBindings?.has(name) ||
    fctx.liftedCaptureNames?.has(name) ||
    fctx.materializedHoistedFunctionValueBindings?.has(name) ||
    fctx.materializingHoistedFunctionValueBindings?.has(name)
  ) {
    return (
      fctx.materializedHoistedFunctionValueBindings?.has(name) ||
      fctx.materializingHoistedFunctionValueBindings?.has(name) ||
      false
    );
  }

  const localIdx = fctx.localMap.get(name);
  const funcIdx = ctx.funcMap.get(name);
  if (localIdx === undefined || funcIdx === undefined) return false;
  const boxed = fctx.boxedCaptures?.get(name);

  (fctx.materializingHoistedFunctionValueBindings ??= new Set()).add(name);

  // Capture-free declarations share the canonical lazy module singleton used
  // by ordinary identifier reads. Besides preserving JavaScript identity, the
  // singleton publishes the exact source-owned trampoline + cache pair to the
  // Program ABI. Capture-carrying declarations remain activation-local and
  // continue through the memoized per-frame closure path below.
  // Preserve the declaration's constructor capability on this eager binding
  // path too. Ordinary identifier reads make the same distinction; omitting
  // it here would make a hoisted `function f() {}` callable but report false
  // from IsConstructor once the stable lexical value had been materialized.
  const declaration = ctx.funcMapOwnerDecl.get(name) ?? ctx.topLevelFunctionDeclarations.get(name);
  const constructible =
    (noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first") &&
    declaration !== undefined &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.asteriskToken === undefined &&
    !(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
  const nestedCaptures = ctx.nestedFuncCaptures.get(name);
  const valueType =
    !nestedCaptures || nestedCaptures.length === 0
      ? emitCachedFuncClosureAccess(ctx, fctx, name, funcIdx, constructible)
      : emitFuncRefAsClosure(ctx, fctx, name, funcIdx, constructible);
  if (!valueType) {
    fctx.materializingHoistedFunctionValueBindings.delete(name);
    return false;
  }
  if (valueType.kind !== "externref" && valueType.kind !== "ref_extern") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (boxed?.valType.kind === "externref") {
    const valueLocalIdx = allocLocal(fctx, `__fnvalue_${name}_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: valueLocalIdx });
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "local.get", index: valueLocalIdx });
    fctx.body.push({ op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
  } else {
    fctx.body.push({ op: "local.set", index: localIdx });
  }
  fctx.materializingHoistedFunctionValueBindings.delete(name);
  (fctx.materializedHoistedFunctionValueBindings ??= new Set()).add(name);
  return true;
}
