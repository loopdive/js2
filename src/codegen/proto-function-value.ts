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
  if (bagEnsureIdx === undefined || callableTypeIdxs.length === 0) {
    identity(PROTO_FROM_FUNCTION);
    identity(FUNCTION_FROM_PROTO);
    return;
  }

  fillProtoFromFunction(ctx, { entryTypeIdx, headGlobalIdx, objectTypeIdx, bagEnsureIdx, callableTypeIdxs, setBody });
  fillFunctionFromProto(ctx, { entryTypeIdx, headGlobalIdx, objectTypeIdx, setBody });
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
  opts: FillOpts & { bagEnsureIdx: number; callableTypeIdxs: number[] },
): void {
  const { entryTypeIdx, headGlobalIdx, objectTypeIdx, bagEnsureIdx, callableTypeIdxs, setBody } = opts;
  const V_ANY = 1;
  const BAG = 2;
  const BAG_OBJ = 3;
  const CUR = 4;
  const returnSelf: Instr[] = [{ op: "local.get", index: 0 }, { op: "return" }];

  // The conversion, run once a `ref.test` has established `v` is a callable.
  const convert = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: bagEnsureIdx },
    { op: "local.tee", index: BAG },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    // A bag is always an `$Object`; if this module ever changes that, decline
    // rather than cast-trap.
    { op: "if", blockType: { kind: "empty" }, then: returnSelf },
    { op: "local.get", index: BAG },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: BAG_OBJ },
    { op: "global.get", index: headGlobalIdx },
    { op: "local.set", index: CUR },
    // Already registered ⇒ answer the bag without a duplicate entry.
    walkRegistry(entryTypeIdx, BAG_OBJ, CUR, [{ op: "local.get", index: BAG }, { op: "return" }]),
    // head = $ProtoFnEntry { next: head, bag: bagObj, fn: v }
    { op: "global.get", index: headGlobalIdx },
    { op: "local.get", index: BAG_OBJ },
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: entryTypeIdx },
    { op: "global.set", index: headGlobalIdx },
    { op: "local.get", index: BAG },
    { op: "return" },
  ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: V_ANY },
  ];
  for (const typeIdx of callableTypeIdxs) {
    body.push(
      { op: "local.get", index: V_ANY },
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: convert() },
    );
  }
  body.push({ op: "local.get", index: 0 });

  setBody(
    PROTO_FROM_FUNCTION,
    [
      { name: "__vAny", type: { kind: "anyref" } },
      { name: "__bag", type: { kind: "externref" } },
      { name: "__bagObj", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
      { name: "__cur", type: { kind: "ref_null", typeIdx: entryTypeIdx } },
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
