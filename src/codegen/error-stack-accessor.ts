// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5269 D-2) Native bodies for the own `Error.prototype.stack` accessor PAIR
 * (the error-stack-accessor proposal), under standalone.
 *
 * `stack` is the one Error.prototype property that is neither a method nor a
 * data property: it is a getter/setter pair, and both halves are ordinary
 * function values that the tests reflect on (`isConstructor(get) === false`,
 * `new get()` throws). `native-proto.ts`'s `accessorProps` glue kind (D-1)
 * seeds the pair; this module supplies the two bodies.
 *
 * **getter** — `get Error.prototype.stack`:
 *   1. `E` is not an Object → TypeError.
 *   2. `E` has no [[ErrorData]] → **undefined**. A Proxy has no [[ErrorData]]
 *      of its own no matter what it wraps, so a Proxy over an Error answers
 *      undefined and NO trap fires — `getter-receiver-is-proxy.js` asserts
 *      exactly that, and it is why this arm tests the `$Error_struct` carrier
 *      directly instead of routing through any property helper.
 *   3. otherwise → an implementation-defined string. Standalone has no
 *      stack-capture primitive, so `""` is the honest answer; the tests check
 *      `typeof === "string"`.
 *
 * **setter** — SetterThatIgnoresPrototypeProperties:
 *   1. `E` is not an Object → TypeError.
 *   2. `E` IS the home object (`Error.prototype` itself) → TypeError. A PROXY
 *      of the home object is NOT the home object, so it falls through to the
 *      traps (`setter-proxy-wrapping-prototype.js`).
 *   3. no own `stack` → CreateDataPropertyOrThrow(E, "stack", v).
 *   4. own `stack` → Set(E, "stack", v, true).
 *
 * Steps 3-4 go through `__getOwnPropertyDescriptor` (which DOES carry the Proxy
 * front guard, so the `getOwnPropertyDescriptor` trap runs) and then split on
 * the receiver — see {@link emitProxyReceiverArms} for why the define/assign
 * halves cannot simply reuse `__defineProperty_value` / `__extern_set_strict`
 * when the receiver is a `$Proxy`.
 *
 * Every entry point returns `null` — having emitted NOTHING — when its
 * substrate is missing, so the glue ladder falls through byte-identically.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/** The two synthetic member names the glue mints the pair's closures under. */
export const ERROR_STACK_GETTER_MEMBER = "get stack";
export const ERROR_STACK_SETTER_MEMBER = "set stack";

/**
 * §17 data attributes for the property the setter CREATES:
 * `{ writable: true, enumerable: true, configurable: true }` —
 * CreateDataPropertyOrThrow's defaults, not the accessor's own attributes.
 */
const CREATE_DATA_PROPERTY_FLAGS = 0x01 | 0x02 | 0x04;

/** WasmGC `eq` abstract heap type — the operand type `ref.eq` requires. */
const EQ_HEAP_TYPE = -19;

/**
 * The `(externref) -> i32` primitive predicates the §1 receiver check consults.
 * Symbol is absent BY NECESSITY — see {@link emitThisIsObjectCheck}.
 */
const PRIMITIVE_TYPEOF_PREDICATES: readonly string[] = [
  "__typeof_number",
  "__typeof_string",
  "__typeof_boolean",
  "__typeof_bigint",
];

/**
 * Emit `[E is not an Object] → TypeError`, the step both halves share.
 *
 * (#6493 round 2) This used to test only the null externref and the #2106
 * `$undefined` singleton, on the reasoning that "a boxed primitive receiver
 * reaches the closure as a wrapper object here". That is NOT true on the
 * first-class `get.call(1)` path: the receiver arrives as the raw boxed
 * primitive, so `get.call(true)` / `(1)` / `("")` / `(0n)` / `(Symbol())`
 * answered `undefined` instead of throwing — measured, and the reason
 * `built-ins/Error/prototype/stack/{getter,setter}-this-not-object.js` passed
 * only while `Function.prototype.call` itself still refused.
 *
 * The widening is a UNION OF POSITIVE PRIMITIVE TESTS, never a "not an object"
 * probe, so it cannot start rejecting genuine objects:
 *
 *  - the four `__typeof_*` predicates answer FALSE for the corresponding
 *    WRAPPER object — that is exactly why `emitObjectProtoToStringClassifier`
 *    needs its separate `[[PrimitiveValue]]` arm to tag `new String("x")` as
 *    `[object String]` (without it that receiver measured `[object Object]`).
 *  - Symbol has **no** `__typeof_symbol` anywhere in the tree — it is only ever
 *    looked up and never registered, which both `reflect-target-guard.ts` and
 *    `object-runtime-proxy.ts` document. The host-free discriminator is a
 *    `ref.test` against the native `$Symbol` carrier, which is what they fall
 *    back to and what is used here.
 *
 * `__extern_is_object` is deliberately NOT used: every call site registers it
 * through `ensureLateImport` and `src/runtime.ts` implements it in JavaScript,
 * so it is a HOST IMPORT. Reaching for it would put an entry in
 * `result.imports`, which the standalone lane must keep empty.
 *
 * Each arm is skipped when its predicate/carrier is absent from the module, so
 * a module that never mints one stays byte-identical.
 */
function emitThisIsObjectCheck(ctx: CodegenContext, fctx: FunctionContext, what: string): void {
  const guard: Instr[] = [{ op: "local.get", index: 1 }, { op: "ref.is_null" }];
  const orTest = (test: Instr[]): void => {
    guard.push(...test, { op: "i32.or" });
  };
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (isUndefinedIdx !== undefined) {
    orTest([
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: isUndefinedIdx },
    ]);
  }
  for (const name of PRIMITIVE_TYPEOF_PREDICATES) {
    const funcIdx = ctx.funcMap.get(name);
    if (funcIdx === undefined) continue;
    orTest([
      { op: "local.get", index: 1 },
      { op: "call", funcIdx },
    ]);
  }
  if (ctx.symbolTypeIdx >= 0) {
    orTest([
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
    ]);
  }
  const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", what, { flush: fctx });
  fctx.body.push(...guard, { op: "if", blockType: { kind: "empty" }, then: throwInstrs });
}

/** The two arms {@link emitProxyReceiverArms} builds, or `undefined` to decline. */
interface ProxyReceiverArms {
  /** §CreateDataPropertyOrThrow steps 3-4 against a `$Proxy` receiver. */
  create: Instr[];
  /** §Set(O, P, V, true) steps 3-4 against a `$Proxy` receiver. */
  assign: Instr[];
}

/**
 * (#6493 S4) Steps 3-4 for a `$Proxy` receiver, where the ordinary helpers
 * cannot report the spec's SUCCESS BOOLEAN.
 *
 * `setter-proxy-trap-rejects.js` asks for the two TypeErrors a falsy trap
 * result owes: CreateDataPropertyOrThrow step 4 and Set step 4. Neither
 * ordinary helper can answer them, and the reasons differ:
 *
 *  - `__defineProperty_value(o, k, v, flags)` returns `o`, not a boolean, and
 *    carries NO Proxy front guard at all (only `__obj_define_from_desc` does).
 *    Measured on this branch: `set.call(new Proxy({}, {defineProperty: () =>
 *    false}), 'v')` ran the ordinary `$Object` store — the trap never fired
 *    (`n === 0`), so neither a `false` return NOR a throwing trap was
 *    observable. That is the whole of the lost row.
 *  - `__extern_set_strict` DOES reach the `set` trap (through `__reflect_set`'s
 *    front guard), but on the #4504 result-channel build it DROPS
 *    `__reflect_set`'s boolean and reads the shared channel instead — which the
 *    proxy front guard returns before ever writing. Measured: a `set` trap
 *    returning `false` completed silently.
 *
 * The success bit exists already, on the dispatchers themselves. Both are
 * `registerNative` STANDALONE natives (`object-runtime-proxy.ts`), as are
 * `__create_descriptor` (`object-runtime-descriptors.ts`) and `__is_truthy`
 * (`registry/imports.ts`), so this arm adds NOTHING to `result.imports` — the
 * distinction that ruled `__extern_is_object` out in round 2.
 *
 * **`__proxy_set_receiver_dispatch`, not `__proxy_set_dispatch`.** The 3-param
 * `__proxy_set_dispatch` answers `ref.null.extern` on its trap-ABSENT arm — a
 * documented placeholder that `__extern_set`'s front guard drops rather than
 * reads. `__is_truthy(null)` is 0, so believing that result would throw on
 * every trap-absent proxy (`setter-receiver-is-proxy.js`,
 * `setter-proxy-wrapping-prototype.js`). The 4-param
 * `__proxy_set_receiver_dispatch` owns its answer on BOTH arms: trap present →
 * the trap's booleanish result; trap absent → `__box_boolean` of
 * `__reflect_set_receiver`. It is also the spec's own shape —
 * §Set(O, P, V, true) is `O.[[Set]](P, V, O)`, receiver = the proxy — and it is
 * exactly where `__extern_set_strict` was already routing this write, so the
 * SIDE EFFECTS are unchanged and only the missing throw is added.
 *
 * The trap runs EXACTLY ONCE: the result is consumed straight from the
 * dispatch, never inferred by re-reading the property (which would add an
 * observable `getOwnPropertyDescriptor` trap call).
 *
 * Returns `undefined` — having built nothing and registered nothing — when any
 * dependency is missing, so the setter keeps its current body verbatim.
 */
function emitProxyReceiverArms(ctx: CodegenContext, fctx: FunctionContext): ProxyReceiverArms | undefined {
  // Probe first: `buildThrowJsErrorInstrs` interns a string constant, so it
  // must not run on a module that will decline.
  for (const name of [
    "__proxy_define_dispatch",
    "__proxy_set_receiver_dispatch",
    "__create_descriptor",
    "__is_truthy",
  ]) {
    if (ctx.funcMap.get(name) === undefined) return undefined;
  }
  const createRefused = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Cannot create property 'stack' on the Error.prototype.stack setter's receiver",
    { flush: fctx },
  );
  const assignRefused = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Cannot assign to property 'stack' on the Error.prototype.stack setter's receiver",
    { flush: fctx },
  );
  // Re-read AFTER both throws: either may register an error constructor as a
  // late import, which renumbers every function index.
  const defineDispatchIdx = ctx.funcMap.get("__proxy_define_dispatch")!;
  const setDispatchIdx = ctx.funcMap.get("__proxy_set_receiver_dispatch")!;
  const createDescriptorIdx = ctx.funcMap.get("__create_descriptor")!;
  const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
  /** `<booleanish externref on the stack>` → throw when ToBoolean is false. */
  const throwUnless = (refused: Instr[]): Instr[] => [
    { op: "call", funcIdx: isTruthyIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: refused },
  ];
  return {
    create: [
      { op: "local.get", index: 1 },
      ...stringConstantExternrefInstrs(ctx, "stack"),
      // §CreateDataProperty builds the descriptor; `__create_descriptor` takes
      // the SAME flag encoding `__defineProperty_value` decodes, as an i32.
      { op: "local.get", index: 2 },
      { op: "i32.const", value: CREATE_DATA_PROPERTY_FLAGS },
      { op: "call", funcIdx: createDescriptorIdx },
      { op: "call", funcIdx: defineDispatchIdx },
      ...throwUnless(createRefused),
    ],
    assign: [
      { op: "local.get", index: 1 },
      ...stringConstantExternrefInstrs(ctx, "stack"),
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 }, // Receiver — §Set passes O itself.
      { op: "call", funcIdx: setDispatchIdx },
      ...throwUnless(assignRefused),
    ],
  };
}

/** `get Error.prototype.stack` (ABI: local 0 = self, local 1 = `this`). */
export function emitErrorStackGetterBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;
  const errTypeIdx = ctx.errorStructTypeIdx;
  if (errTypeIdx < 0) return null;

  // Intern BEFORE the body is built — `stringConstantExternrefInstrs` resolves
  // through `ctx.stringGlobalMap`, so a constant not registered first emits
  // nothing usable (the same ordering `emitErrorStructConstructor` documents).
  addStringConstantGlobal(ctx, "");

  emitThisIsObjectCheck(ctx, fctx, "get Error.prototype.stack called on a non-object");

  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: errTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      // Implementation-defined. `""` is a string, which is all the proposal
      // and the tests require of it.
      then: [...stringConstantExternrefInstrs(ctx, "")],
      // No [[ErrorData]] — including every Proxy, whatever it wraps.
      else: [{ op: "ref.null.extern" }],
    },
  );
  return { kind: "externref" };
}

/**
 * `set Error.prototype.stack` (ABI: local 0 = self, local 1 = `this`,
 * local 2 = the value).
 */
export function emitErrorStackSetterBody(ctx: CodegenContext, fctx: FunctionContext, brand: number): ValType | null {
  if (!ctx.standalone) return null;
  const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const defineValueIdx = ctx.funcMap.get("__defineProperty_value");
  const strictSetIdx = ctx.funcMap.get("__extern_set_strict");
  if (gopdIdx === undefined || defineValueIdx === undefined || strictSetIdx === undefined) return null;

  addStringConstantGlobal(ctx, "stack");

  emitThisIsObjectCheck(ctx, fctx, "set Error.prototype.stack called on a non-object");

  // Step 2 — the home object itself is refused. `emitLazyNativeProtoGet` leaves
  // the brand's prototype on the stack, so this is an IDENTITY compare: a Proxy
  // wrapping that prototype is a different reference and goes on to its traps.
  const homeThrow = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Cannot assign to the Error.prototype.stack accessor's home object",
    { flush: fctx },
  );
  const homeProbe: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.body = homeProbe;
    const ok = emitLazyNativeProtoGet(ctx, fctx, brand);
    fctx.body = saved;
    if (ok) {
      // `ref.eq` takes eqref, not anyref, so both sides are `ref.test`-ed and
      // cast to the `eq` abstract heap type first. A value that is not even
      // eq-comparable cannot be the home object, so it short-circuits to false
      // rather than trapping on the cast.
      fctx.body.push(
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            ...homeProbe,
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "ref.eq" },
            { op: "if", blockType: { kind: "empty" }, then: homeThrow },
          ],
        },
      );
    }
  }

  const descLocal = allocLocal(fctx, `__stackset_desc_${fctx.locals.length}`, { kind: "externref" });

  // Steps 3-4 for an ORDINARY receiver. Unchanged, and reached byte-for-byte
  // unchanged whenever the receiver is not a `$Proxy`.
  const ordinaryCreate: Instr[] = [
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "stack"),
    { op: "local.get", index: 2 },
    { op: "f64.const", value: CREATE_DATA_PROPERTY_FLAGS },
    { op: "call", funcIdx: defineValueIdx },
    // `__defineProperty_value` hands the target back; `__extern_set_strict`
    // returns nothing, so drop it or the two arms of the `if` disagree.
    { op: "drop" },
  ];
  const ordinaryAssign: Instr[] = [
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "stack"),
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: strictSetIdx },
  ];

  // (#6493 S4) A `$Proxy` receiver takes the dispatcher arms, which carry the
  // spec's success boolean; everything else keeps the arms above as the `else`.
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx ?? -1;
  const proxyArms = proxyTypeIdx >= 0 ? emitProxyReceiverArms(ctx, fctx) : undefined;
  const splitOnReceiver = (proxyArm: Instr[], ordinary: Instr[]): Instr[] =>
    proxyArms === undefined
      ? ordinary
      : [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: proxyTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: proxyArm, else: ordinary },
        ];
  const create = splitOnReceiver(proxyArms?.create ?? [], ordinaryCreate);
  const assign = splitOnReceiver(proxyArms?.assign ?? [], ordinaryAssign);

  fctx.body.push(
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "stack"),
    { op: "call", funcIdx: gopdIdx },
    { op: "local.tee", index: descLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: create, else: assign },
    // A setter's completion value is undefined.
    { op: "ref.null.extern" },
  );
  return { kind: "externref" };
}
