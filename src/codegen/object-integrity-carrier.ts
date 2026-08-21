// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4032) `[[Extensible]]` / sealed / frozen for object carriers that are NOT
 * the open-object `$Object` representation.
 *
 * ## The gap
 *
 * The object-integrity predicates decided object-ness with a single
 * `ref.test $Object`, and answered the ES **non-object argument** rule
 * (`isFrozen(5) === true`, `isExtensible(5) === false`) whenever that test
 * failed. But `ref.test $Object` false does **not** mean "not an object" — in
 * `--target standalone` an Array is a `__vec_*` struct, a function is a closure
 * struct, and a built-in prototype is its own brand struct. All of those are
 * objects, and every one of them read back as never-extensible, always-sealed,
 * always-frozen.
 *
 * The matching mutators (`__object_preventExtensions` / `_seal` / `_freeze`)
 * carried the same gate and were **silent no-ops** for those carriers — there
 * was nowhere to record `[[Extensible]]`. That is *why* the predicates had to be
 * wrong in the pristine direction: it is the only way
 * `Object.freeze(arr); Object.isFrozen(arr)` came out `true`. Two wrongs
 * cancelling, and the cancellation was load-bearing for passing tests.
 *
 * `prependBuiltinFnObjectSemantics` (`object-runtime.ts`) already patches this
 * for exactly ONE subtype set — reified builtin function closures — by splicing
 * a `ref.test` chain in front of the three predicates. That is a symptom patch:
 * a growing list of type-index sets prepended to three functions, one family at
 * a time. This module replaces the mechanism instead.
 *
 * ## The fix — two independent halves, and deliberately NO new side table
 *
 * **(a) Storage: reuse the bags that already exist.** `__vec_bag_ensure`
 * (#3537, Array expando bag), `__closure_bag_ensure` (#3468, closure
 * own-property bag), and `__error_prop_bag_ensure` (#4098, native Error's
 * existing `$props` slot) map a carrier to a per-object `$Object`. A `$Object`
 * *has* a real flags slot, so the bag **is** the missing storage.
 * {@link registerIntegrityBagResolver} adds one native that resolves a receiver
 * to its bag, and both the predicates and the mutators route through it.
 *
 * `ensure` rather than `lookup` is deliberate: a freshly created bag has
 * `flags == 0`, which decodes to exactly the pristine-ordinary-object answer, so
 * ONE code path serves both "never mutated" and "mutated", with no extra state
 * to keep consistent. The allocation only happens on an integrity operation
 * against a non-`$Object` carrier, which is rare.
 *
 * Adding a THIRD receiver side-table is precisely what #4010 exists to undo, so
 * this composes with the two that already exist.
 *
 * **(b) Object-ness: ask the type system, not the carrier.** The `_obj`
 * predicate variants keep the same body but flip the terminal fallback to the
 * ordinary-object rule; {@link provenJsObject} decides at the call site whether
 * to select them. That covers built-in prototypes, for which no bag carrier
 * exists, and does not depend on which WasmGC carrier a value happens to use.
 *
 * ## Byte-neutrality
 *
 * Host mode is untouched. `__object_is*` are host imports there and the bag
 * substrates are standalone/wasi-only (`reserveVecPropHelpers` /
 * `reserveClosurePropHelpers` are gated on `ctx.standalone || ctx.wasi`), so
 * {@link registerIntegrityBagResolver} returns `undefined` and both emitters
 * reproduce their previous bodies byte-for-byte.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { noJsHost } from "./js-errors.js";
import { integrityVarKey } from "./widened-var-key.js";

/** Minter signature shared with `ensureObjectRuntime`'s `registerNative`. */
export type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/** The carrier-bag resolver. Called by funcIdx, so it is NOT late-import routed. */
export const INTEGRITY_BAG_HELPER = "__integrity_bag";

/**
 * The known-object predicate variants. They must be listed in
 * `OBJECT_RUNTIME_HELPER_NAMES` so `ensureLateImport` binds the DEFINED native
 * instead of emitting an `env::` host import — a standalone import leak is a
 * hard `compile_error` in the CI worker (#2961).
 */
export const OBJECT_INTEGRITY_OBJ_PREDICATES: readonly string[] = [
  "__object_isFrozen_obj",
  "__object_isSealed_obj",
  "__object_isExtensible_obj",
];

/**
 * Register `__integrity_bag(externref v) -> externref`:
 *   vec carrier     → `__vec_bag_ensure(v)`
 *   closure carrier → `__closure_bag_ensure(v)`
 *   Error carrier   → `__error_prop_bag_ensure(v)`
 *   otherwise       → `ref.null.extern`
 *
 * Returns `undefined` when the bag substrates are absent (host mode), which is
 * the signal for callers to emit their pre-#4032 bodies unchanged.
 */
export function registerIntegrityBagResolver(ctx: CodegenContext, registerNative: RegisterNative): number | undefined {
  const isVecCarrierIdx = ctx.funcMap.get("__is_vec_prop_carrier");
  const vecBagEnsureIdx = ctx.funcMap.get("__vec_bag_ensure");
  const isClosureCarrierIdx = ctx.funcMap.get("__is_closure_prop_carrier");
  const closureBagEnsureIdx = ctx.funcMap.get("__closure_bag_ensure");
  const isErrorCarrierIdx = ctx.funcMap.get("__is_error_prop_carrier");
  const errorBagEnsureIdx = ctx.funcMap.get("__error_prop_bag_ensure");
  if (
    isVecCarrierIdx === undefined ||
    vecBagEnsureIdx === undefined ||
    isClosureCarrierIdx === undefined ||
    closureBagEnsureIdx === undefined
  ) {
    return undefined;
  }
  return registerNative(
    INTEGRITY_BAG_HELPER,
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isVecCarrierIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: vecBagEnsureIdx }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosureCarrierIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: closureBagEnsureIdx }, { op: "return" }],
      },
      ...(isErrorCarrierIdx === undefined || errorBagEnsureIdx === undefined
        ? []
        : ([
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: isErrorCarrierIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: errorBagEnsureIdx }, { op: "return" }],
            },
          ] satisfies Instr[])),
      { op: "ref.null.extern" },
    ],
  );
}

/**
 * Decode one `$Object.flags` bit (field 4) from the object held in `localIdx`.
 * A FACTORY, never a shared array: the result is spliced into two arms of the
 * same body, and aliasing one `Instr[]` into both makes the finalize walks remap
 * it twice (see `reference_shared_instr_object_dce_double_remap`).
 */
export function decodeIntegrityFlag(
  objectTypeIdx: number,
  localIdx: number,
  flagBit: number,
  invert: boolean,
): Instr[] {
  const out: Instr[] = [
    { op: "local.get", index: localIdx },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: flagBit },
    { op: "i32.and" },
  ];
  if (invert) out.push({ op: "i32.eqz" });
  else out.push({ op: "i32.const", value: 0 }, { op: "i32.ne" });
  return out;
}

/**
 * Body + locals for one integrity predicate.
 *
 * `$Object` receiver → its own flags. Otherwise consult the carrier bag (local
 * 2), and fall back to `terminalResult` when the value carries no bag —
 * the ES non-object rule for the base helpers, the ordinary-object rule for the
 * `_obj` variants.
 */
export function buildIntegrityPredicate(args: {
  objectTypeIdx: number;
  flagBit: number;
  invert: boolean;
  terminalResult: number;
  integrityBagIdx: number | undefined;
  /**
   * (#4491 wave-5 T2) §7.3.15 `TestIntegrityLevel` fallback for the DIRECT
   * `$Object` arm, consulted only where the level's flag bit is clear. Absent
   * (`isExtensible`, host mode) ⇒ the body is byte-identical to before.
   * See object-integrity-test-level.ts for why the bag arm never gets it.
   */
  derive?: { locals: { name: string; type: ValType }[]; instrs: (objLocal: number) => Instr[] };
}): { locals: { name: string; type: ValType }[]; body: Instr[] } {
  const { objectTypeIdx, flagBit, invert, terminalResult, integrityBagIdx, derive } = args;
  const decode = (localIdx: number): Instr[] => decodeIntegrityFlag(objectTypeIdx, localIdx, flagBit, invert);
  /** The DIRECT `$Object` arm — the only one the §7.3.15 fallback is sound on. */
  const decodeDirect = (localIdx: number): Instr[] =>
    derive === undefined
      ? decode(localIdx)
      : [
          ...decode(localIdx),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 1 }],
            else: derive.instrs(localIdx),
          },
        ];
  const elseArm: Instr[] =
    integrityBagIdx === undefined
      ? [{ op: "i32.const", value: terminalResult }]
      : [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: integrityBagIdx },
          { op: "any.convert_extern" },
          { op: "local.tee", index: 2 },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: decode(2),
            else: [{ op: "i32.const", value: terminalResult }],
          },
        ];
  const locals: { name: string; type: ValType }[] = [{ name: "any", type: { kind: "anyref" } }];
  if (integrityBagIdx !== undefined) locals.push({ name: "bag", type: { kind: "anyref" } });
  if (derive !== undefined) locals.push(...derive.locals);
  return {
    locals,
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: decodeDirect(1), else: elseArm },
    ],
  };
}

/**
 * Does the TYPE SYSTEM prove this receiver is a JS object, so the ordinary-object
 * fallback (the `_obj` predicate variants) is the correct one?
 *
 * Deciding object-ness from the checked type — rather than from which WasmGC
 * carrier the value happens to use — is what makes built-in prototypes
 * (`Array.prototype`, `Error.prototype`), plain functions and Arrays all answer
 * correctly without enumerating their struct types.
 *
 * Three deliberate exclusions:
 *
 * - **Host mode.** The `_obj` natives only exist where the bag substrate does.
 * - **`null`.** The oracle folds it into the `"object"` tag for `typeof`
 *   fidelity, but `Object.isExtensible(null)` is `false` and
 *   `Object.isFrozen(null)` is `true` — the NON-object rule. Nullable or
 *   possibly-undefined receivers keep the conservative helper.
 * - **A receiver already seen by a mutator.** RESIDUAL, documented in #4032: a
 *   receiver lowered to a plain typed struct (`const o = { a: 1 }` → an
 *   `__anon_*` shape) has NO bag carrier, so `Object.preventExtensions(o)` there
 *   is still a no-op — and the old non-object answer is accidentally RIGHT for
 *   the mutate-then-query shape. Switching such a receiver to the
 *   ordinary-object rule would trade a pristine-query gain for a
 *   mutate-then-query loss. `nonExtensibleVars` is populated in CODEGEN ORDER,
 *   which lines up with the family this unlocks:
 *
 *   ```js
 *   assert(Object.isExtensible(o));   // compiled first → ordinary rule  → true  ✓
 *   Object.preventExtensions(o);      // records the declaration
 *   assert(!Object.isExtensible(o));  // now restricted → false ✓
 *   ```
 *
 *   Not tracked (unchanged from the pre-existing `frozenVars` tracking):
 *   mutation through an alias, or inside a callee.
 */
/**
 * Resolve the integrity predicate for `arg` and bind it, appending the `_obj`
 * suffix when {@link provenJsObject} holds. The `_obj` variants are listed in
 * `OBJECT_RUNTIME_HELPER_NAMES`, so `ensureLateImport` binds the defined native
 * rather than emitting a host import.
 */
export function ensureIntegrityPredicate(
  ctx: CodegenContext,
  arg: ts.Expression,
  method: "isFrozen" | "isSealed" | "isExtensible",
): number | undefined {
  const name = `__object_${method}${provenJsObject(ctx, arg) ? "_obj" : ""}`;
  return ensureLateImport(ctx, name, [{ kind: "externref" }], [{ kind: "i32" }]);
}

export function provenJsObject(ctx: CodegenContext, arg: ts.Expression): boolean {
  if (!noJsHost(ctx)) return false;
  const tag = ctx.oracle.staticJsTypeOf(arg);
  if (tag !== "object" && tag !== "function") return false;
  const nullability = ctx.oracle.nullabilityOf(arg);
  if (nullability.nullable || nullability.undefinable) return false;
  if (ts.isIdentifier(arg) && ctx.nonExtensibleVars.has(integrityVarKey(ctx, arg))) return false;
  return true;
}
