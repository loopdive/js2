// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Method-ABI → closure-ABI trampoline machinery for js2wasm.
 *
 * Extracted verbatim from `closures.ts` (issue #3270) — the largest single
 * cohesive removable subsystem: object-literal / cached method closures, the
 * pending-trampoline finalize pass, and the shared null-`this` TypeError + `this`
 * -slot prologue helpers. Depends on the extracted funcref-wrapper-types registry.
 */

import { ts } from "../../ts-api.js";
import type { Instr, LocalDef, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { inLiveShiftRange } from "../../emit/resolve-layout.js";
import { addStringConstantGlobal, localGlobalIdx } from "../registry/imports.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { noJsHost } from "../expressions/helpers.js";
import { emitWasiErrorConstructor } from "../registry/error-types.js";
import { allocTempLocal } from "../context/locals.js";
import { ensureExnTag } from "../index.js";
import { coercionInstrs } from "../type-coercion.js";
import { ensureCurrentThisGlobal } from "../statements/nested-declarations.js";
import {
  ensureLateImport as ensureLateImportShared,
  flushLateImportShifts as flushLateImportShiftsShared,
} from "../shared.js";
import {
  closureBagInitInstr,
  getFuncSignature,
  getOrCreateConstructibleFuncRefWrapperTypes,
  getOrCreateFuncRefWrapperTypes,
} from "./funcref-wrapper-types.js";
import { emitFuncRefAsClosure } from "./funcref-as-closure.js";
import { observeProgramAbiFunctionValue } from "../program-abi-source-callable-planning.js";
// (#4437) per-declaration `name` / §15.1.5 `length` carrier
import { ensureFnMetaSubtype, fnMetaSlot } from "../function-instance-meta.js";
// (#4440) the METHOD half of the same carrier — class/object-literal members
import { fnMetaSlotForMemberDecl, fnMetaSlotForMemberName } from "../function-instance-meta-methods.js";

/**
 * (#2015) Build the `this`-slot prologue for an object-method trampoline.
 *
 * Object-literal / cached method trampolines bridge the closure-value ABI
 * `(closure_self, …userParams)` to the method ABI `(this_struct, …userParams)`.
 * Historically they hardcoded `ref.null <objStruct>` for the method's `this`
 * slot, implementing the unbound-`this` method-extraction case (`var f = o.m;
 * f()` → `this === undefined`). But the SAME trampoline is reached when the
 * closure is dispatched as a METHOD via `__call_fn_method_N`, which installs
 * the receiver into the `__current_this` module global before the inner
 * `call_ref` (#1636-S1). In that case the hardcoded null made `this.<field>`
 * trap (the issue's bare `WebAssembly.Exception`).
 *
 * Read `__current_this` instead and use it as `this` when it `ref.test`s as the
 * method's object struct; otherwise fall back to `ref.null` (preserving the
 * unbound-extraction semantics, since plain `__call_fn_N` dispatch leaves the
 * global null). This mirrors the null-guarded `__current_this` read that lifted
 * closure bodies already use for `ThisKeyword` (`expressions.ts`, #1702).
 *
 * `anyTempLocalIdx` must reference a spare `anyref` local appended to the
 * trampoline. Emits a sequence leaving exactly one `(ref null objStructTypeIdx)`
 * on the stack.
 */
/**
 * (#2025) Message thrown when an extracted method (`const f = a.m; f()`) is
 * called with no receiver — `this` is `undefined`. Matches the spirit of
 * Node's "Cannot read properties of undefined".
 */
const NULL_THIS_TYPEERROR_MSG = "Cannot read properties of undefined (reading a class field)";

/**
 * (#2025) Eagerly register the `__new_TypeError` import + the message string
 * the first time an extractable method-as-closure trampoline is built, so the
 * trampoline's null-`this` arm can emit a CATCHABLE TypeError throw with
 * stable, shift-tracked indices (no late-import registration during the
 * fragile finalize rebuild). Idempotent. Requires a live `fctx` so the flush
 * lands the deferred index shift onto the surrounding function being compiled.
 */
export function ensureNullThisTypeError(ctx: CodegenContext, fctx: FunctionContext | null): void {
  if (ctx.nullThisTypeErrorReady) return;
  // In no-JS-host mode, define `__new_TypeError` in-module (no env import).
  if (noJsHost(ctx)) {
    emitWasiErrorConstructor(ctx, "TypeError", 1);
  }
  addStringConstantGlobal(ctx, NULL_THIS_TYPEERROR_MSG);
  ensureLateImportShared(ctx, "__new_TypeError", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShiftsShared(ctx, fctx);
  ensureExnTag(ctx);
  ctx.nullThisTypeErrorReady = true;
}

/**
 * (#2025) The catchable-TypeError throw sequence for a genuinely-absent
 * receiver, or `null` when the helpers were not eagerly registered (in which
 * case the trampoline falls back to the legacy `ref.null` passthrough rather
 * than risk an unregistered call). Pure lookups — no registration, so it is
 * safe to call from the finalize rebuild (post-body, pre-freeze).
 */
function buildNullThisTypeErrorThrow(ctx: CodegenContext): Instr[] | null {
  if (!ctx.nullThisTypeErrorReady) return null;
  const newTypeErrorIdx = ctx.funcMap.get("__new_TypeError");
  if (newTypeErrorIdx === undefined || ctx.exnTagIdx < 0) return null;
  return [
    ...stringConstantExternrefInstrs(ctx, NULL_THIS_TYPEERROR_MSG),
    { op: "call", funcIdx: newTypeErrorIdx },
    { op: "throw", tagIdx: ctx.exnTagIdx },
  ];
}

/**
 * (#2025) Does the method's compiled body read its receiver (`this` = param 0)?
 * A method that never touches `this` is safely callable with a null receiver
 * (no struct.get on null), so the trampoline must NOT throw for it. We detect a
 * `local.get 0` anywhere in the body (including nested blocks). Conservative:
 * if the body isn't available yet (idx out of range), assume it does use `this`
 * so we don't silently regress the trap→TypeError fix.
 */
function methodBodyReadsThis(ctx: CodegenContext, methodFuncIdx: number): boolean {
  const fn = definedFuncAt(ctx, methodFuncIdx);
  if (!fn || !Array.isArray(fn.body)) return true;
  const walk = (instrs: Instr[]): boolean => {
    for (const instr of instrs) {
      if (instr.op === "local.get" && (instr as { index?: number }).index === 0) return true;
      for (const key of ["body", "then", "else", "catchAll"] as const) {
        const nested = (instr as Record<string, unknown>)[key];
        if (Array.isArray(nested) && walk(nested)) return true;
      }
      const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
      if (Array.isArray(catches)) {
        for (const c of catches) if (Array.isArray(c.body) && walk(c.body)) return true;
      }
    }
    return false;
  };
  return walk(fn.body);
}

function buildTrampolineThisSlot(
  ctx: CodegenContext,
  objStructTypeIdx: number,
  anyTempLocalIdx: number,
  methodUsesThis: boolean,
): Instr[] {
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  const nullThis: Instr[] = [{ op: "ref.null", typeIdx: objStructTypeIdx }];
  if (currentThisGlobalIdx < 0) return nullThis;
  // (#2025) When the resolved `this` isn't the method's struct, distinguish a
  // GENUINELY-ABSENT receiver (`__current_this` null — the unbound extraction
  // `const f = a.m; f()`) from a merely structurally-different receiver (e.g. a
  // subclass/boxed instance, where `__current_this` is non-null but doesn't
  // `ref.test` as THIS exact struct). The first case is a spec TypeError; throw
  // a CATCHABLE one instead of passing `ref.null` (which traps inside the
  // method body on the first `this`-deref). The second case is left UNCHANGED
  // (`ref.null` passthrough) — throwing there is what regressed PR #1571 (it
  // fired for legitimate non-exact-struct receivers). Also only when the method
  // actually READS `this` — a method that ignores its receiver (`m(){return 7}`)
  // is callable with a null `this` (no deref, no trap), matching JS. Finally,
  // only when the throw helpers were eagerly registered; else legacy passthrough.
  const throwInstrs = methodUsesThis ? buildNullThisTypeErrorThrow(ctx) : null;
  const elseArm: Instr[] = throwInstrs
    ? [
        { op: "local.get", index: anyTempLocalIdx },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: objStructTypeIdx } },
          then: throwInstrs, // genuinely no receiver → catchable TypeError
          else: nullThis, // different struct → unchanged passthrough
        },
      ]
    : nullThis;
  return [
    { op: "global.get", index: currentThisGlobalIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyTempLocalIdx },
    { op: "ref.test", typeIdx: objStructTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: objStructTypeIdx } },
      then: [
        { op: "local.get", index: anyTempLocalIdx },
        { op: "ref.cast", typeIdx: objStructTypeIdx },
      ],
      else: elseArm,
    },
  ];
}

/**
 * Reconcile the receiver produced by {@link buildTrampolineThisSlot} with the
 * actual first parameter of the method.  The trampoline's receiver is always
 * the nullable object-struct reference used by the closure ABI, but late type
 * resolution can leave a method's hidden `this` parameter on a DIFFERENT
 * reference carrier (`externref`/`anyref`).  Passing the struct reference
 * directly in that case makes the generated `call` fail Wasm validation.  Keep
 * this at the ABI boundary instead of weakening validation or relying on stack
 * fixups.
 *
 * (#4469) The reconciliation is deliberately limited to a CROSS-CARRIER
 * mismatch.  `ref`/`ref_null` are the same carrier family and differ only in
 * nullability, and {@link buildTrampolineThisSlot} emits a null receiver ON
 * PURPOSE: the #2025 passthrough hands `ref.null` to the method whenever the
 * resolved `this` is non-null but does not `ref.test` as this exact struct
 * (a foreign receiver, e.g. `this.#m.call({})`).  Bridging `ref_null $S` to
 * `ref $S` there means `ref.as_non_null`, which turns that designed
 * passthrough into an UNCATCHABLE `null_deref` trap at the ABI boundary —
 * before the method body (which may never touch `this` at all, as in
 * `#m() { return super.method(); }`) gets to run.  Nullability is therefore
 * settled by the callee's own signature, never by a cast here.
 */
function coerceTrampolineThisSlot(
  ctx: CodegenContext,
  body: Instr[],
  objStructTypeIdx: number,
  methodThisType: ValType | undefined,
  methodUsesThis: boolean,
  fctx?: FunctionContext,
): void {
  if (!methodThisType) return;
  // A method which never reads `this` is valid when extracted and called with
  // an absent receiver.  Keeping the nullable value also avoids narrowing a
  // provisional signature before the method body pass settles its ABI.
  if (!methodUsesThis) return;
  // Reconcile ONLY an `externref` carrier — the late-type-resolution case this
  // helper exists for. Every *reference* target is deliberately left alone.
  //
  // The nullable spelling produced by `buildTrampolineThisSlot` is LOAD-BEARING,
  // not an approximation. For a receiver that is non-null but does not `ref.test`
  // as this struct (`obj.m.call(otherShape)` — #2025's deliberate passthrough)
  // the slot holds `ref.null <struct>`. Coercing that toward a NON-nullable
  // target emits a null-eliminating cast, which traps at the ABI boundary
  // ("dereferencing a null pointer") instead of letting the callee observe an
  // absent receiver.
  //
  // The previous `source.kind === methodThisType.kind` guard did not catch this:
  // the common case is `ref_null <S>` → `ref <S>` — the SAME struct, differing
  // only in nullability — and `"ref_null" !== "ref"`, so the guard fell through
  // and emitted the cast. That trap is what broke private-method extraction
  // (`this.#m.call(o)`), turning two test262 failures into hard traps.
  if (methodThisType.kind !== "externref") return;
  const source: ValType = { kind: "ref_null", typeIdx: objStructTypeIdx };
  if (isStructRefCarrier(source) && isStructRefCarrier(methodThisType)) {
    // Same carrier family.  Same struct ⇒ already compatible up to
    // nullability, which must stay nullable (see the #4469 note above).  A
    // distinct type index is handled by the existing method-arg reconciliation
    // path; the receiver path should not add an unsafe cast for an unrelated
    // object shape.
    return;
  }
  body.push(...coercionInstrs(ctx, source, methodThisType, fctx));
}

/** `ref` and `ref_null` are one carrier family — they differ only in nullability. */
function isStructRefCarrier(type: ValType): boolean {
  return type.kind === "ref" || type.kind === "ref_null";
}

/**
 * #1118: Emit an object-literal method as a first-class closure value.
 *
 * Object-literal methods are compiled as Wasm functions with signature
 * `(self_obj, ...userParams) → ret`. When the method is read as a value
 * (e.g. `var f = obj.m;` or stored in the obj's own struct field), we
 * need a closure-struct ref whose funcref takes `(closure_self, …userParams)`.
 *
 * The two signatures differ in their first param: the method expects the
 * object's struct ref, the closure value passes its own closure struct.
 * We bridge them with a trampoline that drops `closure_self` and pushes
 * `ref.null <objStruct>` for the method's `self_obj` slot, then forwards
 * the user params and tail-calls the method.
 *
 * The trampoline implements method extraction with unbound `this` — JS
 * spec says `var f = obj.m; f();` invokes `m` with `this = undefined`
 * (strict mode) or `this = globalThis` (sloppy). For methods that don't
 * reference `this` (the common test262 yield-star pattern), the null
 * `self_obj` is fine; methods that DO use `this` will trap inside the
 * body, mirroring spec semantics.
 *
 * Returns the closure-struct ref ValType (which the caller can convert
 * to externref via `extern.convert_any` if the field type expects it).
 */
export function emitObjectMethodAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  methodFuncIdx: number,
  objStructTypeIdx: number,
  /**
   * (#4440) The object-literal member this closure is the value of, when the
   * caller has it. Unlike the class path there is no side table to consult —
   * `literals.ts` holds the node right at the call — so it is passed directly.
   */
  memberDecl?: ts.Node,
): ValType | null {
  const sig = getFuncSignature(ctx, methodFuncIdx);
  if (!sig) return null;
  // Method signature: [(ref null objStruct), ...userParams] → results.
  // Strip the leading self_obj to derive the closure value's user-visible
  // signature.
  if (sig.params.length === 0) return null;
  const userParams = sig.params.slice(1);
  const results = sig.results;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
  if (!wrapperTypes) return null;
  const { structTypeIdx, liftedFuncTypeIdx } = wrapperTypes;
  // Object-literal methods share the signature wrapper with ordinary
  // functions. A rest method with a simple identifier rest parameter needs an
  // allocation-specific discriminator so `__call_fn_method_N` can materialize
  // its trailing argument vector. Binding-pattern rest parameters use a
  // different destructuring ABI and must retain the shared wrapper; otherwise
  // the dispatcher loses the pattern's hidden externref carrier.
  const methodHasSimpleRest =
    memberDecl !== undefined &&
    ts.isFunctionLike(memberDecl) &&
    memberDecl.parameters.some(
      (parameter) => parameter.dotDotDotToken !== undefined && ts.isIdentifier(parameter.name),
    );
  let allocationStructTypeIdx = structTypeIdx;
  if (methodHasSimpleRest) {
    const base = ctx.mod.types[structTypeIdx];
    if (base?.kind === "struct") {
      allocationStructTypeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: `${base.name}_rest_${ctx.closureCounter++}`,
        fields: base.fields.map((field) => ({ ...field })),
        superTypeIdx: structTypeIdx,
      });
      ctx.closureInfoByTypeIdx.set(allocationStructTypeIdx, {
        ...wrapperTypes.closureInfo,
        structTypeIdx: allocationStructTypeIdx,
        hasRestParam: true,
      });
    }
  }

  // Create the trampoline. Signature matches the wrapper's lifted func
  // type: (closure_self, ...userParams) → ret. We ignore closure_self,
  // resolve the method's self_obj from `__current_this` (#2015 — falls back
  // to `ref.null` for the unbound method-extraction case), then forward the
  // user params.
  const trampolineName = `__obj_meth_tramp_${methodName}_${ctx.closureCounter++}`;
  // anyref temp at the first slot past the params (closure_self + userParams).
  const anyTempLocalIdx = 1 + userParams.length;
  // (#2025) Decide whether the method reads `this` BEFORE registering the
  // TypeError helpers — `ensureNullThisTypeError` adds a late import that shifts
  // defined-function indices, which would make `methodFuncIdx` stale for the
  // body lookup. Then register the helpers (with a live fctx so the import-index
  // flush lands here) so the null-`this` arm throws instead of trapping and
  // finalize never registers an import mid-rebuild.
  // (#2025) Capture this-usage, then register the TypeError throw helpers. The
  // registration may add a late import that shifts every DEFINED function index
  // up by `ntShift`; the forwarding `call methodFuncIdx` we emit just below is in
  // a body not yet attached to `ctx.mod.functions`, so the import-shift walker
  // can't reach it — bump the captured index by the delta ourselves (import
  // targets, < the pre-shift import count, are never shifted).
  const methodUsesThis = methodBodyReadsThis(ctx, methodFuncIdx);
  const importsBeforeNT = ctx.numImportFuncs;
  ensureNullThisTypeError(ctx, fctx);
  const ntShift = ctx.numImportFuncs - importsBeforeNT;
  if (ntShift > 0 && inLiveShiftRange(methodFuncIdx, importsBeforeNT)) methodFuncIdx += ntShift;
  const trampolineBody: Instr[] = buildTrampolineThisSlot(ctx, objStructTypeIdx, anyTempLocalIdx, methodUsesThis);
  coerceTrampolineThisSlot(ctx, trampolineBody, objStructTypeIdx, sig.params[0], methodUsesThis, fctx);
  for (let i = 0; i < userParams.length; i++) {
    // Skip closure_self at param 0; user params start at index 1
    trampolineBody.push({ op: "local.get", index: i + 1 });
  }
  trampolineBody.push({ op: "call", funcIdx: methodFuncIdx });

  const trampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, trampolineFuncIdx, {
    name: trampolineName,
    typeIdx: liftedFuncTypeIdx,
    locals: [{ name: "__this_any", type: { kind: "anyref" } }],
    body: trampolineBody,
    exported: false,
  });
  ctx.funcMap.set(trampolineName, trampolineFuncIdx);

  // (#1602) The method's `func.typeIdx` may be re-resolved after this point
  // (generator/default-param methods finalize their param types/order during
  // body compilation). The forwarding body built above snapshots the CURRENT
  // signature; record it so a post-pass can rebuild it against the method's
  // final signature once all function bodies are compiled.
  ctx.pendingMethodTrampolines.push({
    trampolineBody,
    trampolineFuncIdx,
    methodFuncIdx,
    objStructTypeIdx,
    userParamCount: userParams.length,
    wrapperUserParams: userParams,
    wrapperResult: results[0],
    methodUsesThis, // (#2025) captured pre-shift; finalize reuses it
    // (#1809) Record whether the target is already an import at registration.
    // Import indices stay stable across late-import batches (new imports append
    // at the end, so indices < importsBefore are never shifted), so an import
    // target at finalize is EXPECTED, not a missed shift.
    methodTargetsImport: methodFuncIdx < ctx.numImportFuncs,
  });

  // Emit: ref.func $trampoline, (#3673) $arity, (#4241) $bag, struct.new $closure_struct
  //
  // (#4440) …plus the `$fnmeta` operand when the member carries resolvable
  // metadata. The base wrapper struct is SHARED across every function of this
  // signature, so the slot lives on a per-base SUBTYPE — allocate the derived
  // type and report the BASE (#4437's note 3: a `ref.cast` to a MORE derived
  // type traps on a value stored as the base; widening is the safe direction).
  const metaSlot = fnMetaSlotForMemberDecl(ctx, memberDecl);
  const allocTypeIdx = metaSlot ? ensureFnMetaSubtype(ctx, allocationStructTypeIdx) : undefined;
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  fctx.body.push({ op: "i32.const", value: userParams.length });
  fctx.body.push(closureBagInitInstr());
  if (metaSlot && allocTypeIdx !== undefined) for (const instr of metaSlot.init) fctx.body.push(instr);
  fctx.body.push({
    op: "struct.new",
    typeIdx: allocTypeIdx !== undefined && metaSlot ? allocTypeIdx : allocationStructTypeIdx,
  });

  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * (#1602) Rebuild every object-method-as-closure trampoline body against the
 * method's FINAL signature. Must run after all function bodies are compiled
 * (so `func.typeIdx` re-resolution has settled) and BEFORE late-import index
 * shifting, since the rebuilt body re-emits `call methodFuncIdx` at the current
 * (pre-shift) index — the shift machinery then walks it like any other body.
 *
 * The trampoline's own signature (its wrapper func type) is left untouched; we
 * only fix the forwarding body so its `local.get` count and the `call`'s
 * operand types match the method's resolved params. The wrapper's user-param
 * count is invariant (derived from the same method), so the trampoline param
 * indices stay valid; only the per-arg coercion is what could drift, and any
 * coercion the call needs is applied by mirroring the method's param types.
 */
export function finalizeMethodTrampolines(ctx: CodegenContext): void {
  for (const t of ctx.pendingMethodTrampolines) {
    // (#1525b / #1809) If the captured methodFuncIdx resolves to an IMPORT at
    // finalize (< ctx.numImportFuncs), there are two distinct cases:
    //
    //   1. The target was ALREADY an import at registration (`methodTargetsImport`)
    //      — e.g. a host/DOM global (`resizeTo`, `scrollBy`) or a `declare`d
    //      function used as a first-class value. Import indices never shift
    //      (new late imports append at the end, so indices < importsBefore are
    //      left untouched by every shift walker), so the trampoline still
    //      forwards into the correct import. `getFuncSignature` below resolves
    //      the import's signature, and `call methodFuncIdx` against an import is
    //      valid Wasm. This is EXPECTED — proceed with the normal rebuild.
    //
    //   2. The target was a DEFINED function at registration but now lands in
    //      the import range. That can only mean the late-import shift machinery
    //      missed this entry — a real #1525b regression. Fail loudly rather
    //      than emit invalid Wasm (it would `call` the wrong import).
    if (t.methodFuncIdx < ctx.numImportFuncs && !t.methodTargetsImport) {
      throw new Error(
        `pendingMethodTrampolines: methodFuncIdx ${t.methodFuncIdx} ` +
          `points at import "${ctx.mod.imports[t.methodFuncIdx]?.name}" — ` +
          `shift walker missed this entry (#1525b regression)`,
      );
    }
    const sig = getFuncSignature(ctx, t.methodFuncIdx);
    if (!sig) continue;
    // (#1340) Plain function decls have no hidden `this`; method sigs lead
    // with `this` at param 0 and need it dropped. The legacy method path
    // requires `sig.params.length >= 1` because it slices off `this`.
    if (!t.noThisParam && sig.params.length === 0) continue;
    const methodUserParams = t.noThisParam ? sig.params : sig.params.slice(1);
    // Only rebuild when the user-param arity is unchanged. The trampoline's
    // OWN func type (its wrapper type) was fixed at registration with
    // `userParamCount` params and is shared/cached, so it cannot change here;
    // forwarding a different number of params would violate that contract and
    // produce an invalid `local.get` index. An arity change (e.g. async method
    // param injection) is a separate concern handled by its own codegen path.
    if (methodUserParams.length !== t.userParamCount) continue;

    // (#1669) The trampoline's OWN signature (the wrapper func type, captured
    // when the closure value was emitted) fixes the types of the `local.get`s
    // the forwarding body reads. The method's signature may have been
    // re-resolved during body compilation (default-param / generator / async
    // methods finalize their param types and order then), so the wrapper param
    // types and the method param types can DRIFT — e.g. a default-param method
    // resolves its param to `f64` while the closure-value ABI typed the wrapper
    // param `externref`, or two structurally-deduped sibling literals swap a
    // param's `f64`/`externref` position. Forwarding the wrapper-typed value
    // straight into `call methodFuncIdx` then emits an invalid `call`
    // ("expected externref, found (ref null N)" / "expected externref, found
    // f64"). The same drift can affect the RESULT: the wrapper's declared
    // result is `externref` while the method now returns `(ref null N)`, which
    // shows up as a `fallthru` type error.
    //
    // #1602 introduced this rebuild but forwarded the params verbatim with no
    // coercion, which is correct only when the types did not drift. Re-emit the
    // forwarding with a per-arg coercion from the WRAPPER param type to the
    // METHOD param type, and a final coercion from the method result to the
    // wrapper result, so the rebuilt body validates against both signatures.
    // The wrapper signature is captured at emit time (the static types of the
    // `local.get`s the body reads and the type it must return). Re-deriving it
    // from `t.trampolineFuncIdx` is unsafe: late-import shifting can move that
    // index relative to the recorded value, returning a different function's
    // signature (observed for async methods).
    const wrapperUserParams = t.wrapperUserParams;
    const wrapperResult = t.wrapperResult;
    const methodResult = sig.results[0];

    // Build a minimal FunctionContext so coercions that need a scratch local
    // (externref → ref/ref_null) can allocate one. Its `params` mirror the
    // trampoline's wrapper signature exactly (closure_self at index 0, then the
    // wrapper's user params at 1..N) so `allocTempLocal` computes a temp index
    // past the real params; the allocated `localDefs` are attached to the
    // registered trampoline function below.
    const localDefs: LocalDef[] = [];
    const tFctx: FunctionContext = {
      name: `__obj_meth_tramp_finalize_${t.trampolineFuncIdx}`,
      params: [
        { name: "__self", type: { kind: "anyref" } },
        ...wrapperUserParams.map((p, i) => ({ name: `__p${i}`, type: p })),
      ],
      locals: localDefs,
      localMap: new Map(),
      returnType: wrapperResult ?? null,
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
    };

    // (#1340) Function-decl trampolines have no `this` prologue; method
    // trampolines resolve the receiver from `__current_this` (#2015, falling
    // back to `ref.null` for the unbound method-extraction case) before
    // forwarding user params. The anyref scratch local is allocated through
    // `tFctx` so it lands in `localDefs` (attached to the registered function
    // below) and any later coercion temps allocate after it.
    let newBody: Instr[];
    if (t.noThisParam) {
      newBody = [];
    } else {
      const anyTempLocalIdx = allocTempLocal(tFctx, { kind: "anyref" });
      // (#2025) Reuse the registration-time `methodUsesThis` (captured before
      // the TypeError-helper import shifted function indices, so it is reliable
      // here where `t.methodFuncIdx` may be stale). Fall back to a fresh body
      // scan only when it wasn't recorded.
      const usesThis = t.methodUsesThis ?? methodBodyReadsThis(ctx, t.methodFuncIdx);
      newBody = buildTrampolineThisSlot(ctx, t.objStructTypeIdx, anyTempLocalIdx, usesThis);
      // (#4466) Do NOT re-coerce the receiver here, and do NOT alias
      // `tFctx.body` to `newBody` to make that possible. The emit-time call
      // sites (`emitObjectMethodAsClosure`, `ensureMethodClosureSingleton`)
      // already reconcile the receiver; repeating it on the finalize REBUILD
      // path corrupted the private-method trampoline
      // (`class/elements/super-access-inside-a-private-method.js` →
      // "dereferencing a null pointer" in `__obj_meth_tramp_*_cached`). The
      // aliasing is independently against the rule in CLAUDE.md — a
      // FunctionContext must own `body: []`, never a shared reference, or the
      // savedBody/swap pattern writes through into someone else's buffer.
    }
    for (let i = 0; i < methodUserParams.length; i++) {
      newBody.push({ op: "local.get", index: i + 1 });
      const from = wrapperUserParams[i];
      const to = methodUserParams[i]!;
      if (from && from.kind !== to.kind) {
        tFctx.body = newBody;
        newBody.push(...coercionInstrs(ctx, from, to, tFctx));
      } else if (
        from &&
        (from.kind === "ref" || from.kind === "ref_null") &&
        (to.kind === "ref" || to.kind === "ref_null")
      ) {
        // Same kind but possibly different struct typeIdx — guarded re-cast.
        const fromIdx = (from as { typeIdx?: number }).typeIdx;
        const toIdx = (to as { typeIdx?: number }).typeIdx;
        if (fromIdx !== toIdx && toIdx !== undefined) {
          tFctx.body = newBody;
          newBody.push(...coercionInstrs(ctx, from, to, tFctx));
        }
      }
    }
    newBody.push({ op: "call", funcIdx: t.methodFuncIdx });
    // Reconcile the result arity/type with the wrapper's declared result.
    if (methodResult && !wrapperResult) {
      // Method now returns a value the void wrapper must discard.
      newBody.push({ op: "drop" });
    } else if (wrapperResult && methodResult && wrapperResult.kind !== methodResult.kind) {
      tFctx.body = newBody;
      newBody.push(...coercionInstrs(ctx, methodResult, wrapperResult, tFctx));
    } else if (
      wrapperResult &&
      methodResult &&
      (wrapperResult.kind === "ref" || wrapperResult.kind === "ref_null") &&
      (methodResult.kind === "ref" || methodResult.kind === "ref_null") &&
      (wrapperResult as { typeIdx?: number }).typeIdx !== (methodResult as { typeIdx?: number }).typeIdx
    ) {
      // (#1672) Both results are GC struct refs but with DIFFERENT typeIdx.
      // This happens when the wrapper captured the method's result struct type
      // at closure-emit time (`results[0]`), but the method body later resolved
      // its return to a structurally-distinct struct type (e.g. two
      // iterator-result-like struct shapes built at different points — the
      // AsyncFromSyncIterator `next`/`return`/`throw` accessor path). `coercionInstrs`
      // is a NO-OP for same-`kind` operands (`from.kind === to.kind`), so the
      // earlier reliance on it left the body returning `ref methodTypeIdx` where
      // the wrapper's func type declares `ref wrapperTypeIdx` — an invalid module
      // ("fallthru" / result type error compiling `__obj_meth_tramp_*`). Emit an
      // explicit cast to the wrapper's declared result type instead. The cast is
      // routed through `anyref` so it works regardless of whether the two struct
      // types share a supertype (a direct `ref.cast` between unrelated GC types is
      // itself invalid). At runtime the method's generator/iterator-result object
      // is a valid instance of the wrapper's result shape, so the cast succeeds.
      const wrapperTypeIdx = (wrapperResult as { typeIdx: number }).typeIdx;
      if (methodResult.kind === "ref") {
        // Non-null source: cast directly.
        newBody.push({ op: "ref.cast", typeIdx: wrapperTypeIdx });
      } else {
        // Nullable source: a null must stay null; cast preserves nullability when
        // the target is also nullable, else guard. Wrapper result kind dictates.
        if (wrapperResult.kind === "ref_null") {
          newBody.push({ op: "ref.cast_null", typeIdx: wrapperTypeIdx });
        } else {
          newBody.push({ op: "ref.cast", typeIdx: wrapperTypeIdx });
        }
      }
    }

    // Mutate the existing body array in place so the already-registered
    // function keeps the same body reference, and attach any temp locals
    // coercion allocated for this trampoline. The function is located by body
    // identity (not by `trampolineFuncIdx`, which may have shifted): the
    // registered trampoline holds the SAME `t.trampolineBody` array reference.
    //
    // (#2015) The rebuilt body's local indices are computed against `tFctx`,
    // whose `locals` (`localDefs`) start empty — so the `__current_this` anyref
    // scratch lands at the first slot past the wrapper params and any coercion
    // temps after it. The initial emit pre-seeded the function with a single
    // `__this_any` anyref local at that SAME index, so REPLACE the function's
    // locals with `localDefs` (rather than append) to keep the persisted layout
    // in lockstep with the rebuilt body; an append would shift every temp by one.
    if (!t.noThisParam || localDefs.length > 0) {
      const func = ctx.mod.functions.find((f) => f.body === t.trampolineBody);
      if (func) func.locals = localDefs;
    }
    t.trampolineBody.length = 0;
    t.trampolineBody.push(...newBody);
  }
  ctx.pendingMethodTrampolines.length = 0;
}

/**
 * (#1394) Emit a cached singleton closure for a class method, preserving
 * identity: every emit of `C.prototype.<method>` (or `instance.<method>`
 * as a value) returns the same externref so JS's `===` works (e.g.
 * `c.m === C.prototype.m`). 478 tests under
 * `language/{expressions,statements}/class/elements/*` exercise this
 * exact assertion via `verifyProperty(C.prototype, "m", { value: m })`.
 *
 * The cache is a per-class-method module-level externref global,
 * lazily initialised on first access (matches the existing
 * `emitLazyProtoGet` pattern). The canonical trampoline is registered
 * once per method too — its name is
 * `__obj_meth_tramp_${methodName}_cached`, distinct from the legacy
 * per-call-site `__obj_meth_tramp_${methodName}_${counter}` that
 * `emitObjectMethodAsClosure` emits.
 *
 * Returns `true` if the access was emitted; `false` if the method's
 * signature couldn't be resolved (caller should fall back).
 */
/**
 * (#3270 dedup) Emit the shared lazy externref-cache access kernel:
 *
 *   global.get $cache
 *   ref.is_null
 *   if (then: ref.func $tramp; struct.new $struct; extern.convert_any; global.set $cache)
 *   global.get $cache
 *
 * builds the closure ONCE into the module-level cache global, then reads it.
 * The func-decl caller appends its own `any.convert_extern` + `ref.cast`
 * recovery after this returns.
 */
/** (#4437) Narrow a singleton's optional metadata pair into the emit argument. */
function fnMetaAllocOf(singleton: FuncClosureSingleton): { allocStructTypeIdx: number; metaInit: Instr[] } | undefined {
  return singleton.allocStructTypeIdx !== undefined && singleton.metaInit !== undefined
    ? { allocStructTypeIdx: singleton.allocStructTypeIdx, metaInit: singleton.metaInit }
    : undefined;
}

function emitLazyClosureCacheAccess(
  fctx: FunctionContext,
  cacheGlobalIdx: number,
  trampolineFuncIdx: number,
  structTypeIdx: number,
  arity: number,
  constructible = false,
  /** (#4437) `$fnmeta` operand + the SUBTYPE to allocate, when the slot exists. */
  meta?: { allocStructTypeIdx: number; metaInit: Instr[] },
): void {
  const initBody: Instr[] = [
    { op: "ref.func", funcIdx: trampolineFuncIdx },
    { op: "i32.const", value: arity }, // (#3673) $arity
    closureBagInitInstr(), // (#4241) $bag
    ...(constructible ? ([{ op: "i32.const", value: 1 }] satisfies Instr[]) : []),
    ...(meta ? meta.metaInit : []),
    { op: "struct.new", typeIdx: meta ? meta.allocStructTypeIdx : structTypeIdx },
    { op: "extern.convert_any" },
    { op: "global.set", index: cacheGlobalIdx },
  ];
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
}

export function emitCachedMethodClosureAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  methodFuncIdx: number,
  objStructTypeIdx: number,
): boolean {
  const singleton = ensureMethodClosureSingleton(ctx, fctx, methodName, methodFuncIdx, objStructTypeIdx);
  if (!singleton) return false;
  const { cacheGlobalIdx, trampolineFuncIdx, closureStructTypeIdx } = singleton;

  // Emit the lazy-init access (mirrors `emitLazyProtoGet`):
  //   global.get $cache
  //   ref.is_null
  //   if (then: build closure, store in $cache)
  //   global.get $cache
  emitLazyClosureCacheAccess(
    fctx,
    cacheGlobalIdx,
    trampolineFuncIdx,
    closureStructTypeIdx,
    ctx.closureInfoByTypeIdx.get(closureStructTypeIdx)?.paramTypes.length ?? 0,
    /* constructible */ false,
    fnMetaAllocOf(singleton), // (#4440)
  );
  return true;
}

/**
 * (#2963) The creation half of {@link emitCachedMethodClosureAccess}, split out
 * so the member-get dispatcher (`member-get-dispatch.ts`) can pre-create the
 * SAME canonical singleton machinery (trampoline + cache global) at reserve
 * time — giving a DYNAMIC `any`-receiver method read (`c.m` where `c: any`)
 * the identical value the typed read (`C.prototype.m`) yields, so
 * `c.m === C.prototype.m` holds. Idempotent per `methodName`.
 *
 * Returns the handles, or `null` when the method signature is unresolvable
 * (caller falls back / skips the candidate). NOTE: `trampolineFuncIdx` and
 * `cacheGlobalIdx` are the CURRENT indices — late imports added after this
 * call shift them. Compile-time callers baking instrs immediately (the typed
 * read) are covered by the body walkers; FINALIZE-time consumers must
 * re-resolve by name (`__obj_meth_tramp_<name>_cached` via funcMap,
 * `ctx.methodClosureGlobals.get(methodName)` — both shift-maintained).
 */
export function ensureMethodClosureSingleton(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  methodFuncIdx: number,
  objStructTypeIdx: number,
): FuncClosureSingleton | null {
  // Resolve the user-visible signature so we know the wrapper struct's
  // funcref shape. Method signature is [(ref null objStruct), ...userParams]
  // → results; strip the leading `this` to derive the closure-callable
  // user signature.
  const sig = getFuncSignature(ctx, methodFuncIdx);
  if (!sig || sig.params.length === 0) return null;
  const userParams = sig.params.slice(1);
  const results = sig.results;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
  if (!wrapperTypes) return null;
  const { structTypeIdx, liftedFuncTypeIdx } = wrapperTypes;

  // Reuse the canonical trampoline if one was already registered for
  // this method; otherwise build it once.
  const trampolineName = `__obj_meth_tramp_${methodName}_cached`;
  let trampolineFuncIdx = ctx.funcMap.get(trampolineName);
  if (trampolineFuncIdx === undefined) {
    // Trampoline body: drop the closure-self arg (param 0), resolve the
    // method's `this` from `__current_this` (#2015 — falls back to
    // `ref.null` for the unbound method-extraction case `var fn = c.m;
    // fn();` where JS strict mode calls with `this = undefined`, so the
    // null receiver propagates the spec-mandated TypeError on `this.field`
    // access), then forward user params, then call the method.
    const anyTempLocalIdx = 1 + userParams.length;
    // (#2025) Capture this-usage, register the throw helpers, then adjust the
    // forwarding index by any import-shift the registration caused (see the
    // matching note in emitObjectMethodAsClosure).
    const methodUsesThisCached = methodBodyReadsThis(ctx, methodFuncIdx);
    const importsBeforeNT = ctx.numImportFuncs;
    ensureNullThisTypeError(ctx, fctx);
    const ntShift = ctx.numImportFuncs - importsBeforeNT;
    if (ntShift > 0 && inLiveShiftRange(methodFuncIdx, importsBeforeNT)) methodFuncIdx += ntShift;
    const trampolineBody: Instr[] = buildTrampolineThisSlot(
      ctx,
      objStructTypeIdx,
      anyTempLocalIdx,
      methodUsesThisCached,
    );
    coerceTrampolineThisSlot(ctx, trampolineBody, objStructTypeIdx, sig.params[0], methodUsesThisCached, fctx);
    for (let i = 0; i < userParams.length; i++) {
      trampolineBody.push({ op: "local.get", index: i + 1 });
    }
    trampolineBody.push({ op: "call", funcIdx: methodFuncIdx });
    trampolineFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, trampolineFuncIdx, {
      name: trampolineName,
      typeIdx: liftedFuncTypeIdx,
      locals: [{ name: "__this_any", type: { kind: "anyref" } }],
      body: trampolineBody,
      exported: false,
    });
    ctx.funcMap.set(trampolineName, trampolineFuncIdx);
    ctx.mod.declaredFuncRefs.push(trampolineFuncIdx);

    // (#1669) The method's `func.typeIdx` may still be re-resolved after this
    // first cached access (the method body is compiled later in the same pass,
    // and generator/default-param/async methods finalize their param types and
    // order during that body compile). The trampoline body built above forwards
    // `local.get`s typed by THIS wrapper signature into `call methodFuncIdx`,
    // which validates against the method's FINAL signature. If they drift, the
    // module is invalid. #1602 fixed exactly this for the per-call-site
    // (non-cached) trampoline via `pendingMethodTrampolines`; the cached
    // singleton trampoline was never enrolled, so it kept the stale forwarding.
    // Enroll it so `finalizeMethodTrampolines` rebuilds the body against the
    // method's final signature (with per-arg externref coercion).
    ctx.pendingMethodTrampolines.push({
      trampolineBody,
      trampolineFuncIdx,
      methodFuncIdx,
      objStructTypeIdx,
      userParamCount: userParams.length,
      wrapperUserParams: userParams,
      wrapperResult: results[0],
      methodUsesThis: methodUsesThisCached, // (#2025) captured pre-shift
      // (#1809) See the per-call-site push for rationale.
      methodTargetsImport: methodFuncIdx < ctx.numImportFuncs,
    });
  }

  // Reuse or allocate the cache global. Type is externref so the value
  // is stable across access sites (the closure-struct ref is converted
  // via `extern.convert_any` once at init).
  let cacheGlobalIdx = ctx.methodClosureGlobals.get(methodName);
  if (cacheGlobalIdx === undefined) {
    cacheGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__method_closure_${methodName}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.methodClosureGlobals.set(methodName, cacheGlobalIdx);
  }

  // (#4440) A class / object-literal method is #4437's R1 residual: this site
  // has only `methodName`, so the §15.1.5 walk had nothing to read and `length`
  // fell back to `$arity` (the DECLARED FORMAL COUNT — 1 for `m(x = 42)`, spec
  // 0). `class-bodies.ts` records the declaration under exactly this physical
  // name; a member whose key is computed/private records nothing and keeps the
  // pre-#4440 answers, which is the safe direction (see the methods module).
  const metaSlot = fnMetaSlotForMemberName(ctx, methodName);
  const allocStructTypeIdx = metaSlot ? ensureFnMetaSubtype(ctx, structTypeIdx) : undefined;
  return {
    cacheGlobalIdx,
    trampolineFuncIdx,
    closureStructTypeIdx: structTypeIdx,
    ...(allocStructTypeIdx !== undefined && metaSlot ? { allocStructTypeIdx, metaInit: metaSlot.init } : {}),
  };
}

/**
 * (#1340) Emit a cached singleton closure for a top-level function declaration
 * used as a first-class value. Mirrors `emitCachedMethodClosureAccess` (#1394)
 * for the function-decl case.
 *
 * Without caching, every textual occurrence of `foo` (in value position)
 * compiled a fresh `struct.new $closure_struct`, so `foo === foo` was false
 * and sidecar writes on `foo.prototype` keyed by the struct identity never
 * round-tripped (test262 Iterator helpers misclassified as `wasm_compile`).
 *
 * One externref cache global per function name, lazily initialised on first
 * read; all later reads return the same externref. Call dispatch is unchanged
 * (resolved via `funcMap` + direct `call funcIdx`); only the value-context
 * read uses the cached closure.
 *
 * Only safe for captureless functions — captures must be filled at the
 * per-construction site, not once at module init.
 *
 * Returns the closure struct's `ref` ValType when the cached access was
 * emitted (so downstream consumers like array-methods.ts can take the
 * direct `call_ref` fast path against the closure's funcref slot rather
 * than the externref-bridge slow path through `__call_2_f64`). Returns
 * `null` when the signature couldn't be resolved (caller falls back).
 */
export interface FuncClosureSingleton {
  readonly cacheGlobalIdx: number;
  readonly trampolineFuncIdx: number;
  readonly closureStructTypeIdx: number;
  /**
   * (#4437) The type to `struct.new`, when the closure carries a `$fnmeta`
   * slot — a per-base SUBTYPE of `closureStructTypeIdx`.
   *
   * Deliberately SEPARATE from `closureStructTypeIdx`, which stays the base:
   * the read path casts the cached externref back with `ref.cast`, and this
   * helper's own doc records that casting to a MORE derived type traps on a
   * value stored as the base. Allocating derived and casting to the base is the
   * safe direction; the reverse is the live `illegal cast` hazard.
   */
  readonly allocStructTypeIdx?: number;
  /** (#4437) The `$fnmeta` operand for `allocStructTypeIdx`, pushed last. */
  readonly metaInit?: Instr[];
}

/**
 * Ensure the declarations behind a cached top-level function value exist,
 * without emitting an access into a legacy FunctionContext.
 *
 * #3214 B1 uses this planning half before AST→IR lowering, then emits the same
 * `__fn_closure_<name>` lazy cache protocol with symbolic IR global/function
 * references. Keeping creation here guarantees both front-ends share the
 * trampoline, wrapper registry, cache global, declared-ref enrollment, and
 * late signature finalization machinery.
 */
export function ensureFuncClosureSingleton(
  ctx: CodegenContext,
  funcName: string,
  funcIdx: number,
  constructible = false,
): FuncClosureSingleton | null {
  const sig = getFuncSignature(ctx, funcIdx);
  if (!sig) return null;

  const userParams = sig.params;
  const results = sig.results;
  const wrapperTypes = constructible
    ? getOrCreateConstructibleFuncRefWrapperTypes(ctx, userParams, results)
    : getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
  if (!wrapperTypes) return null;
  const { structTypeIdx, liftedFuncTypeIdx } = wrapperTypes;

  // (#4133) The trampoline and cache were keyed by the BARE function name, so
  // two modules declaring the same top-level name shared one singleton. The
  // reuse path below validates the existing trampoline's SHAPE but never that it
  // targets the same function, so the second module's closure value silently
  // called the FIRST module's function — and, once both units became genuinely
  // reachable, two unit-anchored ABI binding ids claimed one trampoline object
  // and `ProgramAbiSession` rejected the second ("allocator locator … is already
  // owned by"), which is how this surfaced on the ESLint graph (eslint-visitor-
  // keys 3.4.3 and 5.0.1 both ship a top-level `getKeys`).
  //
  // Resolve a key that is unique PER TARGET: reuse the base name when it is free
  // or already points at this exact function, otherwise take the next `$n`
  // suffix. Assignment order is compile order, which is deterministic and
  // identical across passes — so unlike embedding a raw function handle, this
  // cannot drift when late imports shift indices (#2043).
  const targetOfTrampoline = (handle: number): number | undefined => {
    const body = definedFuncAt(ctx, handle)?.body;
    if (!body) return undefined;
    for (let i = body.length - 1; i >= 0; i--) {
      const instr = body[i]!;
      if (instr.op === "call") return instr.funcIdx;
    }
    return undefined;
  };

  let key = funcName;
  let trampolineName = `__fn_tramp_${key}_cached`;
  let trampolineFuncIdx = ctx.funcMap.get(trampolineName);
  let cacheGlobalIdx = ctx.funcClosureGlobals.get(key);
  for (let disambiguator = 1; ; disambiguator++) {
    // Free, or an existing pair that already targets exactly this function.
    if (trampolineFuncIdx === undefined && cacheGlobalIdx === undefined) break;
    if (
      trampolineFuncIdx !== undefined &&
      cacheGlobalIdx !== undefined &&
      targetOfTrampoline(trampolineFuncIdx) === funcIdx
    ) {
      break;
    }
    // A half-registered pair is the pre-existing "a user declaration occupies
    // the synthetic name" case — keep rejecting it rather than inventing a
    // suffix around it.
    if ((trampolineFuncIdx === undefined) !== (cacheGlobalIdx === undefined)) break;
    key = `${funcName}$${disambiguator}`;
    trampolineName = `__fn_tramp_${key}_cached`;
    trampolineFuncIdx = ctx.funcMap.get(trampolineName);
    cacheGlobalIdx = ctx.funcClosureGlobals.get(key);
  }

  // The generated trampoline and cache are one provenance pair. A source
  // declaration may legally occupy the synthetic trampoline name before the
  // first value read; accepting that funcMap entry and then minting only the
  // cache would pair an arbitrary user function with our closure wrapper. The
  // resulting module can validate yet trap when the wrapper is invoked. Only
  // reuse an existing trampoline when this helper previously registered its
  // companion cache, and validate both records against the requested ABI.
  if ((trampolineFuncIdx === undefined) !== (cacheGlobalIdx === undefined)) return null;
  if (trampolineFuncIdx !== undefined && cacheGlobalIdx !== undefined) {
    const trampoline = definedFuncAt(ctx, trampolineFuncIdx);
    const cache = ctx.mod.globals[localGlobalIdx(ctx, cacheGlobalIdx)];
    if (
      trampoline?.name !== trampolineName ||
      trampoline.typeIdx !== liftedFuncTypeIdx ||
      cache?.name !== `__fn_closure_${key}` ||
      cache.type.kind !== "externref" ||
      !cache.mutable
    ) {
      return null;
    }
  } else {
    const trampolineBody: Instr[] = [];
    for (let i = 0; i < userParams.length; i++) {
      trampolineBody.push({ op: "local.get", index: i + 1 });
    }
    trampolineBody.push({ op: "call", funcIdx });
    trampolineFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, trampolineFuncIdx, {
      name: trampolineName,
      typeIdx: liftedFuncTypeIdx,
      locals: [],
      body: trampolineBody,
      exported: false,
    });
    ctx.funcMap.set(trampolineName, trampolineFuncIdx);
    ctx.mod.declaredFuncRefs.push(trampolineFuncIdx);

    ctx.pendingMethodTrampolines.push({
      trampolineBody,
      trampolineFuncIdx,
      methodFuncIdx: funcIdx,
      objStructTypeIdx: -1,
      userParamCount: userParams.length,
      wrapperUserParams: userParams,
      wrapperResult: results[0],
      noThisParam: true,
      methodTargetsImport: funcIdx < ctx.numImportFuncs,
    });

    cacheGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__fn_closure_${key}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.funcClosureGlobals.set(key, cacheGlobalIdx);
  }

  observeProgramAbiFunctionValue(ctx, funcIdx, trampolineFuncIdx, cacheGlobalIdx);

  // (#4437) The cached singleton is the canonical value of a top-level function
  // DECLARATION — the receiver every `verifyProperty(f, "name", …)` sees. It is
  // built exactly once into the cache global, so the metadata operand costs one
  // push per module, not per reference.
  const metaSlot = fnMetaSlot(
    ctx,
    ctx.funcMapOwnerDecl.get(funcName) ?? ctx.topLevelFunctionDeclarations.get(funcName),
  );
  const allocStructTypeIdx = metaSlot ? ensureFnMetaSubtype(ctx, structTypeIdx) : undefined;
  return {
    cacheGlobalIdx,
    trampolineFuncIdx,
    closureStructTypeIdx: structTypeIdx,
    ...(allocStructTypeIdx !== undefined && metaSlot ? { allocStructTypeIdx, metaInit: metaSlot.init } : {}),
  };
}

/**
 * (#4243) The externref-only half of {@link emitCachedFuncClosureAccess}: leave
 * the canonical cached closure for `funcName` on the stack as an `externref`,
 * skipping the `any.convert_extern` + `ref.cast` struct recovery.
 *
 * ## Why the cast is worth skipping when the caller only needs a value
 * `ensureFuncClosureSingleton` memoizes the trampoline + cache global by NAME
 * but recomputes `closureStructTypeIdx` from the `constructible` flag on every
 * call, and the constructible wrapper is a SUBTYPE of the plain one
 * (`superTypeIdx: base.structTypeIdx` in `getOrCreateConstructibleFuncRefWrapperTypes`).
 * So two callers that disagree about the flag share one cache global and
 * disagree about the struct — and the direction matters: a `ref.cast` to the
 * base succeeds on a stored constructible wrapper, but a cast to the
 * constructible type TRAPS on a stored base wrapper. That is a live hazard
 * (`RuntimeError: illegal cast`), reproduced while adding the `arguments.callee`
 * seed, where a module-init binding seed stored the base wrapper first.
 *
 * A caller that wants a first-class value — not a `call_ref` fast path — never
 * needs the struct view, so it should not pay that cast. `arguments.callee` is
 * exactly that caller: the value is stored into a property descriptor as an
 * externref and is never dispatched from the seed site.
 *
 * Returns false when no singleton could be established, leaving `fctx.body`
 * untouched so the caller can decline cleanly.
 */
export function emitCachedFuncClosureExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  funcIdx: number,
  constructible = false,
): boolean {
  const singleton = ensureFuncClosureSingleton(ctx, funcName, funcIdx, constructible);
  if (!singleton) return false;
  const { cacheGlobalIdx, trampolineFuncIdx, closureStructTypeIdx } = singleton;
  emitLazyClosureCacheAccess(
    fctx,
    cacheGlobalIdx,
    trampolineFuncIdx,
    closureStructTypeIdx,
    ctx.closureInfoByTypeIdx.get(closureStructTypeIdx)?.paramTypes.length ?? 0,
    constructible,
    fnMetaAllocOf(singleton),
  );
  return true;
}

export function emitCachedFuncClosureAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  funcIdx: number,
  constructible = false,
): ValType | null {
  const singleton = ensureFuncClosureSingleton(ctx, funcName, funcIdx, constructible);
  // A synthetic-name collision makes the canonical pair unavailable, but
  // legacy value-producing sites still need a closure on the stack (module
  // live-binding seeds, Annex-B bindings, fnctor registration, and ordinary
  // identifier reads). Preserve their historical per-site path; A+B1 planning
  // calls `ensureFuncClosureSingleton` directly and therefore still demotes.
  if (!singleton) return emitFuncRefAsClosure(ctx, fctx, funcName, funcIdx, constructible);
  const { cacheGlobalIdx, trampolineFuncIdx, closureStructTypeIdx: structTypeIdx } = singleton;

  // Emit the lazy-init access (mirrors emitCachedMethodClosureAccess), but
  // recover the closure-struct ref on read so downstream consumers like
  // `array-methods.ts:setupArrayCallback` take the direct `call_ref` fast
  // path. Returning a bare externref forced the host-bridge slow path
  // through `__call_2_f64`, which in JS expects a real Function — array
  // callbacks via top-level fn decls (`[1,2].filter(fn)`) regressed with
  // `TypeError: fn is not a function`. The externref global is preserved
  // for stable cross-site identity (`foo === foo` and sidecar writes on
  // `foo.prototype`); `any.convert_extern + ref.cast` is a cheap, stable
  // bijection back to the struct ref view used by the call-site.
  //   global.get $cache
  //   ref.is_null
  //   if (then: build closure, extern.convert_any, store in $cache)
  //   global.get $cache
  //   any.convert_extern
  //   ref.cast (ref $struct)
  emitLazyClosureCacheAccess(
    fctx,
    cacheGlobalIdx,
    trampolineFuncIdx,
    structTypeIdx,
    ctx.closureInfoByTypeIdx.get(structTypeIdx)?.paramTypes.length ?? 0,
    constructible,
    fnMetaAllocOf(singleton),
  );
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
  return { kind: "ref", typeIdx: structTypeIdx };
}
