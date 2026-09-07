// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5316 r5 step 6 / #2046) §10.1.9.2 OrdinarySetWithOwnDescriptor — the
 * receiver-threaded `[[Set]]` that `Reflect.set(target, key, value, receiver)`
 * needs.
 *
 * ## Why a separate helper rather than a fourth parameter on `__reflect_set`
 *
 * `__reflect_set` IS `OrdinarySet` with `Receiver === O`. Every one of its arms
 * decides *and writes* on the same object, and its write is `__extern_set`,
 * which resolves the receiver from its own first argument. Threading a distinct
 * receiver through it would mean re-deciding every arm, so the two-receiver
 * walk lives here and the three-argument path keeps its byte-identical
 * lowering. `call-namespace-static.ts` routes only the 4-argument form here.
 *
 * ## The walk
 *
 * §10.1.9.2 is a loop up `O`'s prototype chain looking for an own descriptor,
 * and every decision after that is about the RECEIVER, not about `O`:
 *
 * - own data descriptor, non-writable      ⇒ false
 * - receiver is not an Object              ⇒ false
 * - receiver's own descriptor is accessor  ⇒ false
 * - receiver's own descriptor non-writable ⇒ false
 * - otherwise write on the RECEIVER        ⇒ true
 * - own accessor with no `[[Set]]`         ⇒ false
 * - own accessor with a setter             ⇒ `Call(setter, Receiver, «V»)`
 * - chain exhausted                        ⇒ the default `{W,E,C: true}` data
 *   descriptor, i.e. CreateDataProperty on the receiver
 *
 * The chain hop up the ORDINARY prototype chain is an ITERATION, not a
 * self-call: `§10.1.9.2` recurses only in tail position, so the loop is exactly
 * equivalent.
 *
 * ## Where a `$Proxy` enters the walk (#5316 review r1 F2)
 *
 * A `$Proxy` in the `O` position — the direct target on the first iteration, a
 * prototype on any later one — is NOT walked ordinarily. The loop tests for it
 * FIRST and hands the operation to `__proxy_set_receiver_dispatch`, §10.5.9
 * [[Set]] with the caller's receiver threaded through: the `set` trap runs, its
 * boolean is the answer, and the §10.5.9 step 9-10 invariants are checked. Its
 * trap-ABSENT arm is step 6 `target.[[Set]](P, V, Receiver)` — this walk again
 * on the proxy's target, receiver unchanged.
 *
 * The two therefore call each other, which is why this module RESERVES its
 * funcIdx (`reserveOrdinarySetWithReceiver`, before `ensureProxyRuntime`) and
 * FILLS the body afterwards (`fillOrdinarySetWithReceiver`) — the same
 * reserve-then-fill `reserveDriver` uses for the trap-invoke drivers. Until
 * that dispatch existed the walk asked such an `O` for
 * `__getOwnPropertyDescriptor` instead, which runs its `getOwnPropertyDescriptor`
 * trap and then writes ordinarily, so the `set` trap the program installed never
 * saw the write.
 *
 * ## The write on the receiver
 *
 * `__extern_set` for an ORDINARY receiver: for an ABSENT property that is
 * exactly CreateDataProperty (measured: an ordinary dynamic write produces
 * W/E/C all true, probe `r3`), and for a PRESENT writable data property it
 * preserves the existing enumerable/configurable attributes that a rebuilt
 * descriptor would flatten.
 *
 * For a `$Proxy` receiver it is the real `[[DefineOwnProperty]]` instead (F1) —
 * `__extern_set` would drive the receiver's `set` trap, which is a different
 * trap and whose refusal `Reflect.set` then discarded.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

/** `__create_descriptor`'s attribute bits: writable (0x01) | enumerable (0x02)
 *  | configurable (0x04) — the §7.3.5 CreateDataProperty descriptor. */
const DESC_FLAGS_ALL = 0x07;

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** `(target, key, value, receiver) -> i32`. */
export const REFLECT_SET_RECEIVER = "__reflect_set_receiver";

/** The primitives the walk bakes. All of them or none — a half-built `[[Set]]`
 *  is worse than the pre-#5316 refusal. */
interface SetWalkPrimitives {
  gopdIdx: number;
  getProtoIdx: number;
  externGetIdx: number;
  externHasIdx: number;
  externSetIdx: number;
  isTruthyIdx: number;
  isUndefinedIdx: number;
  callSetterIdx: number;
}

function resolveSetWalkPrimitives(ctx: CodegenContext): SetWalkPrimitives | undefined {
  const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const getProtoIdx = ctx.funcMap.get("__getPrototypeOf");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externHasIdx = ctx.funcMap.get("__extern_has");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const callSetterIdx = ctx.funcMap.get("__call_accessor_set");
  if (
    gopdIdx === undefined ||
    getProtoIdx === undefined ||
    externGetIdx === undefined ||
    externHasIdx === undefined ||
    externSetIdx === undefined ||
    isTruthyIdx === undefined ||
    isUndefinedIdx === undefined ||
    callSetterIdx === undefined
  ) {
    return undefined;
  }
  return {
    gopdIdx,
    getProtoIdx,
    externGetIdx,
    externHasIdx,
    externSetIdx,
    isTruthyIdx,
    isUndefinedIdx,
    callSetterIdx,
  };
}

/** The small predicate/field emitters the walk is written in terms of. */
interface SetWalkEmitters {
  absent: (l: number) => Instr[];
  keyOf: (name: string) => Instr[];
  getField: (l: number, name: string) => Instr[];
  isAccessor: (l: number) => Instr[];
  notObject: (l: number) => Instr[];
  refuseIf: () => Instr[];
}

/** Every emitter is a FACTORY — a shared `Instr[]` spliced into two arms is
 *  remapped twice by the finalize funcIdx walk. */
function makeSetWalkEmitters(ctx: CodegenContext, prims: SetWalkPrimitives): SetWalkEmitters {
  const { externGetIdx, externHasIdx, isUndefinedIdx } = prims;
  /** 1 when the value in `l` is "absent" — null OR the undefined singleton.
   *  `__getOwnPropertyDescriptor` / `__getPrototypeOf` answer a miss with
   *  whichever of the two the module's undefined regime uses (#2106). */
  const absent = (l: number): Instr[] => [
    { op: "local.get", index: l },
    { op: "ref.is_null" },
    { op: "local.get", index: l },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
  ];
  const keyOf = (name: string): Instr[] => stringConstantExternrefInstrs(ctx, name);
  const getField = (l: number, name: string): Instr[] => [
    { op: "local.get", index: l },
    ...keyOf(name),
    { op: "call", funcIdx: externGetIdx },
  ];
  const hasField = (l: number, name: string): Instr[] => [
    { op: "local.get", index: l },
    ...keyOf(name),
    { op: "call", funcIdx: externHasIdx },
  ];
  /** `IsAccessorDescriptor(l)` — §6.2.6.1: it has `[[Get]]` or `[[Set]]`.
   *  Read as PRESENCE, not as truthiness: `{get: undefined, set: undefined}` is
   *  an accessor descriptor and must refuse, where reading `set` and finding
   *  `undefined` would misclassify it as data and write through. */
  const isAccessor = (l: number): Instr[] => [...hasField(l, "set"), ...hasField(l, "get"), { op: "i32.or" }];
  /** Not-Object by EXCLUSION, the classification `buildOwnKeysDispatch` and the
   *  §10.5 validators already use: `__typeof_object` alone answers true for a
   *  boxed boolean carrier, so a `false` receiver would read as an Object. */
  const primitiveTestIdx = ["__typeof_number", "__typeof_boolean", "__typeof_string", "__typeof_bigint"]
    .map((name) => ctx.funcMap.get(name))
    .filter((idx): idx is number => idx !== undefined);
  const symbolTypeIdx = ctx.symbolTypeIdx;
  const notObject = (l: number): Instr[] => {
    const out: Instr[] = [{ op: "local.get", index: l }, { op: "ref.is_null" }];
    for (const funcIdx of [...primitiveTestIdx, isUndefinedIdx]) {
      out.push({ op: "local.get", index: l }, { op: "call", funcIdx }, { op: "i32.or" });
    }
    if (symbolTypeIdx >= 0) {
      out.push(
        { op: "local.get", index: l },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: symbolTypeIdx },
        { op: "i32.or" },
      );
    }
    return out;
  };
  /** `if (<i32>) return false` — consumes the condition. */
  const refuseIf = (): Instr[] => [
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
  ];
  return { absent, keyOf, getField, isAccessor, notObject, refuseIf };
}

/**
 * (#5316 review r1 F2) RESERVE {@link REFLECT_SET_RECEIVER}'s funcIdx with a
 * placeholder body, BEFORE `ensureProxyRuntime`. Returns `undefined` — nothing
 * minted — when a primitive the walk needs is missing, and the call site then
 * keeps the pre-#5316 refusal.
 *
 * Why reserve-then-fill rather than one registration: the walk and the §10.5.9
 * proxy dispatch call EACH OTHER. The walk consults a `$Proxy` in the `O`
 * position through its `set` trap; that trap's ABSENT arm is §10.5.9 step 6
 * `target.[[Set]](P, V, Receiver)`, which is this walk again. A native cannot
 * bake a funcIdx that does not exist yet, so one of the two has to be a
 * reservation — the same pattern `reserveDriver` uses for the trap-invoke
 * drivers in `object-runtime-proxy.ts`.
 */
export function reserveOrdinarySetWithReceiver(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(REFLECT_SET_RECEIVER);
  if (existing !== undefined) return existing;
  if (resolveSetWalkPrimitives(ctx) === undefined) return undefined;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: REFLECT_SET_RECEIVER,
    typeIdx,
    locals: [],
    // Placeholder, replaced by `fillOrdinarySetWithReceiver`. A bare `false`
    // keeps the stub valid (i32 result) if the fill is ever skipped.
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  ctx.funcMap.set(REFLECT_SET_RECEIVER, funcIdx);
  return funcIdx;
}

/**
 * Fill the reserved {@link REFLECT_SET_RECEIVER} body. MUST run AFTER
 * `ensureProxyRuntime` — it reads `__proxy_set_receiver_dispatch` — and after
 * the descriptor helpers and the accessor driver are in `ctx.funcMap`. Mints
 * nothing, so no funcIdx moves.
 */
export function fillOrdinarySetWithReceiver(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const funcIdx = ctx.funcMap.get(REFLECT_SET_RECEIVER);
  if (funcIdx === undefined) return undefined;
  const func = definedFuncAt(ctx, funcIdx);
  if (!func) return undefined;
  const prims = resolveSetWalkPrimitives(ctx);
  if (prims === undefined) return undefined;
  const { gopdIdx, getProtoIdx, externGetIdx, externHasIdx, externSetIdx, isTruthyIdx, isUndefinedIdx, callSetterIdx } =
    prims;
  for (const key of ["writable", "get", "set", "value"]) addStringConstantGlobal(ctx, key);

  // (#5316 review r1 F1) A `$Proxy` RECEIVER takes its writes through
  // `[[DefineOwnProperty]]`, not through `[[Set]]`. All four primitives are
  // optional: without them the arm is simply not emitted and the receiver keeps
  // the `__extern_set` write, which is what the lane shipped.
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  const createDescIdx = ctx.funcMap.get("__create_descriptor");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const defineFromDescIdx = ctx.funcMap.get("__obj_define_from_desc");
  const proxyReceiverDefineRoute =
    proxyTypeIdx !== undefined &&
    proxyTypeIdx >= 0 &&
    createDescIdx !== undefined &&
    newPlainObjectIdx !== undefined &&
    defineFromDescIdx !== undefined;
  const proxyCarrierPresent = proxyTypeIdx !== undefined && proxyTypeIdx >= 0;
  /** `1` when the value in `l` is a standalone `$Proxy` carrier. */
  const isProxy = (l: number): Instr[] =>
    proxyCarrierPresent
      ? [{ op: "local.get", index: l }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: proxyTypeIdx }]
      : [{ op: "i32.const", value: 0 }];
  // (#5316 review r1 F2) §10.5.9 [[Set]] with an explicit receiver — the ONE
  // implementation of the set-trap protocol, shared with `__extern_set`'s
  // 3-argument front guard (`object-runtime-proxy.ts` builds both from the same
  // `buildDispatch`). Absent on a tree without the Proxy carrier ⇒ no arm.
  const proxySetReceiverIdx = proxyCarrierPresent ? ctx.funcMap.get("__proxy_set_receiver_dispatch") : undefined;

  // params 0=target 1=key 2=value 3=receiver
  const O = 4;
  const OWN = 5;
  const PARENT = 6;
  const TMP = 7;

  const { absent, keyOf, getField, isAccessor, notObject, refuseIf } = makeSetWalkEmitters(ctx, prims);

  /**
   * §10.1.9.2 steps 3.b-3.f: everything after "the own descriptor is a WRITABLE
   * data descriptor". A FACTORY — this is spliced into two arms of the same
   * body (an own writable data property, and the chain-exhausted default
   * descriptor), and aliasing one `Instr[]` into both makes the finalize funcIdx
   * walk remap it twice (`reference_shared_instr_object_dce_double_remap`).
   */
  const writeOnReceiver = (): Instr[] => [
    // Step 3.b: Receiver must be an Object.
    ...notObject(3),
    ...refuseIf(),
    // Step 3.c: existingDescriptor = Receiver.[[GetOwnProperty]](P).
    { op: "local.get", index: 3 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: gopdIdx },
    { op: "local.set", index: TMP },
    ...absent(TMP),
    {
      op: "if",
      blockType: { kind: "empty" },
      // Step 3.e: absent ⇒ CreateDataProperty(Receiver, P, V).
      then: [
        // (#5316 review r1 F1) On a `$Proxy` receiver CreateDataProperty is
        // §7.3.5 → `Receiver.[[DefineOwnProperty]](P, {[[Value]]: V,
        // [[Writable]]: true, [[Enumerable]]: true, [[Configurable]]: true})`,
        // so it is the receiver's `defineProperty` trap that runs (with the
        // §10.5.6 invariant checks), NOT its `set` trap — and `Reflect.set`
        // answers THAT trap's boolean. Routing this through `__extern_set`
        // drove the wrong trap and discarded its refusal.
        ...(proxyReceiverDefineRoute
          ? ([
              ...isProxy(3),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 3 },
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: DESC_FLAGS_ALL },
                  { op: "call", funcIdx: createDescIdx! },
                  { op: "call", funcIdx: defineFromDescIdx! },
                  { op: "call", funcIdx: isTruthyIdx },
                  { op: "return" },
                ],
              },
            ] satisfies Instr[])
          : []),
        { op: "local.get", index: 3 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: externSetIdx },
        { op: "i32.const", value: 1 },
        { op: "return" },
      ],
    },
    // Step 3.d.i / 3.d.ii: an accessor, or a non-writable data property, on the
    // receiver refuses the write.
    ...isAccessor(TMP),
    ...refuseIf(),
    ...getField(TMP, "writable"),
    { op: "call", funcIdx: isTruthyIdx },
    { op: "i32.eqz" },
    ...refuseIf(),
    // Step 3.d.iv: `Receiver.[[DefineOwnProperty]](P, {[[Value]]: V})` — the
    // descriptor carries the VALUE FIELD ALONE, so the property keeps its
    // existing enumerable/configurable attributes. On an ordinary receiver
    // `__extern_set` IS that write and preserves them; on a `$Proxy` receiver
    // only the real define route reaches the `defineProperty` trap (F1).
    ...(proxyReceiverDefineRoute
      ? ([
          ...isProxy(3),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // tmp = {}; tmp.value = V   (a value-only descriptor)
              { op: "call", funcIdx: newPlainObjectIdx! },
              { op: "local.set", index: TMP },
              { op: "local.get", index: TMP },
              ...keyOf("value"),
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: externSetIdx },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "local.get", index: TMP },
              { op: "call", funcIdx: defineFromDescIdx! },
              { op: "call", funcIdx: isTruthyIdx },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: 3 },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: externSetIdx },
    { op: "i32.const", value: 1 },
    { op: "return" },
  ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.set", index: O },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        // (#5316 review r1 F2) `O` is a `$Proxy` ⇒ §10.5.9 [[Set]], not the
        // ordinary walk. This sits INSIDE the loop, so it covers both spellings
        // the spec distinguishes: the direct TARGET on the first iteration
        // (§26.1.13 step 3 `target.[[Set]](key, V, receiver)`) and a PROTOTYPE
        // reached later (§10.1.9.2 step 2.b `parent.[[Set]](P, V, Receiver)`).
        // Asking such an `O` for `__getOwnPropertyDescriptor` instead runs its
        // `getOwnPropertyDescriptor` trap and then writes ordinarily — the trap
        // the program installed never sees the write at all.
        ...(proxySetReceiverIdx === undefined
          ? []
          : ([
              ...isProxy(O),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: O },
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 2 },
                  { op: "local.get", index: 3 },
                  { op: "call", funcIdx: proxySetReceiverIdx },
                  { op: "call", funcIdx: isTruthyIdx },
                  { op: "return" },
                ],
              },
            ] satisfies Instr[])),
        // ownDesc = O.[[GetOwnProperty]](P)
        { op: "local.get", index: O },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: gopdIdx },
        { op: "local.set", index: OWN },
        ...absent(OWN),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          // Own descriptor found — every path below returns.
          then: [
            ...isAccessor(OWN),
            {
              op: "if",
              blockType: { kind: "empty" },
              // Step 4: accessor. No `[[Set]]` ⇒ false; otherwise call the
              // setter with the RECEIVER as its `this`.
              then: [
                ...getField(OWN, "set"),
                { op: "local.set", index: TMP },
                ...absent(TMP),
                ...refuseIf(),
                { op: "local.get", index: 3 },
                { op: "local.get", index: TMP },
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: callSetterIdx },
                { op: "i32.const", value: 1 },
                { op: "return" },
              ],
            },
            // Step 3.a: a non-writable own data property refuses.
            ...getField(OWN, "writable"),
            { op: "call", funcIdx: isTruthyIdx },
            { op: "i32.eqz" },
            ...refuseIf(),
            ...writeOnReceiver(),
          ],
        },
        // Step 2: no own descriptor — walk to the parent.
        { op: "local.get", index: O },
        { op: "call", funcIdx: getProtoIdx },
        { op: "local.set", index: PARENT },
        ...absent(PARENT),
        {
          op: "if",
          blockType: { kind: "empty" },
          // Chain exhausted ⇒ the default `{[[Value]]: undefined, [[Writable]]:
          // true, [[Enumerable]]: true, [[Configurable]]: true}` descriptor,
          // which is data and writable, so only the receiver half remains.
          then: writeOnReceiver(),
        },
        { op: "local.get", index: PARENT },
        { op: "local.set", index: O },
        { op: "br", depth: 0 },
      ],
    },
    // Unreachable — the loop's last instruction is an unconditional `br`, and
    // every other exit returns. Present so the function's i32 result validates.
    { op: "i32.const", value: 0 },
  ];

  func.locals = [
    { name: "o", type: EXTERNREF },
    { name: "own", type: EXTERNREF },
    { name: "parent", type: EXTERNREF },
    { name: "tmp", type: EXTERNREF },
  ];
  func.body = body;
  return funcIdx;
}
