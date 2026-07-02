/**
 * #2638 — standalone CLASS-instance → primitive (§7.1.1.1 OrdinaryToPrimitive)
 * for the runtime `__to_primitive` engine.
 *
 * ## Why a reserve/fill driver
 *
 * `__to_primitive` (object-runtime.ts) reduces a dynamic `$Object`
 * (`ref.test objectTypeIdx`) and, via #2358, a `$Vec` array. A **class
 * instance** is a distinct *nominal* WasmGC struct — neither `$Object` nor
 * `$Vec` — so both `ref.test`s miss and `__to_primitive` returns the struct
 * unchanged; the caller's `__unbox_number(struct)` → NaN (or a null string for
 * the string hint). That breaks `Number(new C() as any)`, `(new C() as any) - 8`,
 * etc. standalone, when the static class type has been erased to externref.
 *
 * The fix routes a class-instance struct through the EXISTING per-struct
 * `__call_valueOf` / `__call_toString` dispatchers (emitted by
 * `emitToPrimitiveMethodExports`, index.ts), honouring the §7.1.1.1 method
 * ordering by hint:
 *   - string hint:          toString → valueOf
 *   - number / default hint: valueOf → toString
 * Each dispatcher returns a boxed primitive externref on a struct match, or
 * `ref.null.extern` on no match; a non-null result is the primitive to return.
 * If both miss (a class with neither valueOf nor toString), the driver returns
 * the input unchanged — identical to today's "return unchanged" fall-through,
 * so no regression.
 *
 * ## Late-funcidx discipline (#2191 / #2043 hazard)
 *
 * `emitToPrimitiveMethodExports` runs at FINALIZE, AFTER `__to_primitive` is
 * built in `ensureObjectRuntime`. So `__to_primitive` cannot bake a `call` to
 * `__call_valueOf`/`__call_toString` directly (their funcIdxs don't exist yet
 * and any captured pre-shift idx would be wrong after the late import/type
 * shifts — the exact bug class root-caused in #2191 `7ae5c5df4`). Instead we
 * reserve a `__class_to_primitive` placeholder at `__to_primitive`-emit time
 * (so the `call` target is stable under the funcIdx-shift machinery), and fill
 * its body in post-processing (`fillClassToPrimitive`, AFTER
 * `emitToPrimitiveMethodExports`) once `__call_valueOf`/`__call_toString` are
 * registered. Same reserve/fill funcIdx-authority discipline as
 * `reserveArrayToPrimitiveString` / `reserveAccessorGetDriver`.
 */

import type { CodegenContext } from "./context/types.js";
import type { Instr, WasmFunction } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { definedFuncAt } from "./func-space.js"; // (#1916 S2) positional-read chokepoint

export const CLASS_TO_PRIMITIVE = "__class_to_primitive";

/**
 * Reserve the `__class_to_primitive(externref obj, i32 stringHint) -> externref`
 * placeholder and return its funcIdx. Body is a bare `unreachable` until
 * `fillClassToPrimitive` patches it (after `__call_valueOf`/`__call_toString`
 * are registered). Idempotent. Standalone only — the JS-host lane reduces class
 * instances via the host `_hostToPrimitive` OrdinaryToPrimitive loop, so this
 * driver is never reached there.
 */
export function reserveClassToPrimitive(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(CLASS_TO_PRIMITIVE);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
    "$class_to_primitive_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: CLASS_TO_PRIMITIVE,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillClassToPrimitive in post-processing. The bare
    // `unreachable` keeps the stub valid (externref result) if the fill is ever
    // skipped (e.g. no nominal-struct dispatchers were emitted).
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(CLASS_TO_PRIMITIVE, funcIdx);
  ctx.classToPrimitiveReserved = true;
  return funcIdx;
}

/**
 * Fill the reserved `__class_to_primitive` body now that the per-struct
 * `__call_valueOf` / `__call_toString` dispatchers are registered (after
 * `emitToPrimitiveMethodExports`). Implements §7.1.1.1 OrdinaryToPrimitive over
 * the nominal-struct dispatchers:
 *
 *   // hint==string → try toString first, else valueOf; otherwise valueOf first.
 *   first  = stringHint ? __call_toString : __call_valueOf
 *   second = stringHint ? __call_valueOf  : __call_toString
 *   r = first(obj);   if (r != null) return r       // a method matched → primitive
 *   r = second(obj);  if (r != null) return r
 *   return obj                                       // neither matched — unchanged
 *
 * `__call_*` return a boxed primitive externref on a struct match, or
 * `ref.null.extern` on no match — so a non-null result is exactly "this class
 * had this method, here is its (already-boxed-primitive) result". A class with
 * neither method falls through to `return obj` (today's behaviour, no
 * regression). The §7.1.1.1 step-6 "must return a primitive" TypeError walk for
 * a method that returns an object is intentionally NOT replicated here: the
 * standalone class dispatchers box only primitive method results, and the
 * dynamic-`$Object` path (which DOES do the full walk) is unaffected.
 *
 * No-op when the driver was not reserved or the dispatchers are missing — the
 * placeholder `unreachable` stays (it is unreachable from any live arm, because
 * `__to_primitive` only `call`s the driver when it itself was emitted in the
 * standalone class-capable path).
 */
export function fillClassToPrimitive(ctx: CodegenContext): void {
  if (!ctx.classToPrimitiveReserved) return;
  const driverIdx = ctx.funcMap.get(CLASS_TO_PRIMITIVE);
  if (driverIdx === undefined) return;
  const fn = definedFuncAt(ctx, driverIdx);
  if (!fn) return;

  const callValueOfIdx = ctx.funcMap.get("__call_valueOf");
  const callToStringIdx = ctx.funcMap.get("__call_toString");
  if (callValueOfIdx === undefined && callToStringIdx === undefined) {
    // No nominal-struct dispatchers were emitted (no class with valueOf/
    // toString in this module). Leave the unreachable stub: `__to_primitive`'s
    // class arm still routes here, but only after the $Object/$Vec misses, and
    // for a class with no such method the correct result is "unchanged" — so
    // make the stub return the input unchanged rather than trap.
    fn.locals = [];
    fn.body = [{ op: "local.get", index: 0 }];
    return;
  }

  const L_OBJ = 0; // externref param: the candidate class instance
  const L_HINT = 1; // i32 param: 1 = string hint, 0 = number/default
  const L_RV = 2; // externref: valueOf dispatcher result
  const L_RS = 3; // externref: toString dispatcher result

  // (#2891) §7.1.1.1 OrdinaryToPrimitive requires "if the method result is not
  // a primitive, try the next method", and a §7.1.1.1 step-6 TypeError when none
  // yields a primitive. The per-struct `__call_valueOf`/`__call_toString`
  // dispatchers return `ref.null.extern` when the object has no such OWN method,
  // but for a method that RETURNS an object they `boxResult` it via
  // `extern.convert_any` — a NON-null externref that is still an object. The old
  // "first non-null wins" tail therefore accepted an object-returning `valueOf`
  // and skipped the fall-through to `toString` (wrong relational/additive value)
  // and never threw the both-objects TypeError. We now classify each dispatcher
  // result as primitive (number/boolean/string) vs object, falling through and
  // modelling the (un-materialized in standalone) inherited Object.prototype
  // methods: inherited `valueOf` returns the object (non-primitive); inherited
  // `toString` returns "[object Object]" (a primitive string). Standalone-only —
  // the driver is reserved only under `ctx.standalone`, so GC/host is untouched.
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  const typeofBooleanIdx = ctx.funcMap.get("__typeof_boolean");
  const typeofStringIdx = ctx.funcMap.get("__typeof_string");
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");

  // If the primitive-classification or TypeError machinery is unavailable for
  // some reason, fall back to the pre-#2891 "first non-null wins" behaviour so
  // we never emit invalid code (these are always present in the standalone
  // `__to_primitive` build that reserves this driver).
  if (typeofNumberIdx === undefined || typeofStringIdx === undefined || typeErrorCtorIdx === undefined) {
    const tryDispatcher = (idx: number | undefined): Instr[] => {
      if (idx === undefined) return [];
      return [
        { op: "local.get", index: L_OBJ },
        { op: "call", funcIdx: idx },
        { op: "local.tee", index: L_RV },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: L_RV }, { op: "return" }],
        } as Instr,
      ];
    };
    fn.locals = [{ name: "rv", type: { kind: "externref" } }];
    fn.body = [
      { op: "local.get", index: L_HINT },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...tryDispatcher(callToStringIdx), ...tryDispatcher(callValueOfIdx)],
        else: [...tryDispatcher(callValueOfIdx), ...tryDispatcher(callToStringIdx)],
      } as Instr,
      { op: "local.get", index: L_OBJ },
    ];
    return;
  }

  const exnTagIdx = ensureExnTag(ctx);
  const OBJECT_TAG = "[object Object]";
  const TYPE_ERR_MSG = "Cannot convert object to primitive value";
  addStringConstantGlobal(ctx, OBJECT_TAG);
  addStringConstantGlobal(ctx, TYPE_ERR_MSG);

  // i32: 1 when the externref in `localIdx` is a primitive (number/boolean/
  // string), 0 otherwise (an object). `null` is handled by the caller via a
  // separate `ref.is_null` presence test, so it never reaches here.
  const isPrimitive = (localIdx: number): Instr[] => {
    const parts: Instr[] = [
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: typeofNumberIdx },
    ];
    if (typeofBooleanIdx !== undefined) {
      parts.push({ op: "local.get", index: localIdx }, { op: "call", funcIdx: typeofBooleanIdx }, { op: "i32.or" });
    }
    parts.push({ op: "local.get", index: localIdx }, { op: "call", funcIdx: typeofStringIdx }, { op: "i32.or" });
    return parts;
  };

  const returnObjectTag: Instr[] = [...stringConstantExternrefInstrs(ctx, OBJECT_TAG), { op: "return" } as Instr];
  const throwTypeError: Instr[] = [
    ...stringConstantExternrefInstrs(ctx, TYPE_ERR_MSG),
    { op: "call", funcIdx: typeErrorCtorIdx } as Instr,
    { op: "throw", tagIdx: exnTagIdx } as Instr,
  ];

  // Call a dispatcher, store into `dst`; if the result is a non-null PRIMITIVE,
  // return it. Leaves the (possibly null/object) result in `dst` for the caller
  // to classify by presence afterwards. Absent dispatcher → store null.
  const callAndReturnIfPrimitive = (idx: number | undefined, dst: number): Instr[] => {
    if (idx === undefined) {
      return [{ op: "ref.null.extern" } as Instr, { op: "local.set", index: dst }];
    }
    return [
      { op: "local.get", index: L_OBJ },
      { op: "call", funcIdx: idx },
      { op: "local.set", index: dst },
      // present (non-null) ?
      { op: "local.get", index: dst },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...isPrimitive(dst),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: dst }, { op: "return" }],
          } as Instr,
        ],
      } as Instr,
    ];
  };

  const presentNonNull = (localIdx: number): Instr[] => [
    { op: "local.get", index: localIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
  ];

  // number / default hint: valueOf → toString.
  const numberHint: Instr[] = [
    ...callAndReturnIfPrimitive(callValueOfIdx, L_RV),
    ...callAndReturnIfPrimitive(callToStringIdx, L_RS),
    // Neither own method produced a primitive. Classify by presence.
    ...presentNonNull(L_RV), // valueOf present & object?
    {
      op: "if",
      blockType: { kind: "empty" },
      // valueOf present & object
      then: [
        ...presentNonNull(L_RS), // toString present & object?
        {
          op: "if",
          blockType: { kind: "empty" },
          // both present-object → §7.1.1.1 TypeError
          then: throwTypeError,
          // toString absent → inherited Object.prototype.toString → "[object Object]"
          else: returnObjectTag,
        } as Instr,
      ],
      // valueOf absent → inherited valueOf returns the object (non-primitive)
      else: [
        ...presentNonNull(L_RS), // toString present & object?
        {
          op: "if",
          blockType: { kind: "empty" },
          // valueOf inherited-object + toString present-object → TypeError
          then: throwTypeError,
          // both absent → fall through to the shared "return input unchanged" tail
          else: [],
        } as Instr,
      ],
    } as Instr,
  ];

  // string hint: toString → valueOf. Inherited toString yields the primitive
  // "[object Object]", so an ABSENT toString resolves to it as the FIRST method.
  const stringHint: Instr[] = [
    ...callAndReturnIfPrimitive(callToStringIdx, L_RS),
    // toString absent → inherited toString → "[object Object]" (primitive, first)
    ...presentNonNull(L_RS),
    {
      op: "if",
      blockType: { kind: "empty" },
      // toString present & object → try valueOf next
      then: [
        ...callAndReturnIfPrimitive(callValueOfIdx, L_RV),
        // valueOf absent (inherited → object) or present-object → both object → TypeError
        ...throwTypeError,
      ],
      // toString absent → default Object.prototype.toString
      else: returnObjectTag,
    } as Instr,
  ];

  fn.locals = [
    { name: "rv", type: { kind: "externref" } },
    { name: "rs", type: { kind: "externref" } },
  ];
  fn.body = [
    { op: "local.get", index: L_HINT },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: stringHint,
      else: numberHint,
    } as Instr,
    // Shared tail: reached only when BOTH methods are absent (number hint) —
    // a nominal struct with no valueOf/toString → return the input unchanged,
    // exactly as the pre-#2638 fall-through did (no regression).
    { op: "local.get", index: L_OBJ },
  ];
}
