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
 * Emit `[E is not an Object] → TypeError`, the step both halves share.
 *
 * NARROW ON PURPOSE: it rejects the null externref and the #2106 `$undefined`
 * singleton — `get.call()` and `get.call(undefined)`. A boxed primitive
 * receiver reaches the closure as a wrapper object here, so widening this to a
 * general "is it an Object" probe would need a discriminator this lane does not
 * yet have, and a wrong guess would turn working receivers into throws.
 */
function emitThisIsObjectCheck(ctx: CodegenContext, fctx: FunctionContext, what: string): void {
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const guard: Instr[] = [{ op: "local.get", index: 1 }, { op: "ref.is_null" }];
  if (isUndefinedIdx !== undefined) {
    guard.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
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
