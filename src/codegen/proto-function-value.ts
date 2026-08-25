// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4637 A1) A FUNCTION VALUE in a `[[Prototype]]` position, under
 * `--target standalone` / `--target wasi`.
 *
 * ## The gap, measured
 *
 * `$Object.$proto` is `(mut (ref null $Object))` (object-runtime.ts), and a
 * function value is NOT an `$Object` — it is a closure wrapper struct. So every
 * proto-position native (`__object_create`, `__object_setPrototypeOf`) reaches
 * its `ref.test $Object` gate, misses, and stores **null**. Measured on this
 * branch's base with `.tmp/probe.mts` (`--target standalone`,
 * `deferTopLevelInit`, runs executed for #4637):
 *
 * | shape                                                              | base |
 * | ------------------------------------------------------------------ | ---- |
 * | `function P(){}; P.type="m"; var o=Object.create(P); o.type`         | `undefined` |
 * | `… Object.getPrototypeOf(o) === P`                                   | false |
 * | `… P.isPrototypeOf(o)`                                               | false |
 * | `function P(){}; function F(){}; F.prototype=P; var m=new F()` — ditto | all false; `getPrototypeOf(m)` is `null` |
 * | `F.prototype === P` (the STATIC read)                                | **true** |
 *
 * The last row is what makes this a REPAIR rather than a widening: the
 * `.prototype` slot already holds the function value, and only the instance's
 * `[[Prototype]]` link disagreed. That is the residual
 * `fnctor-instance-prototype.ts` names verbatim and the half-bar #4623 measured
 * on `S13.2.2_A1_T1` / `_T2`.
 *
 * ## The decision — a proto-VIEW of the function, not a widened `$proto`
 *
 * Two representations were on the table (#4637 plan step 2). Recorded here the
 * way #4506 records its slot decision, because the rejected option is the one a
 * later reader will reach for first.
 *
 * **(a) Widen `$proto` to `anyref` + teach every walk to skip non-`$Object`
 * links.** Rejected. `$proto` is read by `struct.get $Object 0` across the
 * object runtime (`__extern_get`/`_has`/`_set`, the descriptor surface, `in`,
 * the proto-index store, `__object_setPrototypeOf`'s cycle check,
 * `__isPrototypeOf`) and every one of those reads feeds a local typed
 * `(ref null $Object)`. Widening the field forces a `ref.test`+`ref.cast` at
 * each site and changes the type of each local — a whole-runtime edit whose
 * failure mode is a validation error at best and a silently truncated chain at
 * worst. It also buys nothing the alternative does not: a link to a value
 * nothing can walk THROUGH is not a chain.
 *
 * **(b) Canonicalize a callable to its own-property bag `$Object` at the
 * proto-position choke points, and map back on the way out.** Adopted. A
 * property-carrying closure ALREADY has an `$Object` standing in for its
 * own-property table — the #3468 bag (`__closure_bag_ensure`). That bag is
 * exactly what a `[[Prototype]]` link must expose: §10.1.8.1 OrdinaryGet on an
 * instance whose proto is `P` reads **P's own properties**, which is what the
 * bag holds. So the chain becomes walkable with no new walk — the bag IS an
 * `$Object`, so `__extern_get`/`__extern_has`/`in`/`for-in` inherit through it
 * unchanged, and the entire cost of the option is one bag↔function identity
 * map, which is this module.
 *
 * ## Absent-not-wrong — why the REVERSE map is not optional
 *
 * Canonicalizing alone would make `Object.getPrototypeOf(o)` answer **the bag**:
 * an internal `$Object` the program can never name, which is a WRONG answer
 * where the base has merely a missing one (`null`). The campaign forbids exactly
 * that trade. So `__proto_from_function` records `(bag → function)` in a tiny
 * append-only registry and `__function_from_proto` — called on the way OUT of
 * `__getPrototypeOf` — maps it back, restoring `Object.getPrototypeOf(o) === P`.
 *
 * Two properties keep the map sound:
 *  - it is keyed by `ref.eq` on a bag the compiler minted, never by shape;
 *  - it is only ever POPULATED by `__proto_from_function`, so an `$Object` that
 *    was never used as a function's proto view is absent and maps to itself.
 *
 * ## Scope: CALLABLE carriers only
 *
 * The carrier gate is a `ref.test` chain over `collectClosureBaseWrapperTypeIdxs`
 * — the same closure base-wrapper set `__is_closure` / `__typeof_function` use —
 * and deliberately NOT the wider `__is_closure_prop_carrier` set, which also
 * matches `$__StandaloneRegExp` / `$__Date` / user instance carriers. §13.2.2 and
 * §20.1.2.2 admit any object as a proto, but those carriers reach the
 * proto-position natives through paths this issue has not measured, and a silent
 * representation change under them is how a fold turns into a regression. They
 * keep today's `null`.
 *
 * ## What this does NOT claim
 *
 * The bag's own `$proto` stays null, so `%Object.prototype%` is not reachable
 * THROUGH a function-valued prototype. That is one missing link short of the
 * spec chain (`m → P → %Function.prototype% → %Object.prototype%`), and it is a
 * missing answer, not a wrong one: a read that would have found
 * `Object.prototype.toString` still misses, exactly as on the base.
 *
 * ## Index-space discipline
 *
 * Reserve-then-fill, exactly like `closure-props.ts`: the two helpers are
 * reserved at `ensureObjectRuntime` time (so `object-runtime-prototype.ts` can
 * bake a stable `call <idx>`) with `unreachable` stubs, and filled at FINALIZE,
 * once every closure root is registered. Everything is gated on
 * `ctx.standalone || ctx.wasi`; in gc/host mode nothing is reserved, every
 * consult resolves `funcMap.get(…) === undefined`, and the emitted bytes are
 * identical to the pre-#4637 ones by construction.
 */
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { builtinBrandOffsetOf } from "./builtin-brands.js";
import { collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** `callable → its own-property bag `$Object``, registering the reverse edge. */
export const PROTO_FROM_FUNCTION = "__proto_from_function";
/** A registered bag → the callable it stands for; identity for anything else. */
export const FUNCTION_FROM_PROTO = "__function_from_proto";

/** `$ProtoFnEntry` field indices. */
const F_NEXT = 0;
const F_BAG = 1;
const F_FN = 2;

/**
 * Reserve the `$ProtoFnEntry` struct, the `$__proto_fn_head` global and the two
 * helper placeholders. Called from `ensureObjectRuntime` right after
 * `reserveClosurePropHelpers` (whose `__closure_bag_ensure` funcIdx the fill
 * bakes) and BEFORE `buildObjectPrototypeHelpers` bakes its `call <idx>`.
 *
 * `objectTypeIdx` is threaded in rather than looked up: it is a local of
 * `ensureObjectRuntime` at this point, and re-deriving it here would be a second
 * copy of a layout fact.
 */
export function reserveProtoFunctionValue(ctx: CodegenContext, objectTypeIdx: number): void {
  if (ctx.protoFunctionValueReserved) return;

  // --- $ProtoFnEntry { next: (ref null self); bag: (ref null $Object); fn: externref } ---
  // `next` is immutable: a prepend mints a NEW head whose `next` is the old
  // head, so no existing entry is ever mutated.
  const entryTypeIdx = ctx.mod.types.length;
  const entryFields: FieldDef[] = [
    { name: "next", type: { kind: "ref_null", typeIdx: entryTypeIdx }, mutable: false },
    // The bag itself. Typed as the `$Object` it is (rather than `eqref`) so the
    // `ref.eq` comparison needs no abstract-heaptype cast — `ref.test`/`ref.cast`
    // against a CONCRETE index is what the emitter and the DCE type walk expect.
    { name: "bag", type: { kind: "ref_null", typeIdx: objectTypeIdx }, mutable: false },
    // The callable this bag is the proto-view of, kept as the externref the
    // program's own `.prototype` read produces, so the identity is `===`-exact.
    { name: "fn", type: { kind: "externref" }, mutable: false },
  ];
  ctx.mod.types.push({ kind: "struct", name: "$ProtoFnEntry", fields: entryFields });
  ctx.protoFnEntryTypeIdx = entryTypeIdx;
  ctx.protoFnObjectTypeIdx = objectTypeIdx;

  const headGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "$__proto_fn_head",
    type: { kind: "ref_null", typeIdx: entryTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: entryTypeIdx }],
  });
  ctx.protoFnHeadGlobalIdx = headGlobalIdx;

  const externref: ValType = { kind: "externref" };
  for (const name of [PROTO_FROM_FUNCTION, FUNCTION_FROM_PROTO]) {
    if (ctx.funcMap.get(name) !== undefined) continue;
    const typeIdx = addFuncType(ctx, [externref], [externref], `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = {
      name,
      typeIdx,
      locals: [],
      // Replaced at FINALIZE — and `fillProtoFunctionValue` installs an IDENTITY
      // body rather than leaving this trap behind when a dependency is missing,
      // because a proto-position call site has already baked `call <idx>`.
      body: [{ op: "unreachable" }],
      exported: false,
    };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
  }

  ctx.protoFunctionValueReserved = true;
}

/**
 * Walk `$__proto_fn_head` comparing `entry.bag` against local `keySlot`
 * (`(ref null $Object)`); run `onHit` — which must `return` — on a match.
 * `curSlot` is the cursor. Depth 0 is the `loop`, depth 1 the enclosing `block`.
 */
function walkRegistry(entryTypeIdx: number, keySlot: number, curSlot: number, onHit: Instr[]): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: curSlot },
          { op: "ref.is_null" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: curSlot },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
          { op: "local.get", index: keySlot },
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: onHit },
          { op: "local.get", index: curSlot },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_NEXT },
          { op: "local.set", index: curSlot },
          { op: "br", depth: 0 },
        ],
      },
    ],
  };
}

/**
 * Fill the two reserved bodies at FINALIZE, once every closure root is
 * registered (the callable gate needs the COMPLETE base-wrapper list) and
 * `__closure_bag_ensure` is in `funcMap`.
 *
 * When the module has no closures, or the bag helper is absent, BOTH bodies
 * become the identity `local.get 0` — never the reserved `unreachable`. A
 * proto-position call site that baked `call <idx>` must not be able to trap
 * because a dependency was missing; the identity body reproduces the pre-#4637
 * answer exactly (`__object_create` then re-tests `$Object` and stores null, as
 * it always did).
 */
export function fillProtoFunctionValue(ctx: CodegenContext): void {
  if (!ctx.protoFunctionValueReserved) return;
  const entryTypeIdx = ctx.protoFnEntryTypeIdx;
  const headGlobalIdx = ctx.protoFnHeadGlobalIdx;
  const objectTypeIdx = ctx.protoFnObjectTypeIdx;
  if (entryTypeIdx === undefined || headGlobalIdx === undefined || objectTypeIdx === undefined) return;

  const setBody = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };
  const identity = (name: string): void => setBody(name, [], [{ op: "local.get", index: 0 }]);

  const bagEnsureIdx = ctx.funcMap.get("__closure_bag_ensure");
  const callableTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
  // (#4492) The `$NativeProto` arm is INDEPENDENT of the callable one: a module
  // may reach a builtin prototype in proto position without any closure root at
  // all, and bailing to identity on the callable gate alone would silently drop
  // it. Either arm being available is enough to fill a real body.
  const nativeProtoArm = nativeProtoViewArmInstrs(ctx, { entryTypeIdx, headGlobalIdx, objectTypeIdx, setBody });
  const callableReady = bagEnsureIdx !== undefined && callableTypeIdxs.length > 0;
  if (!callableReady && nativeProtoArm === undefined) {
    identity(PROTO_FROM_FUNCTION);
    identity(FUNCTION_FROM_PROTO);
    return;
  }

  fillProtoFromFunction(ctx, {
    entryTypeIdx,
    headGlobalIdx,
    objectTypeIdx,
    bagEnsureIdx: callableReady ? bagEnsureIdx : undefined,
    callableTypeIdxs: callableReady ? callableTypeIdxs : [],
    nativeProtoArm,
    setBody,
  });
  fillFunctionFromProto(ctx, { entryTypeIdx, headGlobalIdx, objectTypeIdx, setBody });
}

/** `$NativeProto` field indices (native-proto.ts layout). */
const NP_IS_CLASS = 1;

/**
 * `__proto_from_function`'s local slots. Named at module scope because the
 * callable arm and the (#4492) `$NativeProto` arm share the same frame and must
 * not drift: `1 = vAny (anyref)`, `2 = bag (externref)`,
 * `3 = bagObj ((ref null $Object))`, `4 = cur ((ref null $ProtoFnEntry))`.
 */
const PFF_V_ANY = 1;
const PFF_BAG = 2;
const PFF_BAG_OBJ = 3;
const PFF_CUR = 4;
/** (#4492) `5 = fnProto (externref)` — the `%Function.prototype%` companion. */
const PFF_FN_PROTO = 5;

/**
 * The shared tail both proto-VIEW arms end in: with the view already in
 * `PFF_BAG` and proven to be an `$Object`, record `(view → receiver)` in the
 * registry (once) and `return` the view.
 *
 * Factored so the callable arm and the `$NativeProto` arm cannot register the
 * edge differently — `__function_from_proto` is the ONLY thing that keeps
 * `Object.getPrototypeOf` from publishing an internal object the program can
 * never name, and one arm forgetting it is exactly the wrong-answer trade this
 * campaign forbids.
 */
function registerViewInstrs(opts: FillOpts, afterCast: Instr[] = []): Instr[] {
  const { entryTypeIdx, headGlobalIdx, objectTypeIdx } = opts;
  return [
    { op: "local.get", index: PFF_BAG },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: PFF_BAG_OBJ },
    ...afterCast,
    { op: "global.get", index: headGlobalIdx },
    { op: "local.set", index: PFF_CUR },
    // Already registered ⇒ answer the view without a duplicate entry.
    walkRegistry(entryTypeIdx, PFF_BAG_OBJ, PFF_CUR, [{ op: "local.get", index: PFF_BAG }, { op: "return" }]),
    // head = $ProtoFnEntry { next: head, bag: view, fn: v }
    { op: "global.get", index: headGlobalIdx },
    { op: "local.get", index: PFF_BAG_OBJ },
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: entryTypeIdx },
    { op: "global.set", index: headGlobalIdx },
    { op: "local.get", index: PFF_BAG },
    { op: "return" },
  ];
}

/**
 * (#4492) The instruction pair that turns a `$NativeProto` (`Function.prototype`,
 * `Array.prototype`, …) into the `$Object` the proto walk can actually traverse:
 * the brand's proto-index COMPANION (`proto-index-store.ts`), vivified with
 * `create = 1` so its `__nativeproto_seed_<brand>` seeder installs the builtin's
 * own members.
 *
 * ## Why this is the same decision #4637 already made
 *
 * `$Object.$proto` is `(ref null $Object)`, so `__object_create`'s `ref.test`
 * misses a `$NativeProto` exactly the way it missed a callable and stores
 * **null**. Measured on this branch's base (`--target standalone`,
 * `.tmp/probes/a3.js` / `e2.js`, runs executed for #4492):
 *
 * | shape                                                            | base |
 * | ---------------------------------------------------------------- | ---- |
 * | `function F(){}; F.prototype = Function.prototype; new F().call`  | `undefined` |
 * | `Object.create(Function.prototype).call`                          | `undefined` |
 * | `Object.create(Array.prototype).slice`                            | `undefined` |
 * | `F.prototype === Function.prototype` (the STATIC read)            | **true** |
 * | `Function.prototype["call"]` (the DYNAMIC read, #4248)            | **function** |
 *
 * The last two rows are what make this a repair: BOTH endpoints already answer
 * correctly and only the instance→prototype edge disagreed. Widening `$proto` to
 * `anyref` was rejected for #4637's reasons verbatim (every `struct.get $Object 0`
 * feeds a `(ref null $Object)` local); the proto-VIEW keeps the one walk.
 *
 * The companion is the right view for the same reason the closure bag was:
 * §10.1.8.1 OrdinaryGet on an instance whose prototype is `P` reads **P's own
 * properties**, and the companion IS the brand's own-member table — it is
 * already what `__protoidx_own_recv` substitutes for an own-property query.
 *
 * ## Declines (absent, never wrong)
 *
 *  - A **class** `$NativeProto` (`$isClass` set) carries a user-class tag, not a
 *    builtin brand, and `__protoidx_brand_off` answers its `Object` DEFAULT for
 *    anything it cannot classify — so mapping one would publish
 *    `%Object.prototype%`'s companion as a class's prototype. Guarded out.
 *  - The proto-index store unreserved (no `protoIndexDirty`/`protoNamedDirty`/
 *    `protoMemberDirty`) ⇒ no arm, no bytes, base behaviour.
 *  - `__protoidx_companion` answering a non-`$Object` ⇒ return the receiver
 *    unchanged rather than cast-trap.
 *
 * Returns `undefined` when any dependency is missing, which the caller reads as
 * "this arm contributes nothing".
 */
function nativeProtoViewArmInstrs(ctx: CodegenContext, opts: FillOpts): Instr[] | undefined {
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  const brandOffIdx = ctx.funcMap.get("__protoidx_brand_off");
  const companionIdx = ctx.funcMap.get("__protoidx_companion");
  if (npTypeIdx === undefined || brandOffIdx === undefined || companionIdx === undefined) return undefined;
  return [
    { op: "local.get", index: PFF_V_ANY },
    { op: "ref.test", typeIdx: npTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: PFF_V_ANY },
        { op: "ref.cast", typeIdx: npTypeIdx },
        { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: NP_IS_CLASS },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: brandOffIdx },
            { op: "i32.const", value: 1 }, // create + seed: this read IS the demand
            { op: "call", funcIdx: companionIdx },
            { op: "local.tee", index: PFF_BAG },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: opts.objectTypeIdx },
            // A companion that is not an `$Object` (or a null slot) falls
            // through to the receiver, unchanged — never a cast trap.
            { op: "if", blockType: { kind: "empty" }, then: registerViewInstrs(opts) },
          ],
        },
      ],
    },
  ];
}

/**
 * (#4492) Give a freshly-cast callable BAG the `[[Prototype]]` its function has:
 * `bagObj.$proto = %Function.prototype%`'s brand companion, written only when
 * the slot is still null.
 *
 * This closes the exact gap #4637's header names under "What this does NOT
 * claim" — *"the bag's own `$proto` stays null, so `%Function.prototype%` is not
 * reachable THROUGH a function-valued prototype … one missing link short of the
 * spec chain (`m → P → %Function.prototype% → %Object.prototype%`)"*. Measured on
 * this branch's base (`.tmp/probes/f1.js`, `--target standalone`):
 * `function H(){}; H.prototype = G; Object.getPrototypeOf(new H()) === G` was
 * already **true** while `typeof new H().call` was **undefined** — the link
 * existed and the level above it did not.
 *
 * It is the hop test262 `built-ins/Function/prototype/{call,apply}/
 * S15.3.4.{4,3}_A1_T1` needs — their prototype is `Function()`'s RESULT rather
 * than `Function.prototype` — but it is NOT sufficient for them, and the measured
 * reason is recorded in #4492's residuals: those modules never name a builtin
 * prototype, so `protoMemberDirty` stays clear, the proto-index store is never
 * reserved and this arm emits nothing. Adding one `var arm = Function.prototype`
 * line to the probe flips both reads (`.tmp/probes/f1.js` → `f2.js`), which is
 * what isolates the ARMING gate as the remaining blocker rather than the link.
 *
 * Sound because a bag stands for a CALLABLE (the arm's own `ref.test` ladder
 * established that), and OrdinaryFunctionCreate gives every ordinary function
 * object `%Function.prototype%` as its `[[Prototype]]`. The write is conditional
 * on a null slot so an explicit `Object.setPrototypeOf(f, x)` — which writes the
 * same field through `__object_setPrototypeOf` — is never overwritten.
 *
 * The companion's own members are non-enumerable (`PROTO_METHOD_DEFINE_FLAGS`),
 * so `for (k in f)` is unaffected, and its `$proto` is null, so no cycle is
 * possible. Emits nothing when the proto-index store is unreserved.
 */
function bagFunctionProtoLinkInstrs(ctx: CodegenContext, objectTypeIdx: number): Instr[] {
  const companionIdx = ctx.funcMap.get("__protoidx_companion");
  const funOff = builtinBrandOffsetOf("Function");
  if (companionIdx === undefined || funOff === undefined) return [];
  return [
    { op: "local.get", index: PFF_BAG_OBJ },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: funOff },
        { op: "i32.const", value: 1 }, // create + seed
        { op: "call", funcIdx: companionIdx },
        { op: "local.tee", index: PFF_FN_PROTO },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: PFF_BAG_OBJ },
            { op: "ref.as_non_null" },
            { op: "local.get", index: PFF_FN_PROTO },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 0 },
          ],
        },
      ],
    },
  ];
}

interface FillOpts {
  entryTypeIdx: number;
  headGlobalIdx: number;
  objectTypeIdx: number;
  setBody: (name: string, locals: { name: string; type: ValType }[], body: Instr[]) => void;
}

/**
 * `__proto_from_function(externref v) -> externref` — a callable answers its
 * own-property bag (vivified), everything else answers itself.
 *
 * locals: 1 = vAny (anyref), 2 = bag (externref), 3 = bagObj ((ref null $Object)),
 *         4 = cur ((ref null $ProtoFnEntry))
 */
function fillProtoFromFunction(
  _ctx: CodegenContext,
  opts: FillOpts & {
    bagEnsureIdx: number | undefined;
    callableTypeIdxs: number[];
    nativeProtoArm: Instr[] | undefined;
  },
): void {
  const { entryTypeIdx, objectTypeIdx, bagEnsureIdx, callableTypeIdxs, nativeProtoArm, setBody } = opts;
  const returnSelf: Instr[] = [{ op: "local.get", index: 0 }, { op: "return" }];

  // The conversion, run once a `ref.test` has established `v` is a callable.
  const convert = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: bagEnsureIdx! },
    { op: "local.tee", index: PFF_BAG },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    // A bag is always an `$Object`; if this module ever changes that, decline
    // rather than cast-trap.
    { op: "if", blockType: { kind: "empty" }, then: returnSelf },
    // (#4492) The bag's own `[[Prototype]]` — the hop #4637 left open.
    ...registerViewInstrs(opts, bagFunctionProtoLinkInstrs(_ctx, objectTypeIdx)),
  ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: PFF_V_ANY },
  ];
  for (const typeIdx of callableTypeIdxs) {
    body.push(
      { op: "local.get", index: PFF_V_ANY },
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: convert() },
    );
  }
  // (#4492) A builtin prototype object in the same position. Emitted AFTER the
  // callable ladder so a module with no `$NativeProto` keeps its exact #4637
  // bytes; the two shapes are disjoint, so the order is not semantic.
  if (nativeProtoArm) body.push(...nativeProtoArm);
  body.push({ op: "local.get", index: 0 });

  setBody(
    PROTO_FROM_FUNCTION,
    [
      { name: "__vAny", type: { kind: "anyref" } },
      { name: "__bag", type: { kind: "externref" } },
      { name: "__bagObj", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
      { name: "__cur", type: { kind: "ref_null", typeIdx: entryTypeIdx } },
      // (#4492) `PFF_FN_PROTO` — the `%Function.prototype%` companion. Declared
      // unconditionally so the slot index is the same whichever arms are live.
      { name: "__fnProto", type: { kind: "externref" } },
    ],
    body,
  );
}

/**
 * `__function_from_proto(externref o) -> externref` — a registered bag answers
 * the callable it stands for, everything else answers itself.
 *
 * locals: 1 = oAny (anyref), 2 = oObj ((ref null $Object)), 3 = cur
 */
function fillFunctionFromProto(_ctx: CodegenContext, opts: FillOpts): void {
  const { entryTypeIdx, headGlobalIdx, objectTypeIdx, setBody } = opts;
  const O_ANY = 1;
  const O_OBJ = 2;
  const CUR = 3;
  const returnSelf: Instr[] = [{ op: "local.get", index: 0 }, { op: "return" }];
  const body: Instr[] = [
    // An empty registry is the overwhelmingly common case — one null check, and
    // no behaviour change at all for a module that never used a function as a
    // prototype.
    { op: "global.get", index: headGlobalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: returnSelf },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: O_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnSelf },
    { op: "local.get", index: O_ANY },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: O_OBJ },
    { op: "global.get", index: headGlobalIdx },
    { op: "local.set", index: CUR },
    walkRegistry(entryTypeIdx, O_OBJ, CUR, [
      { op: "local.get", index: CUR },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_FN },
      { op: "return" },
    ]),
    { op: "local.get", index: 0 },
  ];
  setBody(
    FUNCTION_FROM_PROTO,
    [
      { name: "__oAny", type: { kind: "anyref" } },
      { name: "__oObj", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
      { name: "__cur", type: { kind: "ref_null", typeIdx: entryTypeIdx } },
    ],
    body,
  );
}
