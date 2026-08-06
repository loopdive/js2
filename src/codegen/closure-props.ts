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
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
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
): Instr[] {
  const isClosurePropCarrierIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  if (isClosurePropCarrierIdx === undefined) return [{ op: "ref.null.extern" }];
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
      else: [{ op: "ref.null.extern" }],
    },
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
    const carrierTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
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
  {
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    const body: Instr[] = [...narrowRecvToEq, walkLoop(onHit), { op: "ref.null.extern" }];
    setBody(CLOSURE_BAG_LOOKUP, walkLocals, body);
  }

  // ── __closure_bag_ensure(externref recv) -> externref ──
  // As lookup; on miss allocate a fresh `$Object` bag, prepend a new entry,
  // update the head, and return the bag. Locals: 1 = recvEq, 2 = cur, 3 = bag.
  if (newPlainObjectIdx !== undefined) {
    const ensureLocals: { name: string; type: ValType }[] = [
      ...walkLocals,
      { name: "__bag", type: { kind: "externref" } },
    ];
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    const body: Instr[] = [
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

  // ── __closure_prop_get(externref obj, externref key) -> externref ──
  // if is_closure(obj) { bag = lookup(obj); if bag != null return __extern_get(bag,key) }
  // ; return getMiss()  (the same undefined-read sentinel __extern_get uses)
  if (isClosureIdx !== undefined && bagLookupIdx !== undefined && externGetIdx !== undefined) {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosureIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: bagLookupIdx },
          { op: "local.tee", index: 2 }, // bag
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 2 }, // bag
              { op: "local.get", index: 1 }, // key
              { op: "call", funcIdx: externGetIdx },
              { op: "return" },
            ],
          },
        ],
      },
      ...getMiss(),
    ];
    setBody(CLOSURE_PROP_GET, [{ name: "__bag", type: { kind: "externref" } }], body);
  } else {
    // Deps absent — keep a valid body: always return the undefined sentinel.
    setBody(CLOSURE_PROP_GET, [], [...getMiss()]);
  }

  // ── __closure_prop_set(externref obj, externref key, externref value) -> () ──
  // if is_closure(obj) { bag = ensure(obj); __extern_set(bag, key, value) }
  if (isClosureIdx !== undefined && bagEnsureIdx !== undefined && externSetIdx !== undefined) {
    const body: Instr[] = [
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
    setBody(CLOSURE_PROP_SET, [], body);
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
