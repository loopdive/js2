// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3468 C-core) Closure-own-property side table for `--target standalone`.
 *
 * ## The gap
 * Function objects (closures) are WasmGC structs, NOT `$Object`s, so the three
 * terminal dynamic-property helpers in `object-runtime.ts` — `__extern_set`,
 * `__extern_get`, `__extern_method_call` — all gate on `ref.test $Object(recv)`
 * and fall through to a no-op / undefined / `ref.null.extern` for a closure
 * receiver. Consequence: `f.p = v`, `f.p`, and `f.m()` are silently dropped for
 * a function value. That is why the test262 `assert` harness (a `function
 * assert(){}` whose `sameValue`/`throws`/`_isSameValue` are assigned as own
 * properties) never invokes anything under standalone — assertions become
 * vacuous passes (#3468 root cause).
 *
 * ## The fix (Approach C-core + F1 full-closure rollout)
 * Keep closures as-is and give those three dead arms a fallback: a runtime,
 * closure-identity-keyed side table mapping each property-carrying closure to a
 * fresh `$Object` "bag" that holds its own properties. The bag reuses the
 * existing `$Object` prop machinery (`__new_plain_object` + `__extern_get`/
 * `__extern_set`), so reads/writes/method-calls on a function value work exactly
 * as they do on a plain object.
 *
 * (#3468 F1, 2026-07-23 stakeholder ruling) The carrier set covers ALL closure
 * wrapper structs — including shared noncapturing wrappers, i.e. the test262
 * `function assert(){}` harness receiver. The first merged slice (#3418) had
 * deliberately narrowed carriers to capturing subtypes because enabling the
 * harness truthfully de-masks pre-existing semantic failures (assertions start
 * FIRING instead of vacuous-passing). The stakeholder ruled to land the honest
 * de-inflation: widen the carriers, measure the exposed failures from the
 * merge-group run, route them to trackers by cluster, and re-baseline the
 * standalone floor DOWN to the truthful number. Identity keying stays correct
 * for noncapturing declarations: each top-level function's wrapper struct is
 * instantiated once and reused by reference, so `ref.eq` identity holds.
 *
 * The table is a singly-linked list of `$ClosurePropEntry { next; key; bag }`
 * rooted at the module global `$__closure_prop_head`. Append = prepend (O(1));
 * lookup = walk with `ref.eq` on the closure identity. The tiny count of
 * property-carrying closures makes a list cheaper than a copy-on-grow array.
 *
 * ## Why reserve-then-fill (the funcIdx / type-completeness ordering problem)
 * The helper bodies self-call `__extern_get`/`__extern_set` on the bag, but a
 * function's own funcIdx is NOT in `funcMap` while its body is being built
 * (`registerNative` mints at registration time, after the body array is
 * constructed) — and `__is_closure_prop_carrier`'s `ref.test` chain needs the
 * COMPLETE closure base-wrapper type set, which is only known at FINALIZE
 * (`collectClosureBaseWrapperTypeIdxs`). So, exactly like `reserveApplyClosure`/
 * `fillApplyClosure` (#1888) and the accessor drivers (#1719): reserve the
 * helper funcIdxs with `unreachable` stubs at object-runtime-emit time (so the
 * `__extern_*` arms bake a stable `call <idx>`), then fill the real bodies in
 * post-processing. Routing every reference through `funcMap` keeps the
 * late-import index shifter (#329/#1899) in sync.
 *
 * ## Byte-neutrality
 * Everything here is gated on `ctx.standalone || ctx.wasi`. In gc/host mode the
 * `env::__extern_*` host imports own the dynamic-property path — the defined
 * `__extern_*` bodies (and therefore these helpers) are never emitted — so the
 * gc/host output stays byte-identical.
 *
 * ## No throws (S1 discipline)
 * C-core is deliberately throw-free (like `__apply_closure` S1) so it pulls no
 * late error machinery (`__new_TypeError` + exn tag + string constants) into the
 * object runtime, avoiding the #1839/#117/#1886 late-registration index-shift
 * trap.
 */
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import { closurePrototypeEdgeGetArm } from "./closure-prototype-edge.js"; // (#2660 M3)
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { protoIndexRecvGetMissInstrs } from "./proto-index-store.js"; // (#4176) inherited proto-named consult
import { INSTANCE_BAG_FIELD } from "./closures/closure-header-layout.js"; // (#4241) one spelling of the slot name
import { addFuncType } from "./registry/types.js";

/** WasmGC `eq` abstract heap type (used for `ref.cast`/`ref.null` to eqref). */
const EQ_HEAP_TYPE = -19;

/** Reserved helper names (all internal, non-exported). */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
const CLOSURE_BAG_ENSURE = "__closure_bag_ensure";
const CLOSURE_PROP_GET = "__closure_prop_get";
const CLOSURE_PROP_SET = "__closure_prop_set";
const CLOSURE_METHOD_CALL = "__closure_method_call";

/** $ClosurePropEntry field indices. */
const F_NEXT = 0;
const F_KEY = 1;
const F_BAG = 2;

/**
 * (#4241) The carrier-intrinsic `$bag` slot name — see `closureBagField()` in
 * `closures/funcref-wrapper-types.js`. Resolved by NAME (the `$shape` idiom),
 * never by a baked index, so a later header change cannot silently misread it.
 */
const BAG_SLOT_FIELD = INSTANCE_BAG_FIELD;

/**
 * (#4241) The carrier roots that carry an intrinsic `$bag` slot, paired with
 * that slot's field index.
 *
 * Splitting the carrier set into SLOTTED and SLOTLESS is the whole fix. A
 * slotted carrier answers `__closure_bag_lookup` with one `struct.get` and
 * never enters the `$ClosurePropEntry` registry at all; a slotless one keeps
 * the original linear registry walk. Measured on the acorn standalone
 * self-parse before this change: 39,455 lookups/parse, every one of them a
 * full `ref.eq` walk of a list that grows ~75 entries per parse and is never
 * pruned — quadratic over a session, and a leak (the registry pinned every
 * carrier that ever grew a bag).
 *
 * Resolution is by FIELD NAME on the type table, so a root that did not get
 * the slot (e.g. the runtime-eval AOT callable carrier, or a bare
 * `__StandaloneRegExp`) is automatically routed to the registry rather than
 * mis-read at a wrong index.
 */
function slottedCarrierRoots(ctx: CodegenContext, carrierTypeIdxs: number[]): { typeIdx: number; bagIdx: number }[] {
  const out: { typeIdx: number; bagIdx: number }[] = [];
  for (const typeIdx of carrierTypeIdxs) {
    const def = ctx.mod.types[typeIdx];
    if (!def || def.kind !== "struct") continue;
    const bagIdx = def.fields.findIndex((f) => f?.name === BAG_SLOT_FIELD);
    if (bagIdx >= 0) out.push({ typeIdx, bagIdx });
  }
  return out;
}

/**
 * (#4241 step 1b) Registered user-declared structs bearing an intrinsic `$bag`.
 *
 * Deliberately derived from `ctx.structFields` + the `$bag` FIELD NAME rather
 * than from an imported "which carriers got a slot" list: the producer
 * (`linear-type-reservations.ts`) and this consumer would then state the
 * eligibility rule twice, and a private second copy of a layout fact is
 * precisely the defect class that broke the IR wrapper-root validator and cost
 * a merge-queue round on this same issue. One fact, read where it lives.
 */
function slottedInstanceCarrierRoots(ctx: CodegenContext): { typeIdx: number; bagIdx: number }[] {
  const out: { typeIdx: number; bagIdx: number }[] = [];
  const seen = new Set<number>();
  for (const [structName, fields] of ctx.structFields) {
    const bagIdx = fields.findIndex((f) => f?.name === BAG_SLOT_FIELD);
    if (bagIdx < 0) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || seen.has(typeIdx)) continue;
    seen.add(typeIdx);
    out.push({ typeIdx, bagIdx });
  }
  return out;
}

/** Build `__extern_get`'s non-object receiver arm. */
export function buildClosurePropGetMissArm(ctx: CodegenContext, getMiss: () => Instr[]): Instr[] {
  const closurePropGetIdx = ctx.funcMap.get(CLOSURE_PROP_GET);
  return closurePropGetIdx === undefined
    ? [...getMiss(), { op: "return" }]
    : [
        { op: "local.get", index: 0 }, // obj
        { op: "local.get", index: 1 }, // key
        { op: "call", funcIdx: closurePropGetIdx },
        { op: "return" },
      ];
}

/** Build `__extern_set`'s non-object receiver arm. */
export function buildClosurePropSetMissArm(ctx: CodegenContext): Instr[] {
  const closurePropSetIdx = ctx.funcMap.get(CLOSURE_PROP_SET);
  // #4504 installs a final native-companion decision tail after this arm.
  // Keep the historical unconditional terminal miss in flag-clear modules,
  // but let a non-closure receiver fall through to that tail when the shared
  // result channel is active (Date/Number and other no-bag carriers still
  // have an inherited descriptor chain).
  if (ctx.externSetResultGlobalIdx !== undefined) {
    const isClosurePropCarrierIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
    if (closurePropSetIdx === undefined || isClosurePropCarrierIdx === undefined) return [];
    return [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosurePropCarrierIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: closurePropSetIdx },
          { op: "return" },
        ],
      },
    ];
  }
  return closurePropSetIdx === undefined
    ? [{ op: "return" }]
    : [
        { op: "local.get", index: 0 }, // obj
        { op: "local.get", index: 1 }, // key
        { op: "local.get", index: 2 }, // value
        { op: "call", funcIdx: closurePropSetIdx },
        { op: "return" },
      ];
}

/** Build `__extern_method_call`'s non-object receiver arm. */
export function buildClosurePropMethodCallElseArm(
  ctx: CodegenContext,
  externGetIdx: number,
  applyClosureIdx: number,
  // (#4221) See `buildVecOrClosurePropMethodCallElseArm` — the absent-callee
  // TypeError guard, threaded through to the terminal miss arm.
  absentCalleeGuard: () => Instr[] = () => [],
): Instr[] {
  const isClosurePropCarrierIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  if (isClosurePropCarrierIdx === undefined) {
    return [{ op: "ref.null.extern" }, ...absentCalleeGuard()];
  }
  // (#3673) Prefer the reserved `__closure_method_call` helper: it keeps the
  // own-property route below AND adds the %Function.prototype%
  // `call`/`apply` builtins, which a bare own-property lookup can never find
  // on a WasmGC closure. It needs its own locals, hence a helper rather than
  // inline instructions (this arm is spliced into `__extern_method_call`,
  // whose local list is fixed by its own registration site).
  const closureMethodCallIdx = ctx.funcMap.get(CLOSURE_METHOD_CALL);
  return [
    { op: "local.get", index: 0 }, // recv
    { op: "call", funcIdx: isClosurePropCarrierIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      else: buildProtoNamedMethodMissArm(ctx, applyClosureIdx, absentCalleeGuard),
      then:
        closureMethodCallIdx !== undefined
          ? ([
              { op: "local.get", index: 0 }, // recv
              { op: "local.get", index: 1 }, // name
              { op: "local.get", index: 2 }, // args
              { op: "call", funcIdx: closureMethodCallIdx },
            ] satisfies Instr[])
          : ([
              { op: "local.get", index: 0 }, // recv
              { op: "local.get", index: 1 }, // name
              { op: "call", funcIdx: externGetIdx },
              ...(ctx.funcMap.has("__nullish_to_null")
                ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
                : []),
              { op: "local.get", index: 0 }, // thisArg
              { op: "local.get", index: 2 }, // args
              { op: "call", funcIdx: applyClosureIdx },
            ] satisfies Instr[]),
    },
  ];
}

/**
 * (#4207) `__extern_method_call`'s TERMINAL miss — the receiver is neither a
 * `$Object`, nor a vec, nor a closure carrier, i.e. a **bare primitive**
 * (a boxed number/boolean or a native string that never went through
 * `ToObject`). That arm returned the undefined sentinel unconditionally, so an
 * inherited method installed on the receiver's wrapper prototype was invisible:
 *
 * ```js
 * Number.prototype.zz = function () { return 42; };
 * (5).zz();          // measured: null. Also null for a plain user function,
 *                    // so this is a prototype-chain gap, not a `this` gap.
 * Object.prototype.exec = RegExp.prototype.exec;
 * (1.0).exec("m");   // must be TypeError; measured: null
 * ```
 *
 * The #4176 proto-property store already holds those writes and already exposes
 * a receiver-aware consult (`__protoidx_get_r`); the primitive-receiver call
 * site was simply never wired to it. Consulting it here reuses the whole
 * existing chain (own brand first, then `Object.prototype`) and hands the
 * result to `__apply_closure` with the ORIGINAL receiver as `this` — which is
 * what makes a *transferred* builtin method behave: the #3992 native-proto arm
 * inside `__call_fn_method_N` threads that receiver into the closure's `this`
 * param, so `RegExp.prototype.exec` runs its brand check and
 * `String.prototype.toLowerCase` runs `ToString(this)`.
 *
 * No null test is needed: a miss answers the undefined sentinel and
 * `__apply_closure`'s not-a-function path already returns undefined (the vec
 * arm in vec-props.ts relies on the same contract). When the store is
 * unreserved — every module that never writes a named property onto a builtin
 * prototype — this returns `undefined` and the caller keeps its exact previous
 * `ref.null.extern`, so the emission is byte-identical for those modules.
 */
function buildProtoNamedMethodMissArm(
  ctx: CodegenContext,
  applyClosureIdx: number,
  // (#4221) `__extern_method_call`'s absent-callee TypeError guard. This arm is
  // the LAST word on `recv.<name>(…)` for a receiver the runtime models fully
  // (a fnctor/class instance, a bare primitive): reaching its end with nothing
  // resolved means the property is genuinely absent, and §13.3.6.2 step 5 says
  // that is a TypeError — not `undefined`. It used to answer the undefined
  // sentinel, which is why
  //
  //     function FACTORY(){ this.id = 0; this.id = this.func();
  //                         function func(){ return "id_string"; } }
  //     new FACTORY();      // must throw; completed normally (S13.2.2_A11)
  //
  // constructed successfully. Empty off the standalone lane (a JS host throws
  // on its own), so the gc lane is byte-identical.
  absentCalleeGuard: () => Instr[] = () => [],
): Instr[] {
  const consult = protoIndexRecvGetMissInstrs(ctx, 0, 1);
  if (!consult) return [{ op: "ref.null.extern" }, ...absentCalleeGuard()];
  return [
    ...consult,
    ...(ctx.funcMap.has("__nullish_to_null")
      ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
      : []),
    ...absentCalleeGuard(),
    { op: "local.get", index: 0 }, // thisArg — the ORIGINAL primitive receiver
    { op: "local.get", index: 2 }, // args
    { op: "call", funcIdx: applyClosureIdx },
  ];
}

/**
 * Register the `$ClosurePropEntry` struct type + `$__closure_prop_head` global
 * and reserve the closure-own-property helper placeholders. Called from
 * `ensureObjectRuntime`'s type section under `ctx.standalone || ctx.wasi`,
 * BEFORE the `__extern_get`/`__extern_set`/`__extern_method_call` bodies bake
 * their `call <idx>`. Idempotent (guards on `ctx.closurePropHelpersReserved`).
 *
 * The struct type is appended at `ctx.mod.types.length`, so it never shifts an
 * existing type index. The func placeholders are appended at the current
 * end of the function space, so they never shift an existing funcIdx either.
 */
export function reserveClosurePropHelpers(ctx: CodegenContext): void {
  if (ctx.closurePropHelpersReserved) return;

  // --- $ClosurePropEntry struct: { next: (ref null self); key: eqref; bag: externref } ---
  const entryTypeIdx = ctx.mod.types.length;
  const entryFields: FieldDef[] = [
    // next — immutable; a prepend creates a NEW head whose next = old head, so
    // existing entries' `next` never changes (no struct.set anywhere).
    { name: "next", type: { kind: "ref_null", typeIdx: entryTypeIdx }, mutable: false },
    // key — the closure identity, narrowed to eqref via `ref.cast eq`. Compared
    // with `ref.eq` at lookup. Same struct ref at set-site and get-site ⇒ match.
    { name: "key", type: { kind: "eqref" }, mutable: false },
    // bag — the per-closure own-property `$Object`, wrapped to externref.
    { name: "bag", type: { kind: "externref" }, mutable: false },
  ];
  ctx.mod.types.push({ kind: "struct", name: "$ClosurePropEntry", fields: entryFields });
  ctx.closurePropEntryTypeIdx = entryTypeIdx;

  // --- $__closure_prop_head : (mut ref null $ClosurePropEntry) = ref.null ---
  const headGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "$__closure_prop_head",
    type: { kind: "ref_null", typeIdx: entryTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: entryTypeIdx }],
  });
  ctx.closurePropHeadGlobalIdx = headGlobalIdx;

  // --- Reserve the helper placeholders (filled by fillClosurePropHelpers) ---
  const reserve = (name: string, params: ValType[], results: ValType[]): void => {
    if (ctx.funcMap.get(name) !== undefined) return;
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = {
      name,
      typeIdx,
      locals: [],
      // Placeholder; filled at FINALIZE. A bare `unreachable` is a valid stub for
      // any result type if the fill is ever skipped.
      body: [{ op: "unreachable" }],
      exported: false,
    };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
  };

  const externref: ValType = { kind: "externref" };
  reserve(IS_CLOSURE_PROP_CARRIER, [externref], [{ kind: "i32" }]);
  reserve(CLOSURE_BAG_LOOKUP, [externref], [externref]);
  reserve(CLOSURE_BAG_ENSURE, [externref], [externref]);
  reserve(CLOSURE_PROP_GET, [externref, externref], [externref]);
  reserve(CLOSURE_PROP_SET, [externref, externref, externref], []);
  reserve(CLOSURE_METHOD_CALL, [externref, externref, externref], [externref]);

  ctx.closurePropHelpersReserved = true;
}

/**
 * (#4008) Standalone BUILTIN-INSTANCE carriers for the same identity-keyed
 * side table.
 *
 * `new RegExp()` / `new Date()` are lowered to dedicated WasmGC structs
 * (`__StandaloneRegExp`, `__Date`), not `$Object`s — so, exactly like a
 * closure before #3468, `d.foo = 1` fell off the end of `__extern_set`'s
 * `ref.test $Object` gate and `d.foo` read back `undefined`. Measured
 * 2026-08-06 under `--target standalone`: expando write-then-read works on a
 * plain object, array, function, Arguments object and every primitive
 * wrapper, and is silently dropped on exactly RegExp and Date.
 *
 * That is a general expando gap, but the reason it is being closed HERE is
 * ES §6.2.5.6: test262 spells "an arbitrary object used as a property
 * descriptor" as `var regObj = new RegExp(); regObj.enumerable = true;
 * Object.defineProperty(obj, "p", regObj)`. ToPropertyDescriptor then reads
 * the field through the same `__extern_has`/`__extern_get` pair, so a
 * descriptor built on one of these objects came out empty and
 * CompletePropertyDescriptor filled in all-false defaults — silently, with no
 * refusal.
 *
 * The bag itself needs no change: it is keyed by `ref.eq` on the carrier's
 * identity, which any GC struct satisfies. Only the `ref.test` gate was
 * closure-shaped.
 *
 * Deliberately a NAMED, CLOSED list rather than "every non-`$Object` struct".
 * Two exclusions are load-bearing:
 *   - the vec/`$Vec` carriers own a separate overlay (#3537/#4010/#3251) whose
 *     numeric keys are array ELEMENTS, not bag entries;
 *   - `$Error_struct` has its own `$props` side-slot (fieldIdx 5, #2101a R5)
 *     that the externref-backed-subclass own-field path writes directly, so
 *     bagging it would give one receiver two disagreeing stores.
 * Types absent from the module are skipped, so a program that never
 * constructs a Date emits the identical `ref.test` chain as before.
 */
function builtinInstanceCarrierTypeIdxs(ctx: CodegenContext): number[] {
  const out: number[] = [];
  for (const name of ["__StandaloneRegExp", "__Date"]) {
    const idx = ctx.structMap.get(name);
    if (idx !== undefined) out.push(idx);
  }
  return out;
}

/**
 * (#4241) Fill the two carrier-bag natives — `__closure_bag_lookup` and
 * `__closure_bag_ensure`.
 *
 * Split out of `fillClosurePropHelpers` when the `$bag` slot pushed that
 * function past the 300-LOC per-function ceiling (#3400). The seam is the
 * natural one: everything here is the BAG STORAGE question (where does a
 * carrier's own-property `$Object` live), while the caller keeps the
 * PROPERTY-ACCESS question (get / set / method-call routing on a closure
 * receiver). The two bag natives share the registry-walk locals and the
 * slotted-carrier arm list, and nothing else in the caller reads them.
 *
 * Both bodies are swapped in place under their reserved names, so every
 * consumer — instance-props, carrier-bag-{hasown,define,delete,visibility},
 * instance-tombstones, object-integrity-carrier, closed-struct-extern-set —
 * inherits the slot through the helper NAME, with no call-site edits.
 */
function fillCarrierBagHelpers(
  ctx: CodegenContext,
  opts: {
    entryTypeIdx: number;
    headGlobalIdx: number;
    newPlainObjectIdx: number | undefined;
    slotted: { typeIdx: number; bagIdx: number }[];
    setBody: (name: string, locals: { name: string; type: ValType }[], body: Instr[]) => void;
  },
): void {
  const { entryTypeIdx, headGlobalIdx, newPlainObjectIdx, slotted, setBody } = opts;
  // ── __closure_bag_lookup(externref recv) -> externref ──
  // Walk the list; on `ref.eq(entry.key, recv-as-eqref)` return entry.bag; on
  // end-of-list return the undefined externref. Read-only (never creates).
  // Locals: 1 = recvEq (eqref), 2 = cur (ref null $ClosurePropEntry).
  const walkLocals: { name: string; type: ValType }[] = [
    { name: "__recvEq", type: { kind: "eqref" } },
    { name: "__cur", type: { kind: "ref_null", typeIdx: entryTypeIdx } },
  ];
  // Inside the loop body: depth 0 = the `loop`, depth 1 = the enclosing `block`.
  const walkLoop = (onHit: Instr[]): Instr => ({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: 2 },
          { op: "ref.is_null" },
          { op: "br_if", depth: 1 }, // cur == null → exit block
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_KEY },
          { op: "local.get", index: 1 }, // recvEq
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: onHit },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_NEXT },
          { op: "local.set", index: 2 },
          { op: "br", depth: 0 }, // continue loop
        ],
      },
    ],
  });
  const narrowRecvToEq: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: EQ_HEAP_TYPE }, // recv is a closure struct ⇒ safe
    { op: "local.set", index: 1 },
    { op: "global.get", index: headGlobalIdx },
    { op: "local.set", index: 2 },
  ];
  //
  // (#4241) The SLOTTED arms run first and are terminal: one `ref.test` on the
  // carrier ROOT (which matches every capturing subtype), one `ref.cast`, one
  // `struct.get $bag`, `return`. A carrier with no expandos reads back the null
  // the slot was born with — the "no-bag consult is ~free" fast path, and the
  // 39,455-consults-per-parse case. The registry walk survives ONLY for
  // slotless carriers (class / fnctor instances, whose slot is a follow-up
  // slice, plus RegExp/Date and the runtime-eval AOT carrier).
  //
  // Emitting the slotted arms in `__closure_bag_lookup` itself — rather than at
  // its ~340 call sites — is deliberate: every consumer (instance-props,
  // carrier-bag-{hasown,define,delete,visibility}, instance-tombstones,
  // object-integrity-carrier, closed-struct-extern-set) inherits the fix
  // through the helper NAME, with zero call-site edits and no chance of one
  // surface disagreeing with another about where a bag lives.
  const slottedLookupArms = (): Instr[] => {
    const arms: Instr[] = [];
    for (const { typeIdx, bagIdx } of slotted) {
      arms.push(
        { op: "local.get", index: 3 }, // recvAny
        { op: "ref.test", typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 3 },
            { op: "ref.cast", typeIdx },
            { op: "struct.get", typeIdx, fieldIdx: bagIdx },
            { op: "return" },
          ],
        },
      );
    }
    return arms;
  };
  {
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    const body: Instr[] = [
      // recvAny is shared by the slotted arms; the registry walk keeps its own
      // eqref narrowing (a `ref.cast eq` would trap on a non-eq carrier, so it
      // must stay AFTER the slotted arms have taken their receivers out).
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 3 },
      ...slottedLookupArms(),
      ...narrowRecvToEq,
      walkLoop(onHit),
      { op: "ref.null.extern" },
    ];
    setBody(CLOSURE_BAG_LOOKUP, [...walkLocals, { name: "__recvAny", type: { kind: "anyref" } }], body);
  }

  // ── __closure_bag_ensure(externref recv) -> externref ──
  // As lookup; on miss allocate a fresh `$Object` bag, prepend a new entry,
  // update the head, and return the bag. Locals: 1 = recvEq, 2 = cur, 3 = bag.
  //
  // (#4241) Slotted carriers store the bag IN the receiver: read the slot, and
  // on null allocate once and `struct.set` it. The bag then dies with its
  // carrier — which is the memory-correctness half of this change, since the
  // registry never removed an entry and so pinned every carrier that ever grew
  // a property for the module's lifetime.
  //
  // Query-never-allocates (`carrier-bag-hasown.ts`) is preserved structurally:
  // only ENSURE writes the slot; LOOKUP is a pure read.
  if (newPlainObjectIdx !== undefined) {
    const ensureLocals: { name: string; type: ValType }[] = [
      ...walkLocals,
      { name: "__bag", type: { kind: "externref" } },
      { name: "__recvAny", type: { kind: "anyref" } },
    ];
    const RECV_ANY = 4;
    const slottedEnsureArms = (): Instr[] => {
      const arms: Instr[] = [];
      for (const { typeIdx, bagIdx } of slotted) {
        arms.push(
          { op: "local.get", index: RECV_ANY },
          { op: "ref.test", typeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: RECV_ANY },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx: bagIdx },
              { op: "local.tee", index: 3 },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: RECV_ANY },
                  { op: "ref.cast", typeIdx },
                  { op: "call", funcIdx: newPlainObjectIdx },
                  { op: "local.tee", index: 3 },
                  { op: "struct.set", typeIdx, fieldIdx: bagIdx },
                ],
              },
              { op: "local.get", index: 3 },
              { op: "return" },
            ],
          },
        );
      }
      return arms;
    };
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: RECV_ANY },
      ...slottedEnsureArms(),
      ...narrowRecvToEq,
      walkLoop(onHit),
      // miss: bag = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 3 },
      // head = struct.new $ClosurePropEntry { next: head, key: recvEq, bag: bag }
      { op: "global.get", index: headGlobalIdx }, // next
      { op: "local.get", index: 1 }, // key (recvEq)
      { op: "local.get", index: 3 }, // bag
      { op: "struct.new", typeIdx: entryTypeIdx },
      { op: "global.set", index: headGlobalIdx },
      { op: "local.get", index: 3 }, // return bag
    ];
    setBody(CLOSURE_BAG_ENSURE, ensureLocals, body);
  }
}

/**
 * Fill the reserved closure-own-property helper bodies at FINALIZE, after
 * every closure root is registered and `__extern_get`/`__extern_set`/
 * `__new_plain_object` are in `funcMap`. No-op when the helpers were never
 * reserved (gc/host mode). Mirrors `fillApplyClosure`.
 */
export function fillClosurePropHelpers(ctx: CodegenContext): void {
  if (!ctx.closurePropHelpersReserved) return;

  const entryTypeIdx = ctx.closurePropEntryTypeIdx;
  const headGlobalIdx = ctx.closurePropHeadGlobalIdx;
  if (entryTypeIdx === undefined || headGlobalIdx === undefined) return;

  const isClosureIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const bagLookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const bagEnsureIdx = ctx.funcMap.get(CLOSURE_BAG_ENSURE);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const setDecideIdx = ctx.funcMap.get("__extern_set_decide");
  const setOwnIdx = ctx.funcMap.get("__extern_set_own");
  const setResultGlobalIdx = ctx.externSetResultGlobalIdx;

  const setBody = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };

  // The undefined-read sentinel, matching `__extern_get`'s `getMiss()` factory
  // (a fresh array each call — shared Instr objects get double-remapped by
  // finalize walks; see reference_shared_instr_object_dce_double_remap).
  const getMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];

  // (#4241) Computed once and shared by the carrier predicate and BOTH bag
  // helpers, so the slotted/slotless split cannot drift between them.
  const carrierTypeIdxs = [...collectClosureBaseWrapperTypeIdxs(ctx), ...builtinInstanceCarrierTypeIdxs(ctx)];
  const slotted = [
    ...slottedCarrierRoots(ctx, carrierTypeIdxs),
    // (#4241 step 1b) Instance carriers that were given an intrinsic `$bag` at
    // struct-registration time. Discovered by FIELD NAME over the registered
    // struct set rather than by an imported carrier list, so the two families
    // cannot drift apart and a carrier that did not get a slot (split fnctor,
    // cold-tailed fnctor, any class hierarchy) is automatically routed to the
    // registry instead of being mis-read at a wrong index.
    ...slottedInstanceCarrierRoots(ctx),
  ];

  // ── __is_closure_prop_carrier(externref value) -> i32 ──
  // (#3468 F1) ref.test chain over the closure BASE-wrapper types (same set as
  // `__is_closure`/`__typeof_function` via `collectClosureBaseWrapperTypeIdxs`);
  // a base-root test also matches every capturing subtype instance, so this
  // subsumes the previously narrowed capturing-only carrier set. This is the
  // stakeholder-ruled widening that lets shared noncapturing wrappers — the
  // test262 `assert` harness receiver — carry own properties, which makes the
  // harness assertions FIRE (honest floor de-inflation; see the issue file).
  // Constant 0 when the module has no closures.
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 }, // __any
    ];
    for (const carrierIdx of carrierTypeIdxs) {
      body.push({ op: "local.get", index: 1 });
      body.push({ op: "ref.test", typeIdx: carrierIdx });
      body.push({ op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] });
    }
    body.push({ op: "i32.const", value: 0 });
    setBody(IS_CLOSURE_PROP_CARRIER, [{ name: "__any", type: { kind: "anyref" } }], body);
  }

  fillCarrierBagHelpers(ctx, { entryTypeIdx, headGlobalIdx, newPlainObjectIdx, slotted, setBody });

  // ── __closure_prop_get(externref obj, externref key) -> externref ──
  // if is_closure(obj) { bag = lookup(obj); if bag != null return __extern_get(bag,key) }
  // ; return getMiss()  (the same undefined-read sentinel __extern_get uses)
  //
  // (#4176) The final miss consults the proto-property companions RECEIVER-
  // AWARE (`__protoidx_get_r`: closure ⇒ Function.prototype's companion, then
  // Object.prototype's) — `Function.prototype.value = "x"; funObj.value` is
  // the §8.10.5 inherited-descriptor-field idiom. The builder returns
  // `undefined` unless the store was reserved, so a flag-clear module keeps
  // this body byte-identical.
  if (isClosureIdx !== undefined && bagLookupIdx !== undefined && externGetIdx !== undefined) {
    // (#2660 M3) Empty for every module with no function-value → prototype edge,
    // which keeps both the body AND the local list byte-identical there.
    const protoEdgeArm = closurePrototypeEdgeGetArm(ctx, { recvSlot: 0, keySlot: 1, bagSlot: 2, protoSlot: 3 });
    // (#4479) ACCESSOR `this` on a carrier own-property. The bag is an internal
    // `$Object` standing in for the carrier's own-property table, so a plain
    // `__extern_get(bag, key)` invoked a stored getter with `this` = **the
    // bag** — an object the program can never name. §6.2.5.5 Get binds the
    // ORIGINAL receiver, and `__extern_get` already honours an explicit one
    // through the `__reflect_get_receiver(target, key, receiver)` wrapper
    // (§28.1.5), which saves/restores the receiver globals around the call.
    // Route the bag read through it with the carrier as receiver.
    //
    // Measured on this branch's base with `.tmp/run-src.mts` (real
    // `runTest262File`, `--target standalone`):
    //   `props = new Date(0)` + `defineProperty(props,"prop",{get(){seen=this}})`
    //   + `Object.create({}, props)`  →  base: `seen !== props`; after: equal.
    // The plain-`{}` Properties spelling never had the bug (it is a `$Object`,
    // so it never reaches this helper), which is exactly the asymmetry the
    // §15.2.3.5-4-* / §15.2.3.7-5-* "Properties is a <builtin> object" rows
    // assert with `result = this instanceof Date`.
    //
    // DATA properties are unaffected: the receiver override is consumed by
    // `__extern_get` only on the accessor arm. When `__reflect_get_receiver`
    // is absent (host/gc lanes register it too, but a stripped module may not)
    // the emitted body stays byte-identical to the pre-#4479 one.
    const reflectGetReceiverIdx = ctx.funcMap.get("__reflect_get_receiver");
    const bagRead: Instr[] =
      reflectGetReceiverIdx !== undefined
        ? [
            { op: "local.get", index: 2 }, // bag (target)
            { op: "local.get", index: 1 }, // key
            { op: "local.get", index: 0 }, // receiver = the carrier itself
            { op: "call", funcIdx: reflectGetReceiverIdx },
          ]
        : [
            { op: "local.get", index: 2 }, // bag
            { op: "local.get", index: 1 }, // key
            { op: "call", funcIdx: externGetIdx },
          ];
    // (#4563) The bag answer is only authoritative for a key the bag OWNS.
    //
    // The read below used to `return` unconditionally once the bag was non-null,
    // so the first own property defined on ANY callable carrier — a closure or
    // a `$__bound_fn` — permanently shadowed the §8.10.5 inherited-property
    // fallback two lines down. Measured, standalone:
    //
    //     var b = foo.bind({});
    //     Function.prototype.p1 = 12;
    //     b.p1                                   // 12   (bag still null)
    //     Object.defineProperty(b, "zz", {value: 1, configurable: true});
    //     b.p1                                   // was undefined — want 12
    //
    // An ordinary object with a prototype keeps inheriting through the same
    // sequence, which is what isolates this to the carrier bag rather than to
    // the define. It is also why the bound-function `length`/`name` seed
    // (§20.2.3.2) could not land: seeding those own properties put every bound
    // function into this state.
    //
    // The discriminator has to be `hasOwn` on the bag, NOT "is the read
    // undefined": a bag entry whose stored value IS `undefined` is a real own
    // property and must win over the prototype, exactly as `f.prototype =
    // undefined` already does through `protoEdgeArm` above.
    //
    // Without the predicate the emitted body is byte-identical to the pre-#4563
    // one, so a module that cannot resolve it keeps today's answer.
    const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
    const bagOwnGuardedRead: Instr[] =
      hasOwnIdx === undefined
        ? [...bagRead, { op: "return" }]
        : [
            { op: "local.get", index: 2 }, // bag
            { op: "local.get", index: 1 }, // key
            { op: "call", funcIdx: hasOwnIdx },
            { op: "if", blockType: { kind: "empty" }, then: [...bagRead, { op: "return" }] },
          ];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosureIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // (#2660 M3) The function-value → prototype-object edge, consulted
          // BEFORE the bag read but only for the key `prototype`, and only when
          // the bag holds no OWN entry for it. Precedence is the spec's: an
          // explicit `f.prototype = …` (which lands in the bag, including
          // `= undefined`) always wins over the compile-time prototype object.
          // Emits NOTHING when the module has no edges, so `__closure_prop_get`
          // stays byte-identical for every module without a user constructor.
          ...protoEdgeArm,
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: bagLookupIdx },
          { op: "local.tee", index: 2 }, // bag
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: bagOwnGuardedRead,
          },
        ],
      },
      ...(protoIndexRecvGetMissInstrs(ctx, 0, 1) ?? getMiss()),
    ];
    setBody(
      CLOSURE_PROP_GET,
      protoEdgeArm.length === 0
        ? [{ name: "__bag", type: { kind: "externref" } }]
        : [
            { name: "__bag", type: { kind: "externref" } },
            { name: "__protoEdge", type: { kind: "externref" } },
          ],
      body,
    );
  } else {
    // Deps absent — keep a valid body: always return the undefined sentinel.
    setBody(CLOSURE_PROP_GET, [], [...getMiss()]);
  }

  // ── __closure_prop_set(externref obj, externref key, externref value) -> () ──
  // Look up an existing bag before the inherited resolver; only MISS/ALLOW
  // reaches ensure + the direct own write.  Calling __extern_set on the bag
  // would restart a prototype walk with the bag as `this`.
  if (isClosureIdx !== undefined && bagEnsureIdx !== undefined && externSetIdx !== undefined) {
    const sharedSetAvailable =
      bagLookupIdx !== undefined &&
      setDecideIdx !== undefined &&
      setOwnIdx !== undefined &&
      setResultGlobalIdx !== undefined;
    const body: Instr[] = sharedSetAvailable
      ? [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: isClosureIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: bagLookupIdx! },
              { op: "local.set", index: 3 },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: setDecideIdx! },
              { op: "local.tee", index: 4 },
              { op: "i32.const", value: 2 }, // SET_DECISION_HANDLED
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "i32.const", value: 1 },
                  { op: "global.set", index: setResultGlobalIdx! },
                  { op: "return" },
                ],
              },
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 3 }, // SET_DECISION_REFUSED
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "i32.const", value: 2 },
                  { op: "global.set", index: setResultGlobalIdx! },
                  { op: "return" },
                ],
              },
              { op: "local.get", index: 3 },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "call", funcIdx: bagEnsureIdx },
                  { op: "local.set", index: 3 },
                ],
              },
              { op: "local.get", index: 3 },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                // A missing side-bag allocation is an unadmitted
                // representation boundary, not an OrdinarySet refusal.
                then: [{ op: "return" }],
              },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: setOwnIdx! },
              { op: "global.set", index: setResultGlobalIdx! },
            ],
          },
        ]
      : [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: isClosureIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: bagEnsureIdx }, // -> bag externref
              { op: "local.get", index: 1 }, // key
              { op: "local.get", index: 2 }, // value
              { op: "call", funcIdx: externSetIdx }, // __extern_set(bag,key,value) -> ()
            ],
          },
        ];
    setBody(
      CLOSURE_PROP_SET,
      sharedSetAvailable
        ? [
            { name: "__bag", type: { kind: "externref" } },
            { name: "__decision", type: { kind: "i32" } },
          ]
        : [],
      body,
    );
  } else {
    // Deps absent — keep a valid empty body (void result).
    setBody(CLOSURE_PROP_SET, [], []);
  }

  fillClosureMethodCall(ctx, setBody, externGetIdx);
}

/**
 * (#3673) Fill `__closure_method_call(externref fn, externref name,
 * externref args) -> externref` — method dispatch when the RECEIVER is a
 * closure (a function object).
 *
 * Two routes, in spec precedence order (§10.2 ordinary [[Get]] then
 * %Function.prototype%):
 *
 *  1. An own property in the closure's side bag (`fn.myTag = () => …`) wins —
 *     the pre-existing behaviour, preserved verbatim.
 *  2. Otherwise `call`/`apply` resolve to the %Function.prototype% builtins
 *     (§20.2.3.3 / §20.2.3.1) and invoke the RECEIVER itself:
 *       `fn.call(thisArg, a, b)`   → __apply_closure(fn, thisArg, [a, b])
 *       `fn.apply(thisArg, argArr)`→ __apply_closure(fn, thisArg, argArr)
 *
 * Before this, route 1 was the only route: `.call` on a WasmGC closure looked
 * for an own property literally named "call", found nothing, and the whole
 * call evaluated to undefined. Any dynamically-dispatched `fn.call(...)` —
 * where `fn` is a parameter or field, so the static `.call` rewrites in
 * `calls.ts` cannot fire — silently produced undefined instead of invoking
 * the function. (Found via compiled acorn: `afterLeftParse.call(this, left,
 * …)` in `parseMaybeAssign` returned undefined, so every parenthesized
 * destructuring assignment — `({a} = b)` — crashed on the next line.)
 *
 * The method name is matched by `ref.eq` against the INTERNED literal (#3673
 * round 2), the same identity test the string-receiver fast path in
 * `__extern_method_call` uses. A name that is not the interned literal (a
 * rope, a runtime-built string) simply misses and falls through to the
 * undefined result — i.e. exactly today's behaviour, never worse.
 *
 * Throw-free, matching the C-core discipline of this module: an arity or
 * carrier shape the helper cannot handle returns the undefined sentinel
 * rather than pulling the late error machinery (and its index-shift hazard)
 * into the object runtime.
 */
function fillClosureMethodCall(
  ctx: CodegenContext,
  setBody: (name: string, locals: { name: string; type: ValType }[], body: Instr[]) => void,
  externGetIdx: number | undefined,
): void {
  if (ctx.funcMap.get(CLOSURE_METHOD_CALL) === undefined) return;

  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const objVecArrTypeIdx = ctx.objectRuntimeTypes?.objVecArrTypeIdx;
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;

  const undef = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];

  // Own-property route (route 1) — the legacy body, and the fallback shape
  // when any builtin-route dependency is missing.
  const ownPropRoute = (): Instr[] =>
    externGetIdx === undefined || applyClosureIdx === undefined
      ? undef()
      : [
          { op: "local.get", index: 0 }, // fn
          { op: "local.get", index: 1 }, // name
          { op: "call", funcIdx: externGetIdx },
          ...(ctx.funcMap.has("__nullish_to_null")
            ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
            : []),
          { op: "local.get", index: 0 }, // thisArg — the closure itself
          { op: "local.get", index: 2 }, // args
          { op: "call", funcIdx: applyClosureIdx },
        ];

  const builtinRouteAvailable =
    applyClosureIdx !== undefined &&
    objVecNewIdx !== undefined &&
    objVecPushIdx !== undefined &&
    objVecTypeIdx !== undefined &&
    objVecArrTypeIdx !== undefined &&
    nativeStrTypeIdx >= 0 &&
    ctx.nativeStrings === true;

  if (!builtinRouteAvailable) {
    setBody(CLOSURE_METHOD_CALL, [], ownPropRoute());
    return;
  }

  // Locals (params 0=fn 1=name 2=args).
  const M = 3; // externref — own-property lookup result
  const NAME = 4; // ref null $NativeString — name cast for the ref.eq identity test
  const ARGS_ANY = 5; // anyref — args carrier
  const ARGC = 6; // i32
  const THIS_ARG = 7; // externref
  const NEW_VEC = 8; // externref — the .call() args tail
  const I = 9; // i32 — loop cursor
  const locals: { name: string; type: ValType }[] = [
    { name: "m", type: { kind: "externref" } },
    { name: "nameStr", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
    { name: "argsAny", type: { kind: "anyref" } },
    { name: "argc", type: { kind: "i32" } },
    { name: "thisArg", type: { kind: "externref" } },
    { name: "newVec", type: { kind: "externref" } },
    { name: "i", type: { kind: "i32" } },
  ];

  /** args[idx] (idx already on the stack) — caller guarantees idx < argc. */
  const argAt = (idxInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: ARGS_ANY },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
    ...idxInstrs,
    { op: "array.get", typeIdx: objVecArrTypeIdx },
  ];

  /** `name === "<lit>"` by interned-literal identity. */
  const nameEq = (lit: string): Instr[] => [
    { op: "local.get", index: NAME },
    ...nativeStringLiteralInstrs(ctx, lit),
    { op: "ref.eq" },
  ];

  const body: Instr[] = [
    // ── Route 1: own property in the closure's side bag wins (§10.2 [[Get]]).
    ...(externGetIdx !== undefined
      ? ([
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          ...(ctx.funcMap.has("__nullish_to_null")
            ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
            : []),
          { op: "local.tee", index: M },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: M },
              { op: "local.get", index: 0 }, // thisArg — the closure itself
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: applyClosureIdx! },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),

    // ── Route 2: %Function.prototype%.call / .apply on the receiver itself.
    // Bail out unless the name is a flat native string (ropes miss by design).
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: nativeStrTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [...undef(), { op: "return" }] },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: nativeStrTypeIdx },
    { op: "local.set", index: NAME },

    // argc = args is $ObjVec ? args.length : 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: ARGC },
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: ARGS_ANY },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ARGS_ANY },
        { op: "ref.cast", typeIdx: objVecTypeIdx },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: ARGC },
      ],
    },

    // thisArg = argc >= 1 ? args[0] : undefined
    ...undef(),
    { op: "local.set", index: THIS_ARG },
    { op: "local.get", index: ARGC },
    { op: "i32.const", value: 1 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...argAt([{ op: "i32.const", value: 0 }]), { op: "local.set", index: THIS_ARG }],
    },

    // ── fn.call(thisArg, ...rest) → __apply_closure(fn, thisArg, [...rest])
    ...nameEq("call"),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: objVecNewIdx! },
        { op: "local.set", index: NEW_VEC },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: I },
                { op: "local.get", index: ARGC },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: NEW_VEC },
                ...argAt([{ op: "local.get", index: I }]),
                { op: "call", funcIdx: objVecPushIdx! },
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: 0 }, // fn — invoked as itself
        { op: "local.get", index: THIS_ARG },
        { op: "local.get", index: NEW_VEC },
        { op: "call", funcIdx: applyClosureIdx! },
        { op: "return" },
      ],
    },

    // ── fn.apply(thisArg, argArray) → __apply_closure(fn, thisArg, argArray).
    // `__apply_closure` reads a non-$ObjVec carrier through
    // `__extern_length`/`__extern_get_idx`, so a plain JS array works as-is;
    // a missing/undefined argArray degrades to a zero-arg call.
    ...nameEq("apply"),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: objVecNewIdx! },
        { op: "local.set", index: NEW_VEC },
        { op: "local.get", index: ARGC },
        { op: "i32.const", value: 2 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...argAt([{ op: "i32.const", value: 1 }]), { op: "local.set", index: NEW_VEC }],
        },
        { op: "local.get", index: 0 }, // fn — invoked as itself
        { op: "local.get", index: THIS_ARG },
        { op: "local.get", index: NEW_VEC },
        { op: "call", funcIdx: applyClosureIdx! },
        { op: "return" },
      ],
    },

    // Neither an own property nor a supported builtin.
    ...undef(),
  ];

  setBody(CLOSURE_METHOD_CALL, locals, body);
}
