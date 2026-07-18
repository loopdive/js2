// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2674 — deferred-fill member-READ dispatcher `__get_member_<name>`.
 *
 * The SYMMETRIC read-side counterpart of #2664's `__set_member_<name>`. The
 * member-READ multi-struct dispatch (`findAlternateStructsForField` +
 * `ref.test`/`struct.get` chain in property-access.ts) was enumerated INLINE at
 * each read site, freezing its struct-candidate set at the read's compile time.
 * A field reader (a lifted parser-method closure reading `this` via
 * `__current_this`) compiled BEFORE a later-registered struct type for the same
 * logical object (acorn's Parser gets two shapes — `$__anon_5` then
 * `$__fnctor_Parser`, registered later) only got the earlier candidate's
 * `ref.test` arm. The real instance is the later type, so its `ref.test` fails
 * and the read falls through to `__extern_get` → `undefined` while WRITES (via
 * the #2664 deferred-fill dispatcher) hit the slot — read/write diverge and the
 * expression-parse loops never terminate (the acorn 9th dogfood wall).
 *
 * Fix (mirrors #2664 exactly): a per-property dispatcher
 * `__get_member_<name>(recv: externref) -> externref` reserved at the read site
 * (where `name` is a static string) with a placeholder body, and FILLED at
 * FINALIZE — when the FULL struct-type table is known — so it enumerates EVERY
 * struct candidate that owns the field, regardless of which function compiled
 * first. Reserve-then-fill discipline matches `fillClosedMethodDispatch` (#2151)
 * / `fillMemberSetDispatch` (#2664): all fill-body deps registered at reserve
 * time so the fill only READS funcMap (no funcIdx churn); the placeholder body is
 * replaced once at finalize (no rebuild of a funcIdx-baked body).
 *
 *   __get_member_<name>(recv: externref) -> externref
 *     any = any.convert_extern(recv)
 *     if ref.test S1: ref.cast S1; struct.get S1 <slot>; <box fieldType->externref>
 *     elif ref.test S2: …
 *     else: __extern_get(recv, "<name>")   ;; genuine host externrefs / sidecar
 *
 * The dispatcher returns a UNIFORM externref; the read SITE coerces it to the
 * type it needs (matching how #2664's write dispatcher took a uniform externref
 * value). Used as the ALTERNATES fallback — each read site keeps its own primary
 * fast-path (and any Phase-3 primitive narrowing); only the frozen multi-struct
 * alternates chain is replaced by this complete, finalize-filled dispatcher.
 *
 * Applies to BOTH gc/host and standalone (the dual-struct-type compile-order
 * hazard is mode-independent — acorn dogfoods in gc/host mode).
 */
import type { Instr, ValType } from "../ir/types.js";
import { classMemberFuncKey, resolveMethodOwnerClass } from "./class-member-keys.js"; // (#2963) method-arm candidates
import { ensureMethodClosureSingleton } from "./closures.js"; // (#2963) canonical method-value singleton
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isNativeGeneratorResultStruct, sentinelAwareF64BoxInstrs } from "./generators-native.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { findAlternateStructsForField } from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coercionInstrs } from "./type-coercion.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2/S3) positional-read chokepoint + stable-regime minting

/** Mangle a property name into the reserved member-get dispatcher name. */
function dispatcherName(propName: string): string {
  return `__get_member_${propName}`;
}

/**
 * (#2963) A dynamic-read METHOD arm recorded at reserve time for the fill.
 * The trampoline funcIdx + cache-global idx are re-resolved BY NAME at fill
 * time (`__obj_meth_tramp_<methodFullName>_cached` in funcMap /
 * `ctx.methodClosureGlobals` — both late-import-shift-maintained); only the
 * receiver test type and closure struct type (append-only, pre-emission
 * stable) are baked here.
 */
export interface MemberGetMethodArm {
  /** The concrete class struct the receiver is `ref.test`ed against. */
  receiverStructTypeIdx: number;
  /** Owner-canonicalised `<Class>_<method>` — the singleton cache key. */
  methodFullName: string;
  /** The funcref-wrapper closure struct the lazy init `struct.new`s. */
  closureStructTypeIdx: number;
  /** Inheritance depth of the RECEIVER class — children sort first so an
   * override's arm shadows the superclass arm under WasmGC subtyping. */
  depth: number;
}

/**
 * (#2963) Enumerate every class whose PROTOTYPE owns a method named
 * `propName` — the class-method candidates a dynamic `any`-receiver member
 * read must resolve. Today such a read falls to `__extern_get` → `undefined`,
 * which is both wrong-typed (`typeof c.m !== "function"`) and identity-broken
 * (`c.m !== C.prototype.m` — the ~87-file test262 class-elements cluster).
 *
 * Identity follows the OWNING class (`resolveMethodOwnerClass`), so an
 * inherited method resolves to the parent's cache key — the SAME singleton
 * the typed `C.prototype.m` read yields.
 */
export function classMethodCandidatesForProp(
  ctx: CodegenContext,
  propName: string,
): {
  className: string;
  owner: string;
  methodFullName: string;
  methodFuncIdx: number;
  receiverStructTypeIdx: number;
  ownerStructTypeIdx: number;
  depth: number;
}[] {
  if (!propName || propName === "constructor" || propName === "prototype" || propName === "__proto__") return [];
  const out: {
    className: string;
    owner: string;
    methodFullName: string;
    methodFuncIdx: number;
    receiverStructTypeIdx: number;
    ownerStructTypeIdx: number;
    depth: number;
  }[] = [];
  const seenCanonical = new Set<string>();
  for (const rawClassName of ctx.classSet) {
    // (#1394 dual-registration bridge) A class EXPRESSION registers under BOTH
    // its binding name (`C`) and its synthetic name (`__anonClass_N`); the
    // typed read canonicalises to the SYNTHETIC name for the cache key, so the
    // dynamic arm must too — otherwise the two paths mint two singletons and
    // identity breaks exactly for class expressions.
    const className = ctx.classExprNameMap.get(rawClassName) ?? rawClassName;
    if (seenCanonical.has(className)) continue;
    seenCanonical.add(className);
    if (!ctx.classMethodSet.has(`${className}_${propName}`)) continue;
    const receiverStructTypeIdx = ctx.structMap.get(className);
    if (receiverStructTypeIdx === undefined) continue;
    const owner = resolveMethodOwnerClass(ctx, className, propName);
    const methodFullName = `${owner}_${propName}`;
    const methodFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, methodFullName));
    if (methodFuncIdx === undefined) continue;
    const ownerStructTypeIdx = ctx.structMap.get(owner) ?? receiverStructTypeIdx;
    // Inheritance depth (for children-first arm ordering under subtyping).
    let depth = 0;
    let p = ctx.classParentMap.get(className);
    const seen = new Set<string>([className]);
    while (p && !seen.has(p)) {
      seen.add(p);
      depth++;
      p = ctx.classParentMap.get(p);
    }
    out.push({ className, owner, methodFullName, methodFuncIdx, receiverStructTypeIdx, ownerStructTypeIdx, depth });
  }
  return out;
}

/**
 * (#3041) A dynamic-read GET-ACCESSOR arm. A getter reached through an
 * `any`-typed receiver on a class declared inside a function fell through the
 * `__get_member_<name>` dispatcher to `__extern_get` → `undefined`/NaN: the
 * dispatcher had struct-FIELD arms (`findAlternateStructsForField`) and method
 * arms (#2963) but NO arm for a get-accessor, whose value is COMPUTED by a
 * getter function, not stored in a slot. The static path
 * (`compilePropertyAccess`) resolves it via `classAccessorSet` +
 * `${Class}_get_<prop>`; this mirrors that resolution for the dynamic path.
 *
 * Unlike method arms, an accessor arm needs NO reserve-time minting — the getter
 * function is a plain `(ref $Struct) -> <ret>` already registered at class
 * codegen. So arms are enumerated entirely at FILL time (read-only over
 * funcMap/structMap); the arm just `ref.cast`s the receiver to the class struct
 * and `call`s the getter, then box-coerces the return to the dispatcher's
 * uniform externref.
 */
export interface MemberGetAccessorArm {
  /** The concrete class struct the receiver is `ref.test`ed / `ref.cast`ed to. */
  structTypeIdx: number;
  /** funcIdx of the `${Class}_get_<prop>` getter (`(ref $Struct) -> ret`). */
  getterFuncIdx: number;
  /** The getter's Wasm return type, box-coerced up to externref. */
  returnType: ValType;
  /** Inheritance depth of the receiver class — children sort first so an
   * override's accessor arm shadows the superclass arm under WasmGC subtyping. */
  depth: number;
}

/**
 * (#3041) Enumerate every class whose INSTANCE side owns a get-accessor named
 * `propName` — the accessor candidates a dynamic `any`-receiver member read must
 * resolve. Read-only over `ctx.classAccessorSet` / `ctx.structMap` / `funcMap`,
 * so it is safe to call at FILL time (no minting). Static accessors are
 * excluded (they are read off the constructor, not an instance).
 */
export function classAccessorCandidatesForProp(ctx: CodegenContext, propName: string): MemberGetAccessorArm[] {
  if (!propName || propName === "constructor" || propName === "prototype" || propName === "__proto__") return [];
  const out: MemberGetAccessorArm[] = [];
  const seenStructs = new Set<number>();
  const seenCanonical = new Set<string>();
  for (const rawClassName of ctx.classSet) {
    const className = ctx.classExprNameMap.get(rawClassName) ?? rawClassName;
    if (seenCanonical.has(className)) continue;
    seenCanonical.add(className);
    const accessorKey = `${className}_${propName}`;
    if (!ctx.classAccessorSet.has(accessorKey)) continue;
    if (ctx.staticAccessorSet.has(accessorKey)) continue; // static accessor — off the constructor, not an instance
    const structTypeIdx = ctx.structMap.get(className);
    if (structTypeIdx === undefined || seenStructs.has(structTypeIdx)) continue;
    // Inherited getters register a per-child funcMap entry pointing at the
    // owning class's getter func (class-bodies.ts), so a per-class lookup
    // resolves the right getter even without re-walking the parent chain.
    const getterFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_get_${propName}`));
    if (getterFuncIdx === undefined) continue;
    const getterFn = definedFuncAt(ctx, getterFuncIdx);
    if (!getterFn) continue;
    const typeDef = ctx.mod.types[getterFn.typeIdx];
    if (!typeDef || typeDef.kind !== "func" || typeDef.results.length === 0) continue; // void getter — nothing to box
    const returnType = typeDef.results[0]!;
    // Inheritance depth (children-first arm ordering under subtyping).
    let depth = 0;
    let p = ctx.classParentMap.get(className);
    const seen = new Set<string>([className]);
    while (p && !seen.has(p)) {
      seen.add(p);
      depth++;
      p = ctx.classParentMap.get(p);
    }
    seenStructs.add(structTypeIdx);
    out.push({ structTypeIdx, getterFuncIdx, returnType, depth });
  }
  // Children-first so an override's accessor arm wins over the superclass arm.
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

/**
 * (#2963) Ensure the canonical method-closure singleton machinery exists for
 * every class-method candidate of `propName`, and record the fill-time arms
 * on `ctx.memberGetMethodArms`. Runs at RESERVE time (normal compile time —
 * minting trampolines / cache globals / wrapper types is safe here, unlike at
 * finalize). Idempotent per (propName, receiver struct). Returns true when at
 * least one arm is recorded for `propName` (used by the read site to decide
 * whether routing through the dispatcher buys anything when there are no
 * struct-FIELD candidates).
 */
export function ensureMethodArmsForProp(ctx: CodegenContext, propName: string, fctx: FunctionContext): boolean {
  const candidates = classMethodCandidatesForProp(ctx, propName);
  if (candidates.length === 0) {
    return (ctx.memberGetMethodArms?.get(propName)?.length ?? 0) > 0;
  }
  let arms = ctx.memberGetMethodArms?.get(propName);
  if (!arms) {
    arms = [];
    (ctx.memberGetMethodArms ??= new Map<string, MemberGetMethodArm[]>()).set(propName, arms);
  }
  let ensured = false;
  for (const cand of candidates) {
    if (arms.some((a) => a.receiverStructTypeIdx === cand.receiverStructTypeIdx)) continue;
    const singleton = ensureMethodClosureSingleton(
      ctx,
      fctx,
      cand.methodFullName,
      cand.methodFuncIdx,
      cand.ownerStructTypeIdx,
    );
    if (!singleton) continue;
    arms.push({
      receiverStructTypeIdx: cand.receiverStructTypeIdx,
      methodFullName: cand.methodFullName,
      closureStructTypeIdx: singleton.closureStructTypeIdx,
      depth: cand.depth,
    });
    ensured = true;
  }
  if (ensured) {
    // Children-first so an override's arm wins over the superclass arm
    // (subclass structs are WasmGC subtypes — `ref.test $Parent` matches them).
    arms.sort((a, b) => b.depth - a.depth);
    // The fill's miss-gate needs `__extern_is_undefined` (host: JS undefined is
    // a NON-null externref; standalone S1: the undefined singleton is non-null).
    // Register it NOW — the fill must not add imports.
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  }
  return arms.length > 0;
}

/**
 * Reserve (or fetch) the member-get dispatcher `__get_member_<name>(recv) ->
 * externref` funcIdx with a placeholder body. The real body is built by
 * {@link fillMemberGetDispatch} at finalize. Idempotent; records the property
 * name in `ctx.memberGetDispatchNames`. Returns the reserved funcIdx, or
 * `undefined` if the `__extern_get` fallback import can't be registered.
 *
 * ALL fill-body deps are registered NOW (reserve time) so the fill only READS
 * funcMap (no funcIdx churn at finalize):
 *   - `__extern_get` (the terminal host-read fallback),
 *   - the property-name string constant (the fallback's key),
 *   - `__box_number` (union import — a per-struct arm box-coerces an f64/i32
 *     field result up to externref via `coercionInstrs`).
 *
 * (#2674-residual / #2043 late-import index-shift hardening) The
 * `ensureLateImport`/`addUnionImportsViaRegistry` calls below register imports
 * that shift the function index space. The READ call sites bake the returned
 * `funcIdx` into a DETACHED instruction array (the `buildFallback` terminal) AND
 * immediately follow it with a `coercionInstrs(…, fctx)` that may itself allocate
 * locals and register more late imports — both of which assume a SETTLED index
 * space. Unlike the WRITE side (which pushes straight into `fctx.body`, so the
 * body-level batched flush reaches it), a detached array left across a dangling
 * `pendingLateImportShift` is fragile: when another import-adding pass runs before
 * the body's deferred flush (the failure mode that surfaced only when #2075 was
 * batched with another import-adding PR in the merge_group — `local index out of
 * range at __module_init`, the #2043 class), the staged indices desync. So when a
 * caller passes its `fctx`, FLUSH the pending shift here (ensure→flush discipline,
 * matching `buildVecFromExternref`/`emitUndefined`) so the dispatcher's imports
 * settle before the caller emits anything further. No-op when there is no pending
 * shift or the helpers were already registered (idempotent reserve).
 */
export function reserveMemberGetDispatch(
  ctx: CodegenContext,
  propName: string,
  fctx?: FunctionContext,
): number | undefined {
  const name = dispatcherName(propName);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) {
    // (#2963) A class compiled AFTER the first reserve may add method
    // candidates for this prop — pick them up so the fill sees the full set.
    // Flush here because this early-return path skips the pre-mint flush
    // below (the ensure may stage late-import shifts).
    if (fctx) {
      ensureMethodArmsForProp(ctx, propName, fctx);
      flushLateImportShifts(ctx, fctx);
    }
    return existing;
  }

  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, propName);
  addUnionImportsViaRegistry(ctx);
  // (#3032 W6) A `value` dispatcher may grow a sentinel-canonicalizing arm for
  // the native-generator IteratorResult structs at fill time; under a JS host
  // that arm produces the REAL host `undefined` (`__get_undefined`) instead of
  // the null externref (which reads back as JS `null` and fails
  // `assert.sameValue(result.value, undefined)`). Register the import NOW —
  // the fill must not add imports. No-op under standalone/native-strings
  // (same gate as ensureGetUndefined; the fill keeps null-extern there).
  if (propName === "value" && !ctx.nativeStrings) {
    ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
  }
  // (#2963) Ensure the method-value singleton machinery (trampoline + cache
  // global) for every class-method candidate of this prop, and record the
  // fill-time arms. BEFORE the flush below so all import additions settle
  // into the dispatcher funcIdx minted afterwards.
  if (fctx) ensureMethodArmsForProp(ctx, propName, fctx);

  // (#2681) Settle the index-space shift the imports above staged BEFORE reserving
  // this dispatcher's funcIdx. Previously the flush ran AFTER `funcMap.set(name,
  // funcIdx)`, so `flushLateImportShifts` re-shifted the JUST-SET entry by `added`
  // (an OVER-shift): `funcMap[name]` then pointed `added` slots PAST the real
  // dispatcher, so `fillMemberGetDispatch` wrote the dispatcher body into the
  // WRONG function (e.g. `__module_init` — a 0-param fn → `local.tee 1` out of
  // range) and every baked `call funcIdx` targeted it. Flushing FIRST settles
  // `numImportFuncs`, so the funcIdx computed below is final and the entry is
  // never shifted again. (The earlier shift already reached the caller's `fctx`
  // body + every PRE-EXISTING funcMap entry; nothing the dispatcher bakes runs
  // before this point.) All callers pass `fctx`.
  if (fctx) flushLateImportShifts(ctx, fctx);

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$member_get_dispatch_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.memberGetDispatchNames ??= new Set<string>()).add(propName);
  return funcIdx;
}

/**
 * Fill every reserved `__get_member_<name>` dispatcher body at FINALIZE, after
 * every struct type (incl. late-registered fnctor structs) is known. READ-ONLY
 * over funcMap. No-op when no read site reserved a dispatcher.
 *
 * Body local layout: param 0 = recv (externref), local 1 = `__any` (anyref, the
 * converted receiver tested against each struct candidate).
 */
export function fillMemberGetDispatch(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const getIdx = ctx.funcMap.get("__extern_get");

  for (const propName of ctx.memberGetDispatchNames ?? []) {
    const dispIdx = ctx.funcMap.get(dispatcherName(propName));
    if (dispIdx === undefined) continue;
    const dispFn = definedFuncAt(ctx, dispIdx);
    if (!dispFn) continue;

    // Complete candidate set (full type table). Unlike the WRITE side, a READ
    // does not need the mutable filter — reading an immutable field is fine.
    const candidates = findAlternateStructsForField(ctx, propName, -1);

    // (#2963) Class-method arms recorded at reserve time. Resolved BY NAME
    // here (funcMap / methodClosureGlobals are shift-maintained; the fill
    // must not mint anything). Each arm answers the canonical method-value
    // singleton — the SAME cache global the typed `C.prototype.m` read uses —
    // so `c.m === C.prototype.m` holds across the dynamic path.
    const methodArms = (ctx.memberGetMethodArms?.get(propName) ?? [])
      .map((arm) => {
        const trampIdx = ctx.funcMap.get(`__obj_meth_tramp_${arm.methodFullName}_cached`);
        const cacheGlobalIdx = ctx.methodClosureGlobals.get(arm.methodFullName);
        if (trampIdx === undefined || cacheGlobalIdx === undefined) return undefined;
        return { ...arm, trampIdx, cacheGlobalIdx };
      })
      .filter((a): a is MemberGetMethodArm & { trampIdx: number; cacheGlobalIdx: number } => a !== undefined);
    // (#2963) `collectDeclaredFuncRefs` REBUILT the declared-elem set by
    // scanning bodies BEFORE this fill ran (the dispatcher body was still the
    // `unreachable` placeholder), so a trampoline whose ONLY `ref.func` lives
    // in this fill body was dropped → "undeclared reference to function"
    // validation error. Re-declare each arm's trampoline here (fill runs
    // before dead-elim, which keeps + remaps declaredFuncRefs entries).
    for (const arm of methodArms) {
      if (!ctx.mod.declaredFuncRefs.includes(arm.trampIdx)) ctx.mod.declaredFuncRefs.push(arm.trampIdx);
    }
    // Miss test helper: host `__extern_get` misses answer JS `undefined` (a
    // NON-null externref) and the standalone S1 regime answers the undefined
    // singleton — both need `__extern_is_undefined`; the legacy standalone
    // miss is a bare null. Registered at reserve time; if it is somehow
    // absent, gate on `ref.is_null` alone (under-fires on host, never wrong).
    const isUndefIdx = methodArms.length > 0 ? ctx.funcMap.get("__extern_is_undefined") : undefined;

    // (#3041) Get-accessor arms: for a getter reached via an `any` receiver the
    // value is COMPUTED by `${Class}_get_<prop>`, not stored in a slot, so
    // neither the struct-field candidates nor the method arms cover it. These
    // arms `ref.cast` the receiver to the class struct, `call` the getter, and
    // box the return up to the dispatcher's uniform externref. Enumerated at
    // fill time (funcMap/structMap read-only — no minting). They run BEFORE the
    // struct-field/host fallback so a getter shadows any host-read miss, exactly
    // as the static `compilePropertyAccess` accessor branch does.
    const accessorArms = classAccessorCandidatesForProp(ctx, propName);

    // Terminal else-arm: __extern_get(recv, "<name>") -> externref. Covers
    // genuine host externrefs and dynamic sidecar-only props.
    //
    // (#2963) With method arms: the host read runs FIRST so an OWN property
    // (sidecar write `c.m = v`, delete tombstone, accessor) keeps shadowing
    // the prototype method; only a MISS (null / undefined) falls through to
    // the receiver-typed method arms. Uses local 2 (externref scratch,
    // appended below) — the sentinel f64 scratch, when present, then shifts
    // to local 3.
    const buildMethodArmChain = (idx: number, mresLocal: number): Instr[] => {
      if (idx >= methodArms.length) return [];
      const arm = methodArms[idx]!;
      return [
        { op: "local.get", index: 1 }, // __any
        { op: "ref.test", typeIdx: arm.receiverStructTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // Lazy-init the canonical singleton (mirrors emitCachedMethodClosureAccess).
            { op: "global.get", index: arm.cacheGlobalIdx },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "ref.func", funcIdx: arm.trampIdx },
                { op: "struct.new", typeIdx: arm.closureStructTypeIdx },
                { op: "extern.convert_any" },
                { op: "global.set", index: arm.cacheGlobalIdx },
              ],
              else: [],
            },
            { op: "global.get", index: arm.cacheGlobalIdx },
            { op: "local.set", index: mresLocal },
          ],
          else: buildMethodArmChain(idx + 1, mresLocal),
        },
      ];
    };
    const buildFallbackWithMethodArms = (mresLocal: number): Instr[] => {
      const hostRead: Instr[] =
        getIdx !== undefined
          ? [
              { op: "local.get", index: 0 }, // recv
              ...stringConstantExternrefInstrs(ctx, propName),
              { op: "call", funcIdx: getIdx },
            ]
          : [{ op: "ref.null.extern" }];
      // miss = ref.is_null(v) || __extern_is_undefined(v)
      const missTest: Instr[] = [
        { op: "local.get", index: mresLocal },
        { op: "ref.is_null" },
        ...(isUndefIdx !== undefined
          ? ([
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } as ValType },
                then: [{ op: "i32.const", value: 1 }],
                else: [
                  { op: "local.get", index: mresLocal },
                  { op: "call", funcIdx: isUndefIdx },
                ],
              },
            ] satisfies Instr[])
          : []),
      ];
      return [
        ...hostRead,
        { op: "local.set", index: mresLocal },
        ...missTest,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: buildMethodArmChain(0, mresLocal),
          else: [],
        },
        { op: "local.get", index: mresLocal },
      ];
    };

    const fallback: Instr[] =
      methodArms.length > 0
        ? buildFallbackWithMethodArms(2)
        : getIdx !== undefined
          ? [
              { op: "local.get", index: 0 }, // recv
              ...stringConstantExternrefInstrs(ctx, propName),
              { op: "call", funcIdx: getIdx },
            ]
          : [{ op: "ref.null.extern" }];

    let usedSentinelBox = false;
    // (#2963) Locals layout: 1 = __any (anyref); with method arms 2 = __mres
    // (externref scratch) and any sentinel f64 scratch shifts to 3; without
    // method arms the sentinel f64 scratch keeps its legacy slot 2
    // (byte-identical for every dispatcher with no method arm).
    const f64ScratchIdx = methodArms.length > 0 ? 3 : 2;
    const buildGetDispatch = (idx: number): Instr[] => {
      if (idx >= candidates.length) return fallback;
      const cand = candidates[idx]!;
      // Read the slot, then box-coerce the field's wasm type UP to externref (the
      // dispatcher's uniform result). Via the single coercion engine (#1917 /
      // #2108) — box helpers were registered at reserve so this is funcMap-read
      // only. externref field → no-op; f64/i32 → __box_number; ref → extern.convert_any.
      //
      // (#2979) EXCEPTION — native generator IteratorResult structs: their f64
      // `value` field uses the UNDEF_F64 sentinel as the absent/done marker
      // (`g.next().value` after exhaustion is `undefined`, not a number). Box
      // sentinel-aware: sentinel → null externref (the standalone canonical
      // undefined), else __box_number. `__box_number` is a union native
      // registered at reserve time, so this stays funcMap-read-only.
      const boxNumIdx = ctx.funcMap.get("__box_number");
      const useSentinelBox =
        cand.fieldType.kind === "f64" &&
        boxNumIdx !== undefined &&
        isNativeGeneratorResultStruct(ctx, cand.structTypeIdx);
      if (useSentinelBox) usedSentinelBox = true;
      // (#3050) BOOLEAN-branded i32 field (e.g. the native generator result's
      // `done`): box via __box_boolean so `x.done === true` holds through the
      // dynamic read — the brand-blind coercion engine would `__box_number` it
      // (number 1 !== true). Mirrors coerceType's i32-brand routing; funcMap-
      // read-only (the union natives were registered at reserve).
      const boxBoolIdx =
        cand.fieldType.kind === "i32" && cand.fieldType.boolean === true ? ctx.funcMap.get("__box_boolean") : undefined;
      // (#2963) When method arms exist, local 2 is the `__mres` externref
      // scratch; the sentinel f64 scratch then lives at local 3.
      // (#3032 W6) Sentinel arm canonicalizes to the REAL host `undefined`
      // under a JS host (registered at reserve for `value` dispatchers);
      // standalone keeps the null externref (funcMap miss → default).
      const getUndefIdx = ctx.nativeStrings ? undefined : ctx.funcMap.get("__get_undefined");
      const sentinelUndefInstrs: Instr[] | undefined =
        getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx }] : undefined;
      const box: Instr[] = useSentinelBox
        ? sentinelAwareF64BoxInstrs(f64ScratchIdx, boxNumIdx, sentinelUndefInstrs)
        : boxBoolIdx !== undefined
          ? [{ op: "call", funcIdx: boxBoolIdx }]
          : coercionInstrs(ctx, cand.fieldType, { kind: "externref" });
      const readInstrs: Instr[] = [
        { op: "local.get", index: 1 }, // __any
        { op: "ref.cast", typeIdx: cand.structTypeIdx },
        { op: "struct.get", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx },
        ...box,
      ];
      return [
        { op: "local.get", index: 1 }, // __any
        { op: "ref.test", typeIdx: cand.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: readInstrs,
          else: buildGetDispatch(idx + 1),
        },
      ];
    };

    // (#3041) Get-accessor arms tried FIRST, terminating in the struct-field /
    // host-read chain. Each arm: `ref.test $Struct` → `ref.cast $Struct` →
    // `call getter` → box return up to externref. The getter's boolean-branded
    // i32 return is boxed via `__box_boolean` (mirrors the field arm) so
    // `obj.flag === true` holds through the dynamic read; all other types go
    // through the single coercion engine (funcMap-read-only — box helpers were
    // registered at reserve).
    const buildAccessorArmChain = (idx: number): Instr[] => {
      if (idx >= accessorArms.length) return buildGetDispatch(0);
      const arm = accessorArms[idx]!;
      const boxBoolIdx =
        arm.returnType.kind === "i32" && arm.returnType.boolean === true ? ctx.funcMap.get("__box_boolean") : undefined;
      const box: Instr[] =
        boxBoolIdx !== undefined
          ? [{ op: "call", funcIdx: boxBoolIdx }]
          : coercionInstrs(ctx, arm.returnType, { kind: "externref" });
      return [
        { op: "local.get", index: 1 }, // __any
        { op: "ref.test", typeIdx: arm.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } as ValType },
          then: [
            { op: "local.get", index: 1 }, // __any
            { op: "ref.cast", typeIdx: arm.structTypeIdx },
            { op: "call", funcIdx: arm.getterFuncIdx },
            ...box,
          ],
          else: buildAccessorArmChain(idx + 1),
        },
      ];
    };

    // Build the body FIRST so `usedSentinelBox` is known, then append the f64
    // scratch local (index 2) only when a (#2979) sentinel-aware gen-result arm
    // actually referenced it — keeps every dispatcher without such an arm
    // byte-identical (host mode never has gen-result structs).
    const dispatchBody: Instr[] = [
      { op: "local.get", index: 0 }, // recv (externref)
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 }, // __any
      ...buildAccessorArmChain(0),
    ];
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (methodArms.length > 0) locals.push({ name: "__mres", type: { kind: "externref" } }); // (#2963) local 2
    if (usedSentinelBox) locals.push({ name: "__f64tmp", type: { kind: "f64" } }); // local 2 legacy / 3 with arms
    dispFn.locals = locals;
    dispFn.body = dispatchBody;
  }
}
