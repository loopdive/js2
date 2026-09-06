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
 * The chain hop is an ITERATION, not a self-call: a native cannot bake its own
 * funcIdx at registration time, and `§10.1.9.2` recurses only in tail position,
 * so the loop is exactly equivalent and needs no reserve-then-fill dance.
 *
 * ## What this deliberately does NOT do
 *
 * A `$Proxy` reached as a PROTOTYPE of `O` is consulted through
 * `__getOwnPropertyDescriptor` (its `getOwnPropertyDescriptor` trap) rather
 * than through its own §10.5.9 `set` trap, which is what the spec's
 * `parent.[[Set]](P, V, Receiver)` would do. That is a residual, recorded in
 * #5316: it can under-report a proxy prototype's refusal, never invent one. A
 * proxy passed as the direct TARGET is unaffected — the front guard on
 * `__getOwnPropertyDescriptor` puts its own trap in the first iteration, and a
 * proxy passed as the RECEIVER is likewise consulted through that guard.
 *
 * The write itself is `__extern_set`, not `__obj_define_from_desc(receiver,
 * key, {value})`. For an ABSENT receiver property that is exactly
 * CreateDataProperty (measured: an ordinary dynamic write produces W/E/C all
 * true, probe `r3`), and for a PRESENT writable data property it preserves the
 * property's existing enumerable/configurable attributes, which a rebuilt
 * descriptor would flatten to the defaults.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** `(target, key, value, receiver) -> i32`. */
export const REFLECT_SET_RECEIVER = "__reflect_set_receiver";

type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/**
 * Register {@link REFLECT_SET_RECEIVER}. Returns `undefined` when a primitive
 * it needs is missing — the call site then keeps the pre-#5316 refusal rather
 * than emitting a half-implemented `[[Set]]`.
 *
 * MUST be called after the descriptor helpers and the accessor driver are in
 * `ctx.funcMap`; it reads them, mints nothing of its own beyond the one native,
 * and is therefore append-only in the registration order.
 */
export function registerOrdinarySetWithReceiver(
  ctx: CodegenContext,
  registerNative: RegisterNative,
): number | undefined {
  if (!ctx.standalone) return undefined;
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
  for (const key of ["writable", "get", "set"]) addStringConstantGlobal(ctx, key);

  // params 0=target 1=key 2=value 3=receiver
  const O = 4;
  const OWN = 5;
  const PARENT = 6;
  const TMP = 7;

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
  const refuse = (): Instr[] => [{ op: "i32.const", value: 0 }, { op: "return" }];
  /** `if (<i32>) return false` — consumes the condition. */
  const refuseIf = (): Instr[] => [{ op: "if", blockType: { kind: "empty" }, then: refuse() }];

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
      // Step 3.e: absent ⇒ CreateDataProperty(Receiver, P, V) — an ordinary
      // dynamic write, which is W/E/C all true.
      then: [
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
    // Step 3.d.iv: write `{[[Value]]: V}`. `__extern_set` preserves the
    // property's existing attributes; rebuilding a descriptor would not.
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

  return registerNative(
    REFLECT_SET_RECEIVER,
    [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF],
    [I32],
    [
      { name: "o", type: EXTERNREF },
      { name: "own", type: EXTERNREF },
      { name: "parent", type: EXTERNREF },
      { name: "tmp", type: EXTERNREF },
    ],
    body,
  );
}
