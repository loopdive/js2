// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4210) Own-property WRITES and reflection for `$Error_struct` receivers
 * (`--target standalone` / `--target wasi` only).
 *
 * ## The gap
 *
 * In standalone, `err.p = 7` on an Error instance was **silently discarded** —
 * no throw, no refusal, no diagnostic. `err.p` read back `undefined` and
 * `err.hasOwnProperty("p")` answered `false`. Measured 2026-08-07 on
 * `origin/main@5534c3e8e8`, with the RHDEIKX channel probe (uppercase =
 * correct):
 *
 * ```
 * plainObj=RHDEIKX  fnObj=RHDEIKX  arrObj=RHDEIKX  dateObj=RHDEIKX  regexpObj=RHDEIKX
 * errObj=rhdeikX  ← every channel wrong (the X is vacuous: nothing to delete)
 * ```
 *
 * Error was the last receiver kind still losing writes; functions and arrays
 * were closed by #3468/#3537 + #4010/#4055/#4161, Date and RegExp by #4017.
 *
 * ## Why this is NOT a third carrier side-table
 *
 * #4210's filed text proposes "an identity-keyed side-table plus an
 * `IS_ERROR_PROP_CARRIER` predicate", by analogy with #3468 (closures) and
 * #3537 (`$Vec`). **That analogy is wrong in the one way that matters: an
 * `$Error_struct` ALREADY HAS a bag.** `$props` (fieldIdx 5, #2101a R5,
 * `registry/types.ts`) is a mutable externref holding a plain `$Object`,
 * lazily allocated by `__new_plain_object`. The READ side has consulted it
 * since #3130 — `fillExternGetErrorProps` splices a `$props`-first arm into
 * `__extern_get` ahead of message/name/stack/constructor. What was missing is
 * the **write** side and the **reflective** side, not storage.
 *
 * So this module adds no state. It exposes the field that already exists,
 * under the three names the surrounding machinery already knows how to
 * consume, and every consumer is a one-arm composition:
 *
 * | consumer                                  | gets                                    |
 * | ----------------------------------------- | --------------------------------------- |
 * | `__extern_set` (via {@link buildErrorPropSetMissArm}) | `err.p = 7` lands       |
 * | `__carrier_bag_of` (carrier-bag-visibility)| hasOwnProperty / gOPD / delete / keys  |
 * | `__integrity_bag` (object-integrity-carrier)| isExtensible / preventExtensions / seal / freeze |
 * | the define appliers (object-runtime-descriptors) | `Object.defineProperty(err, …)`  |
 *
 * ## ⚠ The obvious approach is a KNOWN-REJECTED variant — do not re-attempt it
 *
 * Date and RegExp were **not** fixed with a new arm. They were added to the
 * named list in `builtinInstanceCarrierTypeIdxs()` (`closure-props.ts`), which
 * folds them into `__is_closure_prop_carrier`'s `ref.test` chain so they ride
 * the #3468 closure bag. Reaching for "just add `$Error_struct` to that list"
 * is the first thing anyone tries, and it is wrong for a documented reason —
 * see the exclusion note at `closure-props.ts` ~L305:
 *
 * > `$Error_struct` has its own `$props` side-slot (fieldIdx 5, #2101a R5)
 * > that the externref-backed-subclass own-field path writes directly, so
 * > bagging it would give one receiver two disagreeing stores.
 *
 * That objection is real and it is why this module points at field 5 instead:
 * the compile-time own-field writer (`assignment.ts`, `class A extends Error {
 * code = 0 }`) and the runtime write arm here target the **same** `$Object`,
 * so there is exactly one store and reflection cannot disagree with a read.
 * `tests/issue-4210-error-carrier-bag.test.ts` asserts that agreement through
 * both paths rather than leaving it as prose.
 *
 * ## Byte-neutrality
 *
 * The three helpers are reserved alongside the #3468/#3537 substrates (so the
 * `__extern_set` arm can bake a `call <idx>` before finalize) and filled with
 * constant-false / null bodies when the module registered no `$Error_struct`.
 * Host/gc mode reserves nothing — `env::__extern_*` owns the dynamic-property
 * path there — so non-standalone output is unchanged.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** Reserved helper names. Exported so the composition sites resolve BY NAME. */
export const IS_ERROR_PROP_CARRIER = "__is_error_prop_carrier";
export const ERROR_BAG_LOOKUP = "__error_bag_lookup";
export const ERROR_BAG_ENSURE = "__error_bag_ensure";

/** `$Error_struct.$props` — the own-property bag. See `registry/types.ts`. */
const F_PROPS = 5;

/**
 * Reserve the three helper placeholders. Called from `ensureObjectRuntime`
 * right after `reserveVecPropHelpers`, BEFORE the `__extern_*` arms bake their
 * `call <idx>` — the same reserve-before-arms-bake discipline #3468/#3537 use.
 *
 * Reserving is UNCONDITIONAL under standalone/wasi even though
 * `ctx.errorStructTypeIdx` may still be `-1` here: the error struct is
 * registered lazily by whichever site first constructs a native error, which
 * can happen after the object runtime is built. Deciding at reserve time would
 * silently omit the arm for a module that acquires errors later. The fill
 * resolves the real answer once, at finalize.
 */
export function reserveErrorPropHelpers(ctx: CodegenContext): void {
  if (ctx.errorPropHelpersReserved) return;

  const reserve = (name: string, params: ValType[], results: ValType[]): void => {
    if (ctx.funcMap.get(name) !== undefined) return;
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = {
      name,
      typeIdx,
      locals: [],
      // Filled at FINALIZE. `unreachable` is valid for any result type if the
      // fill is ever skipped.
      body: [{ op: "unreachable" }],
      exported: false,
    };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
  };

  const externref: ValType = { kind: "externref" };
  reserve(IS_ERROR_PROP_CARRIER, [externref], [{ kind: "i32" }]);
  reserve(ERROR_BAG_LOOKUP, [externref], [externref]);
  reserve(ERROR_BAG_ENSURE, [externref], [externref]);

  ctx.errorPropHelpersReserved = true;
}

/**
 * `__extern_set`'s arm for an `$Error_struct` receiver: ENSURE the `$props`
 * bag and **substitute it for the receiver**, so the helper's own unchanged
 * `$Object` path performs the store — the SUBSTITUTION mechanism #4161
 * established for the define appliers (`carrier-bag-define.ts`), not a second
 * implementation of OrdinarySet.
 *
 * Substituting rather than recursing is what buys correctness for free: the
 * bag is a real `$Object`, so the accessor gate, the non-writable gate, the
 * FROZEN gate and `__obj_insert`'s NON_EXTENSIBLE new-key refusal all apply to
 * an Error exactly as they do to a plain object, and an own accessor is still
 * invoked with the ORIGINAL Error (param 0) as `this`. That matters:
 * `Object.preventExtensions(err); err.p = 1` must NOT stick, and
 * `built-ins/Object/preventExtensions/15.2.3.10-3-20.js` passes today only
 * because the write was dropped outright — a vacuous pass this change would
 * otherwise convert into a failure. `registerIntegrityBagResolver` puts the
 * `[[Extensible]]` bit on the SAME bag, so the two agree by construction
 * rather than by coincidence.
 *
 * It also sidesteps a bake-order problem: `__extern_set`'s own funcIdx is not
 * in `funcMap` while its body is being built, so a recursive call could not be
 * emitted here at all.
 *
 * `fallback` is the arm that must run for a NON-Error receiver — it is
 * terminal (the #3468 closure arm always `return`s), which is why it has to be
 * nested here rather than merely sequenced after.
 *
 * Returns `fallback` unchanged when the substrate is absent, so a module
 * without the Error helpers emits byte-identical output.
 *
 * `bagLocalIdx` must be a fresh externref local APPENDED to `__extern_set`'s
 * local vector — never a renumber of an existing one. `anyLocalIdx` is the
 * helper's cached `any.convert_extern(obj)` local, the one its `$Object` path
 * casts.
 */
export function buildErrorPropSetMissArm(
  ctx: CodegenContext,
  opts: { bagLocalIdx: number; anyLocalIdx: number; fallback: Instr[] },
): Instr[] {
  const ensureIdx = ctx.funcMap.get(ERROR_BAG_ENSURE);
  if (ensureIdx === undefined) return opts.fallback;
  return [
    { op: "local.get", index: 0 }, // obj
    { op: "call", funcIdx: ensureIdx }, // null for every non-Error, without allocating
    { op: "local.tee", index: opts.bagLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: opts.fallback },
    // Error receiver — re-point the `$Object` path at the bag and fall out of
    // the enclosing non-`$Object` guard into it.
    { op: "local.get", index: opts.bagLocalIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: opts.anyLocalIdx },
  ];
}

/**
 * Fill the three reserved bodies at FINALIZE, once `ctx.errorStructTypeIdx`
 * and `__new_plain_object` are settled. A module that registered no
 * `$Error_struct` gets the constant answers, which makes every composition
 * site above a runtime no-op.
 */
export function fillErrorPropHelpers(ctx: CodegenContext): void {
  if (!ctx.errorPropHelpersReserved) return;

  const setBody = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };

  const errTypeIdx = ctx.errorStructTypeIdx;
  const newObjIdx = ctx.funcMap.get("__new_plain_object");
  if (errTypeIdx < 0 || newObjIdx === undefined) {
    // No native errors in this module (or no object runtime): the constant
    // answers. Every consumer's arm then tests false / sees a null bag.
    setBody(IS_ERROR_PROP_CARRIER, [], [{ op: "i32.const", value: 0 }]);
    setBody(ERROR_BAG_LOOKUP, [], [{ op: "ref.null.extern" }]);
    setBody(ERROR_BAG_ENSURE, [], [{ op: "ref.null.extern" }]);
    return;
  }

  // ── __is_error_prop_carrier(externref v) -> i32 ──
  // `any.convert_extern` of a null externref is a null anyref and `ref.test`
  // answers 0 for it, so a null receiver is false without a trap.
  setBody(
    IS_ERROR_PROP_CARRIER,
    [],
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: errTypeIdx }],
  );

  // ── __error_bag_lookup(externref v) -> externref ──
  // LOOKUP, never ENSURE: the carrier-bag READ surfaces (#4010) must not
  // allocate, so a query on an Error that has never been written answers null
  // and every consumer reports "absent" — which is the correct answer.
  // Locals: 1 = any (anyref).
  setBody(
    ERROR_BAG_LOOKUP,
    [{ name: "__any", type: { kind: "anyref" } }],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: errTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: errTypeIdx },
          { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: F_PROPS },
          { op: "return" },
        ],
      },
      { op: "ref.null.extern" },
    ],
  );

  // ── __error_bag_ensure(externref v) -> externref ──
  // The WRITE-side resolver: allocate `$props` on demand, exactly as the
  // compile-time own-field writer in `expressions/assignment.ts` does, so both
  // paths converge on one `$Object` per Error instance.
  // Locals: 1 = any (anyref), 2 = bag (externref).
  setBody(
    ERROR_BAG_ENSURE,
    [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__bag", type: { kind: "externref" } },
    ],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: errTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: errTypeIdx },
      { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: F_PROPS },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "call", funcIdx: newObjIdx },
          { op: "local.set", index: 2 },
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: errTypeIdx },
          { op: "local.get", index: 2 },
          { op: "struct.set", typeIdx: errTypeIdx, fieldIdx: F_PROPS },
        ],
      },
      { op: "local.get", index: 2 },
    ],
  );
}
