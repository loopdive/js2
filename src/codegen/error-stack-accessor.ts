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
 * Steps 3-4 go through `__getOwnPropertyDescriptor` / `__defineProperty_value`
 * / `__extern_set_strict` rather than touching the object directly, because
 * each of those carries the Proxy front guard: on a proxy receiver they run the
 * `getOwnPropertyDescriptor`, `defineProperty` and `set` traps, which is what
 * the three `setter-proxy-*` rows observe (including a trap that returns false
 * → TypeError, and a trap that throws → the completion propagates).
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

  // Steps 3-4. Both branches run through a Proxy-aware helper, so a trap that
  // returns false throws and a trap that throws propagates — neither is
  // special-cased here.
  const create: Instr[] = [
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "stack"),
    { op: "local.get", index: 2 },
    { op: "f64.const", value: CREATE_DATA_PROPERTY_FLAGS },
    { op: "call", funcIdx: defineValueIdx },
    // `__defineProperty_value` hands the target back; `__extern_set_strict`
    // returns nothing, so drop it or the two arms of the `if` disagree.
    { op: "drop" },
  ];
  const assign: Instr[] = [
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "stack"),
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: strictSetIdx },
  ];

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
