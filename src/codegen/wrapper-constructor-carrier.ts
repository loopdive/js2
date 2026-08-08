// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4223) `<wrapper>.constructor` for a standalone primitive-WRAPPER object
 * (`Object(5)`, `new Number(5)`, `new String("x")`, `new Boolean(true)`) whose
 * receiver is only known at RUNTIME.
 *
 * ## The gap, and why it needed BOTH halves
 *
 * `Object(5).constructor === Number` was false on standalone for two
 * independent reasons, and fixing either alone flips nothing:
 *
 * | side | read on main            | why                                        |
 * | ---- | ----------------------- | ------------------------------------------ |
 * | RHS  | `Number` → **null**     | no identity-stable carrier (#3006 excluded) |
 * | LHS  | `.constructor` → `undefined` | no arm answers it for a wrapper       |
 *
 * The RHS half is a one-line addition to `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`
 * (builtin-static-globals.ts) — #4200 named this exact omission and deferred it
 * because it changes what the BARE identifier reads. That is this module's
 * premise, not its content: with the carrier minted, `<B>.prototype.constructor`
 * also starts resolving for free (builtin-proto-constructor.ts dispatches on the
 * same predicate).
 *
 * This module is the LHS half. A wrapper is a plain `$Object` carrying its
 * [[NumberData]]/[[StringData]]/[[BooleanData]] under the internal-slot key
 * `[[PrimitiveValue]]` (object-runtime.ts), and `Object.getPrototypeOf(o) ===
 * Number.prototype` already holds — but the proto link points at a
 * `$NativeProto`, not a `$Object`, so `__extern_get`'s proto-walk (which follows
 * `$Object.$proto`) never reaches a place where `constructor` could live. Every
 * wrapper `.constructor` read therefore fell out of the chain as a miss.
 *
 * ## The arm
 *
 * Prepended to `__extern_get` at finalize: when the key is `"constructor"` and
 * the receiver is a `$Object` with a `[[PrimitiveValue]]` slot, classify the
 * slot value's box type and return the matching carrier. The classification
 * ladder is deliberately the SAME one `__protoidx_brand_off`
 * (proto-index-store.ts, #4176) uses to recover a wrapper's prototype brand —
 * `$AnyString` → String, `$__box_number` or `i31` → Number, `$__box_boolean` →
 * Boolean — so a wrapper cannot be classified one way for its inherited
 * properties and another way for its constructor.
 *
 * `constructor` is an ordinary writable INHERITED property (§7.3.2), so an own
 * entry must shadow the answer. The arm consults `__obj_find(o, "constructor")`
 * FIRST and declines when the wrapper carries its own — the main body then
 * answers it normally. That check is what makes prepending sound: the arm
 * behaves as if it sat at the chain-exhausted miss, because a wrapper's
 * [[Prototype]] chain contains no other `$Object` that could define the key.
 *
 * ## Why demand-minted, and why the gate is a module-wide scan
 *
 * Materializing the three carriers drags in the `$Object` runtime's
 * define-property path plus each carrier's `length`/`name`/`prototype` seed
 * (builtin-ctor-own-props.ts) — ~700 bytes measured. #4034 is the standing
 * reminder of what an unconditional pull-in costs, so a module that never reads
 * `.constructor` mints nothing and `wrapperConstructorArmInstrs` installs no arm.
 *
 * The gate is a SOURCE scan (`moduleReadsConstructorProp`) rather than a hook on
 * the emitting call site, because there is no single emitting call site: the
 * consuming arm lives inside the shared `__extern_get`, and a `.constructor`
 * read reaches it through at least three lowerings — the legacy any-receiver
 * path (`tryEmitConstructorViaTag`), the IR `dyn.member_get` path
 * (`__dyn_member_get` is a thin `__extern_get` wrapper), and a plain
 * externref-receiver read at module top level. Hanging the mint on any one of
 * them fixed only the tests that used that lowering; each of the first two
 * attempts here flipped a different third of the probes.
 *
 * Minting must happen DURING ordinary codegen (it can register late imports),
 * never from finalize — same contract as vec-constructor-carrier.ts. The hook is
 * the tail of `ensureObjectRuntime`, which owns `__extern_get` and is always
 * entered from ordinary codegen.
 */

import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { emitBuiltinConstructorIdentity, emitBuiltinNamespaceObject } from "./builtin-static-globals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

/**
 * The wrapper constructors this module answers for, in classification order.
 * `Object(fn)` / `Object(obj)` are NOT here: those return the argument itself
 * (identity, already correct) and carry no `[[PrimitiveValue]]` slot, so they
 * never reach this arm.
 */
const WRAPPER_BUILTINS = ["String", "Number", "Boolean"] as const;
type WrapperBuiltin = (typeof WRAPPER_BUILTINS)[number];

/** Accessor name minted per wrapper builtin, and the finalize lookup key. */
function carrierFnName(builtinName: WrapperBuiltin): string {
  return `__wrap_ctor_${builtinName}`;
}

/**
 * (#4176 sibling) The boxed-primitive wrapper internal-slot key — MUST equal
 * `WRAPPER_PRIMITIVE_KEY` in object-runtime.ts. Duplicated rather than
 * imported for the same reason proto-index-store.ts duplicates it:
 * object-runtime imports THIS module, so a value import back would close an
 * ESM cycle.
 */
const WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]";

/** `$PropEntry.$value` field index (object-runtime.ts layout). */
const ENTRY_VALUE = 1;

/** `$Object.proto` field index (object-runtime.ts layout: proto is field 0). */
const OBJECT_PROTO = 0;

/**
 * (#4232) Accessor for the ORDINARY-object answer: `Object`.
 *
 * Kept separate from the three wrapper carriers because it answers a different
 * question and is reached by a different gate. `Object` is a NAMESPACE object,
 * not one of #3006's `__builtin_ctor_<Name>` singletons, so it is materialized
 * by `emitBuiltinNamespaceObject` — the same global the bare `Object`
 * identifier and #3133's static fold both read, which is what makes
 * `Object(null).constructor === Object` genuine rather than a coincidence of
 * two nulls.
 */
const PLAIN_CARRIER_FN = "__plain_ctor_Object";

/** i31 abstract heap type (signed LEB -20) — small-int boxed numbers (#3673). */
const I31_HEAP_TYPE = -20;

/**
 * (#4223) The demand gate: does this module syntactically READ a `constructor`
 * property anywhere? Cached per source file, same shape as #3133's
 * `moduleTouchesConstructorProp` (property-access.ts) — which asks the
 * complementary question (does the module WRITE one).
 *
 * A read is the honest signal here because the consuming arm lives inside the
 * shared `__extern_get`, so it cannot be attributed to one call site: the read
 * may be lowered by the legacy any-receiver path, the IR `dyn.member_get`
 * path, or a builtin-specific reader, and all three land in the same native.
 * Scanning once at module setup covers every one of them.
 */
const constructorPropReadCache = new WeakMap<ts.SourceFile, boolean>();
export function moduleReadsConstructorProp(sourceFile: ts.SourceFile): boolean {
  let reads = constructorPropReadCache.get(sourceFile);
  if (reads === undefined) {
    reads = false;
    const walk = (node: ts.Node): void => {
      if (reads) return;
      if (
        (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === "constructor")
      ) {
        reads = true;
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
    constructorPropReadCache.set(sourceFile, reads);
  }
  return reads;
}

/**
 * (#4232) SECOND demand gate, for the ordinary-object arm only: does this
 * module mention the `Object` identifier at all?
 *
 * Why this is separate from `moduleReadsConstructorProp`, and why it had to be
 * added after the fact: the plain-`Object` answer comes from
 * `emitBuiltinNamespaceObject`, which materializes the namespace object's
 * COMPLETE function-valued own surface — every `Object.keys` / `defineProperty`
 * / … as a closure. Materializing closures arms the JS-host method-closure
 * bridge, whose five compiler-reserved `__\0js2_call_fn_method_argc_N` exports
 * then appear in the module. Hanging that off `moduleReadsConstructorProp`
 * alone put the whole `Object` static surface into EVERY standalone module that
 * reads `.constructor` anywhere — including modules that only ever read a
 * primitive wrapper's, which are answered by the three `__builtin_ctor_<Name>`
 * carriers and never reach the plain arm at all. That is exactly the
 * unconditional pull-in #4034 stands as the reminder against, and it is what
 * broke #4223's own suite (five tests that sweep `Object.entries(exports)` and
 * assert an exact shape).
 *
 * The gate is a genuine heuristic and it is worth being explicit about the
 * trade: a module that reads `.constructor` on a bare `$Object` while never
 * mentioning `Object` keeps today's `undefined`. That is the same bargain the
 * `moduleReadsConstructorProp` gate above already strikes — accept a wrong
 * `undefined` in a case that cannot be cheaply detected rather than pay an
 * unconditional pull-in — except that gate is exact and this one is not. Every
 * test262 file the arm was added for (`S15.2.1.1_A1_T1..T5`, `A3_T2`) mentions
 * `Object` by construction: they all build the receiver with `Object(null)` or
 * `new Object(null)`.
 */
const objectMentionCache = new WeakMap<ts.SourceFile, boolean>();
export function moduleMentionsObjectIdentifier(sourceFile: ts.SourceFile): boolean {
  let mentions = objectMentionCache.get(sourceFile);
  if (mentions === undefined) {
    mentions = false;
    const walk = (node: ts.Node): void => {
      if (mentions) return;
      if (ts.isIdentifier(node) && node.text === "Object") {
        mentions = true;
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
    objectMentionCache.set(sourceFile, mentions);
  }
  return mentions;
}

/**
 * Mint (idempotently) `__wrap_ctor_String/Number/Boolean() -> externref` — the
 * runtime accessors for the three `__builtin_ctor_<Name>` singletons.
 *
 * The accessor, not a bare `global.get`, is what makes the read work when it is
 * the module's FIRST demand for the builtin: the singleton's guarded lazy init
 * rides inside it. That case is not exotic — it is the argument order of
 * `assert.sameValue(obj.constructor, Number)`, where the LHS is compiled first.
 *
 * Call from ordinary codegen only, and treat it as a late-import adder: run it
 * before any funcIdx is captured by name and flush afterwards.
 */
export function ensureWrapperConstructorCarriers(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.wrapperCtorCarrierDemanded !== true) return;
  for (const builtinName of [...WRAPPER_BUILTINS, PLAIN_CARRIER_FN] as const) {
    // (#4232) The plain-`Object` carrier carries its own, NARROWER gate — see
    // `moduleMentionsObjectIdentifier`. The three wrapper carriers are cheap
    // (`__builtin_ctor_<Name>` singletons); this one drags in the whole
    // `Object` namespace surface, so it must not ride the shared flag.
    if (builtinName === PLAIN_CARRIER_FN && ctx.plainCtorCarrierDemanded !== true) continue;
    const name = builtinName === PLAIN_CARRIER_FN ? PLAIN_CARRIER_FN : carrierFnName(builtinName);
    if (ctx.funcMap.get(name) !== undefined) continue;

    const resultType: ValType = { kind: "externref" };
    const typeIdx = addFuncType(ctx, [], [resultType]);
    const fctx: FunctionContext = {
      name,
      params: [],
      locals: [],
      localMap: new Map(),
      returnType: resultType,
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
    };
    // Emit BEFORE minting: the carrier's own-property seed mints helpers of its
    // own, and nested mints must get their ordinals first (the same order
    // `ensureVecConstructorCarrier` uses).
    if (builtinName === PLAIN_CARRIER_FN) {
      if (emitBuiltinNamespaceObject(ctx, fctx, "Object") === null) continue;
    } else {
      emitBuiltinConstructorIdentity(ctx, fctx, builtinName);
    }

    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: fctx.locals,
      body: fctx.body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  }
}

/**
 * The `"constructor"` arm prepended onto `__extern_get`'s body at finalize.
 *
 * `__extern_get(externref o /*0*\/, externref key /*1*\/) -> externref`. The arm
 * appends its own scratch locals to `fn.locals` (caller passes the current
 * count so the indices line up: local `n` is operand index `2 + n`).
 *
 * Answers `[]` — no arm at all — when the accessors were never demanded or when
 * any structural prerequisite is missing, so the caller can splice
 * unconditionally.
 */
export function wrapperConstructorArmInstrs(
  ctx: CodegenContext,
  opts: {
    /** `key == "constructor"` test, leaving an i32 (caller owns the numbering). */
    keyEqualsConstructor: Instr[] | null;
    /** Index of the first scratch local this arm may claim. */
    firstLocalIndex: number;
    objectTypeIdx: number;
    propEntryTypeIdx: number;
  },
): { instrs: Instr[]; locals: { name: string; type: ValType }[] } {
  const empty = {
    instrs: [] as Instr[],
    locals: [] as { name: string; type: ValType }[],
  };
  if (!ctx.standalone) return empty;
  const { keyEqualsConstructor, firstLocalIndex, objectTypeIdx, propEntryTypeIdx } = opts;
  if (!keyEqualsConstructor) return empty;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (objFindIdx === undefined) return empty;

  const carriers = WRAPPER_BUILTINS.map((n) => ({
    name: n,
    idx: ctx.funcMap.get(carrierFnName(n)),
  }));
  const plainIdx = ctx.funcMap.get(PLAIN_CARRIER_FN);
  if (carriers.every((c) => c.idx === undefined) && plainIdx === undefined) return empty; // never demanded

  const anyStr = ctx.anyStrTypeIdx;
  const boxNum = ctx.nativeBoxNumberTypeIdx;
  const boxBool = ctx.nativeBoxBooleanTypeIdx;

  // locals: [0] the cast `$Object`, [1] the `[[PrimitiveValue]]` $PropEntry.
  const objLocal = firstLocalIndex;
  const slotLocal = firstLocalIndex + 1;
  const locals = [
    {
      name: "wco",
      type: { kind: "ref_null", typeIdx: objectTypeIdx } as ValType,
    },
    {
      name: "wce",
      type: { kind: "ref_null", typeIdx: propEntryTypeIdx } as ValType,
    },
  ];

  const slotValue = (): Instr[] => [
    { op: "local.get", index: slotLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
  ];
  const answer = (idx: number): Instr[] => [{ op: "call", funcIdx: idx }, { op: "return" }];
  const stringIdx = carriers[0]!.idx;
  const numberIdx = carriers[1]!.idx;
  const booleanIdx = carriers[2]!.idx;

  const classify: Instr[] = [
    ...(stringIdx !== undefined && anyStr >= 0
      ? ([
          ...slotValue(),
          { op: "ref.test", typeIdx: anyStr },
          { op: "if", blockType: { kind: "empty" }, then: answer(stringIdx) },
        ] satisfies Instr[])
      : []),
    ...(numberIdx !== undefined && boxNum >= 0
      ? ([
          ...slotValue(),
          { op: "ref.test", typeIdx: boxNum },
          ...slotValue(),
          { op: "ref.test", typeIdx: I31_HEAP_TYPE },
          { op: "i32.or" },
          { op: "if", blockType: { kind: "empty" }, then: answer(numberIdx) },
        ] satisfies Instr[])
      : []),
    ...(booleanIdx !== undefined && boxBool >= 0
      ? ([
          ...slotValue(),
          { op: "ref.test", typeIdx: boxBool },
          { op: "if", blockType: { kind: "empty" }, then: answer(booleanIdx) },
        ] satisfies Instr[])
      : []),
  ];

  /**
   * (#4232) The ORDINARY-object arm: `Object(null)` / `Object(undefined)` /
   * `Object()` produce a bare `$Object`, whose `.constructor` is `Object` —
   * §20.1.1.1 step 1 makes them all `OrdinaryObjectCreate(%Object.prototype%)`.
   * The proto-walk in `__extern_get`'s main body cannot answer it because
   * `%Object.prototype%` is not itself a `$Object` in this model, so the walk
   * terminates immediately and the read misses.
   *
   * The `proto == null` gate is the ENTIRE safety argument and it is why this
   * could not simply be "a `$Object` answers Object". Every `new F()` instance
   * is also a `$Object`, but #2660 links its `$proto` to the per-fnctor
   * `F.prototype` object — so it has a non-null proto, never reaches here, and
   * keeps inheriting `F.prototype.constructor` through the ordinary walk. A
   * wrong answer here would be silent: `new F().constructor` would start
   * reading `Object`.
   *
   * Placed AFTER the `[[PrimitiveValue]]` classification and predicated on the
   * slot being ABSENT, so a wrapper (which also has a `$NativeProto`, i.e. a
   * null `$Object`-typed proto link) is answered by its own arm first. The
   * enclosing block has already established that the receiver carries no OWN
   * `constructor`, so §7.3.2 shadowing is honored for free.
   *
   * Known limitation, recorded rather than papered over: `Object.create(null)`
   * is represented identically to `{}` — there is no null-prototype marker on
   * `$Object` — so it also reads `Object` here instead of `undefined`. That is
   * a value-representation gap (the same one that makes
   * `Object.getPrototypeOf(Object.create(null))` indistinguishable), not
   * something this arm can decide.
   */
  const plainArm: Instr[] =
    plainIdx === undefined
      ? []
      : [
          { op: "local.get", index: slotLocal },
          { op: "ref.is_null" },
          { op: "local.get", index: objLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OBJECT_PROTO },
          { op: "ref.is_null" },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "empty" }, then: answer(plainIdx) },
        ];
  if (classify.length === 0 && plainArm.length === 0) return empty;

  const instrs: Instr[] = [
    ...keyEqualsConstructor,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            { op: "local.set", index: objLocal },
            // §7.3.2: an OWN `constructor` shadows the inherited carrier.
            { op: "local.get", index: objLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: objFindIdx },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // wrapper? — the [[PrimitiveValue]] internal slot decides.
                { op: "local.get", index: objLocal },
                { op: "ref.as_non_null" },
                ...nativeStringLiteralInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
                { op: "extern.convert_any" },
                { op: "call", funcIdx: objFindIdx },
                { op: "local.set", index: slotLocal },
                { op: "local.get", index: slotLocal },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                { op: "if", blockType: { kind: "empty" }, then: classify },
                ...plainArm,
              ],
            },
          ],
        },
      ],
    },
  ];
  return { instrs, locals };
}
