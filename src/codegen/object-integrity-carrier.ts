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
// FLAG_TOMBSTONE is read only INSIDE functions, so the object-runtime <-> this
// module import cycle never touches an uninitialised binding.
import { FLAG_TOMBSTONE } from "./object-runtime.js";
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
 * (#4491) The own-property half of ES §7.3.15 TestIntegrityLevel, for a receiver
 * that is a genuine `$Object` (all of whose own properties live in its prop map).
 *
 * The sealed/frozen bits alone answer only the `Object.seal`/`Object.freeze`
 * path. An object can also *become* sealed or frozen without either call ever
 * running — `Object.preventExtensions(o)` on an object whose every own property
 * is already non-configurable (and, for frozen, non-writable) is sealed/frozen
 * by definition, and the extreme case is an object with NO own properties, which
 * `preventExtensions` alone freezes. That is not an edge case: it is how
 * `isFrozen`/`isSealed` are specified — a computed predicate, not a stored bit.
 *
 * Scope is deliberately the DIRECT `$Object` arm only, never the carrier-bag
 * arm. A bag holds a non-`$Object` carrier's *expandos*, not the carrier's own
 * elements/fields, so walking a bag would answer "frozen" for an Array whose
 * elements are still writable. The bag arm keeps the stored-bit answer.
 *
 * No early exit: the loop ANDs into `res` and always runs to completion. Prop
 * maps are small, and a straight-line accumulate avoids multi-level `br` depth
 * arithmetic through the `if`/`loop`/`block` nest.
 */
function integrityLevelWalkInstrs(args: {
  objectTypeIdx: number;
  propMapTypeIdx: number;
  propEntryTypeIdx: number;
  objLocalIdx: number;
  /** Frozen also requires every DATA property to be non-writable. */
  requireNonWritable: boolean;
  OBJ_FLAG_NONEXTENSIBLE: number;
  FLAG_WRITABLE: number;
  FLAG_CONFIGURABLE: number;
  FLAG_ACCESSOR: number;
  FLAG_TOMBSTONE: number;
  /** First of the six scratch locals (res, props, cap, i, e, ef). */
  base: number;
}): Instr[] {
  const {
    objectTypeIdx,
    propMapTypeIdx,
    propEntryTypeIdx,
    objLocalIdx,
    requireNonWritable,
    OBJ_FLAG_NONEXTENSIBLE,
    FLAG_WRITABLE,
    FLAG_CONFIGURABLE,
    FLAG_ACCESSOR,
    FLAG_TOMBSTONE,
    base,
  } = args;
  const res = base;
  const props = base + 1;
  const cap = base + 2;
  const idx = base + 3;
  const entry = base + 4;
  const eflags = base + 5;
  const clearRes: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: res },
  ];
  return [
    { op: "i32.const", value: 1 },
    { op: "local.set", index: res },
    // An extensible object is neither sealed nor frozen.
    { op: "local.get", index: objLocalIdx },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [...clearRes] },
    { op: "local.get", index: objLocalIdx },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "local.tee", index: props },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      // A null prop map means no own properties — vacuously sealed and frozen.
      then: [],
      else: [
        { op: "local.get", index: props },
        { op: "array.len" },
        { op: "local.set", index: cap },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: idx },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: idx },
                { op: "local.get", index: cap },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: props },
                { op: "local.get", index: idx },
                { op: "array.get", typeIdx: propMapTypeIdx },
                { op: "local.tee", index: entry },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [],
                  else: [
                    { op: "local.get", index: entry },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                    { op: "local.tee", index: eflags },
                    { op: "i32.const", value: FLAG_TOMBSTONE },
                    { op: "i32.and" },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        // A configurable own property defeats both levels.
                        { op: "local.get", index: eflags },
                        { op: "i32.const", value: FLAG_CONFIGURABLE },
                        { op: "i32.and" },
                        { op: "if", blockType: { kind: "empty" }, then: [...clearRes] },
                        // Frozen additionally requires no writable DATA property.
                        // An accessor has no [[Writable]] (§6.2.6.1), so mask it out
                        // rather than reading the bit that slot does not carry.
                        ...(requireNonWritable
                          ? ([
                              { op: "local.get", index: eflags },
                              { op: "i32.const", value: FLAG_WRITABLE | FLAG_ACCESSOR },
                              { op: "i32.and" },
                              { op: "i32.const", value: FLAG_WRITABLE },
                              { op: "i32.eq" },
                              { op: "if", blockType: { kind: "empty" }, then: [...clearRes] },
                            ] satisfies Instr[])
                          : []),
                      ],
                    },
                  ],
                },
                { op: "local.get", index: idx },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: idx },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: res },
  ];
}

/**
 * Body + locals for one integrity predicate.
 *
 * `$Object` receiver → its own flags. Otherwise consult the carrier bag (local
 * 2), and fall back to `terminalResult` when the value carries no bag —
 * the ES non-object rule for the base helpers, the ordinary-object rule for the
 * `_obj` variants.
 *
 * (#4491) `levelWalk`, when supplied, adds the computed §7.3.15 half on the
 * DIRECT `$Object` arm: the stored bit stays a fast path, and only when it is
 * clear does the own-property walk decide. `isExtensible` never passes it —
 * `[[Extensible]]` genuinely IS a stored slot.
 */
export function buildIntegrityPredicate(args: {
  objectTypeIdx: number;
  flagBit: number;
  invert: boolean;
  terminalResult: number;
  integrityBagIdx: number | undefined;
  levelWalk?: {
    propMapTypeIdx: number;
    propEntryTypeIdx: number;
    propMapRef: ValType;
    entryRefNull: ValType;
    requireNonWritable: boolean;
    OBJ_FLAG_NONEXTENSIBLE: number;
    FLAG_WRITABLE: number;
    FLAG_CONFIGURABLE: number;
    FLAG_ACCESSOR: number;
    FLAG_TOMBSTONE: number;
  };
}): { locals: { name: string; type: ValType }[]; body: Instr[] } {
  const { objectTypeIdx, flagBit, invert, terminalResult, integrityBagIdx, levelWalk } = args;
  const decodeBit = (localIdx: number): Instr[] => decodeIntegrityFlag(objectTypeIdx, localIdx, flagBit, invert);
  // Scratch locals for the walk are APPENDED after `any`/`bag`, so no already
  // baked local index moves.
  const walkBase = integrityBagIdx === undefined ? 2 : 3;
  const decode = (localIdx: number): Instr[] =>
    levelWalk === undefined || localIdx !== 1
      ? decodeBit(localIdx)
      : [
          ...decodeBit(localIdx),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 1 }],
            else: integrityLevelWalkInstrs({
              objectTypeIdx,
              propMapTypeIdx: levelWalk.propMapTypeIdx,
              propEntryTypeIdx: levelWalk.propEntryTypeIdx,
              objLocalIdx: localIdx,
              requireNonWritable: levelWalk.requireNonWritable,
              OBJ_FLAG_NONEXTENSIBLE: levelWalk.OBJ_FLAG_NONEXTENSIBLE,
              FLAG_WRITABLE: levelWalk.FLAG_WRITABLE,
              FLAG_CONFIGURABLE: levelWalk.FLAG_CONFIGURABLE,
              FLAG_ACCESSOR: levelWalk.FLAG_ACCESSOR,
              FLAG_TOMBSTONE: levelWalk.FLAG_TOMBSTONE,
              base: walkBase,
            }),
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
  if (levelWalk !== undefined) {
    locals.push(
      { name: "res", type: { kind: "i32" } },
      { name: "props", type: levelWalk.propMapRef },
      { name: "cap", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "e", type: levelWalk.entryRefNull },
      { name: "ef", type: { kind: "i32" } },
    );
  }
  return {
    locals,
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: decode(1), else: elseArm },
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

/**
 * Emit the six object-integrity predicates and return the carrier-bag resolver
 * funcIdx (the mutators need it too).
 *
 * Owned here rather than in the descriptor registry because everything the
 * predicates depend on lives in this module: the non-`$Object` carrier bag
 * (#4032) and the computed §7.3.15 own-property walk (#4491). The registration
 * ORDER is load-bearing — every native minted after these keeps its funcIdx
 * only if the sequence is unchanged.
 */
export function buildObjectIntegrityPredicates(args: {
  ctx: CodegenContext;
  registerNative: RegisterNative;
  objectTypeIdx: number;
  propMapTypeIdx: number;
  propEntryTypeIdx: number;
  propMapRef: ValType;
  entryRefNull: ValType;
  FLAG_WRITABLE: number;
  FLAG_CONFIGURABLE: number;
  FLAG_ACCESSOR: number;
  OBJ_FLAG_NONEXTENSIBLE: number;
  OBJ_FLAG_SEALED: number;
  OBJ_FLAG_FROZEN: number;
}): number | undefined {
  const {
    ctx,
    registerNative,
    objectTypeIdx,
    propMapTypeIdx,
    propEntryTypeIdx,
    propMapRef,
    entryRefNull,
    FLAG_WRITABLE,
    FLAG_CONFIGURABLE,
    FLAG_ACCESSOR,
    OBJ_FLAG_NONEXTENSIBLE,
    OBJ_FLAG_SEALED,
    OBJ_FLAG_FROZEN,
  } = args;
  const integrityBagIdx = registerIntegrityBagResolver(ctx, registerNative);
  // `isFrozen`/`isSealed` are COMPUTED (§7.3.15 TestIntegrityLevel); the stored
  // bit is only the `freeze`/`seal` fast path. `isExtensible` gets no walk —
  // `[[Extensible]]` really is a slot.
  const levelWalkFor = (requireNonWritable: boolean) => ({
    propMapTypeIdx,
    propEntryTypeIdx,
    propMapRef,
    entryRefNull,
    requireNonWritable,
    OBJ_FLAG_NONEXTENSIBLE,
    FLAG_WRITABLE,
    FLAG_CONFIGURABLE,
    FLAG_ACCESSOR,
    FLAG_TOMBSTONE,
  });
  const emit = (
    name: string,
    flagBit: number,
    invert: boolean,
    terminalResult: number,
    levelWalk?: ReturnType<typeof levelWalkFor>,
  ): void => {
    const { locals, body } = buildIntegrityPredicate({
      objectTypeIdx,
      flagBit,
      invert,
      terminalResult,
      integrityBagIdx,
      levelWalk,
    });
    registerNative(name, [{ kind: "externref" }], [{ kind: "i32" }], locals, body);
  };
  // ES §20.5.2.13/14: isFrozen/isSealed on a NON-object return TRUE;
  // §20.5.2.12: isExtensible on a non-object returns FALSE.
  emit("__object_isFrozen", OBJ_FLAG_FROZEN, false, 1, levelWalkFor(true));
  emit("__object_isSealed", OBJ_FLAG_SEALED, false, 1, levelWalkFor(false));
  emit("__object_isExtensible", OBJ_FLAG_NONEXTENSIBLE, true, 0);
  // Known-object variants: same body, terminal fallback flipped to the ORDINARY
  // OBJECT rule. Standalone/wasi only — host already answers these correctly.
  if (integrityBagIdx !== undefined) {
    emit("__object_isFrozen_obj", OBJ_FLAG_FROZEN, false, 0, levelWalkFor(true));
    emit("__object_isSealed_obj", OBJ_FLAG_SEALED, false, 0, levelWalkFor(false));
    emit("__object_isExtensible_obj", OBJ_FLAG_NONEXTENSIBLE, true, 1);
  }
  return integrityBagIdx;
}
