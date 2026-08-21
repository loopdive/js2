// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4098 G1 stage 1) Per-instance own-property **DELETABILITY** for user-declared
 * class instances — the substrate that makes `delete o[k]` real on a WasmGC
 * closed struct.
 *
 * ## The defect
 * A public class instance field is installed on the *instance* with
 * `{writable, enumerable, configurable} = true` (§15.7.14 DefineField).
 * `hasOwnProperty` and the dynamic read already answer for it (the
 * `fillClosedStruct*Arms` ladders), but `delete o[k]` is a **silent no-op**: a
 * WasmGC struct field cannot be removed. `propertyHelper.js`'s `isConfigurable`
 * is literally
 *
 * ```js
 * try { delete obj[name]; } catch (e) { … }
 * return !__hasOwnProperty(obj, name);
 * ```
 *
 * so **100 % of the 124-file population** (measured, floored, in the issue file)
 * fails on this one step regardless of what the descriptor says.
 *
 * ## Why deletability ships BEFORE visibility — the -684 receipt
 * #4010's ordering law:
 *
 * > Own-property VISIBILITY cannot ship before own-property DELETABILITY.
 *
 * #4055 v1 widened `hasOwnProperty` over a side table first and the merge queue
 * parked it for **-684** host-free passes. Stages 3-4 of #4098
 * (`getOwnPropertyDescriptor`, `Object.keys`/for-in) reproduce exactly that shape
 * on this issue's own stratum if they land without this module underneath them.
 * This stage therefore moves the surfaces in the **narrowing** direction only:
 * `hasOwnProperty` goes `true → false`, and only after an explicit `delete` that
 * is a broken no-op today.
 *
 * ## The tombstone representation — a SELF-REFERENTIAL bag entry
 * The #3468 carrier bag is keyed by **`eqref` identity**, not by closure type
 * (`narrowRecvToEq` is `any.convert_extern; ref.cast eqref`), and a class
 * instance is a WasmGC struct — therefore an `eqref`. So
 * `__closure_bag_lookup` / `__closure_bag_ensure` work on an instance
 * **unchanged**; this module adds a *predicate* and *arms*, not a new side table.
 *
 * The marker for "this declared field was deleted" is the bag entry
 *
 * ```
 * bag[k] === bag        // the bag stores ITSELF under the deleted key
 * ```
 *
 * Three properties make that the right marker, and they are why this is not the
 * more obvious `FLAG_TOMBSTONE`:
 *
 * - **It is detectable.** A real §10.1.10 tombstone is skipped by `__obj_find`,
 *   `__obj_ordered` *and* `__obj_ordered_all` alike, so "deleted" would be
 *   indistinguishable from "never present" — the screens below could not read it
 *   without a new tombstone-piercing native inside the `object-runtime.ts`
 *   god-file (its `emitClassifyKey`/`emitKeyMatch` are function-local closures).
 * - **It is unforgeable.** The bag is unreachable from user source, so no program
 *   can produce a value `ref.eq` to it. Contrast a sentinel string or a
 *   module-global marker object, either of which a sufficiently adversarial test
 *   could observe or synthesise.
 * - **It costs no allocation and no global.** Identity comes free with the bag
 *   that `ensure` already had to create.
 *
 * ## Composition — screens ANSWER FIRST, and only ever subtract
 * Each wiring point puts `__instance_field_deleted` **ahead of** its closed-struct
 * ladder, because {@link fillClosedStructHasOwnArms}' prologue returns
 * *unconditionally* on a field-name match: a screen placed after it can never
 * run. (Same short-circuit shape #4010 recorded for `fillVecHasOwnHelpers`.) The
 * screen returns the "absent" answer for a tombstoned key and falls through
 * untouched for every other receiver/key, so output for a program that never
 * deletes an instance field is byte-identical.
 *
 * ## What this stage deliberately does NOT do
 * - **No visibility widening.** `__carrier_bag_of` gets **no** instance arm here,
 *   so the #4010 S3 surfaces (`gOPD`, `Object.keys`, for-in) still do not consult
 *   an instance's bag. That is the ordering law, and it is also what keeps the
 *   self-referential marker unobservable: nothing enumerates an instance bag yet.
 *   ⚠ **Stage 3/4 must filter `bag[k] === bag` when they wire the instance arm
 *   in**, or the marker leaks into `Object.keys` as a real entry.
 * - **No write-through.** `o[k] = v` on a declared field still does not land
 *   (`__extern_set` has no closed-struct field arm) — that is stage 2, and it is
 *   what will make a *resurrection* after `delete` observable. Until then a
 *   tombstone is permanent, which is a strict improvement over a `delete` that
 *   does nothing at all, but it is not yet the full §10.1.9 round trip.
 * - **Static reads are not screened.** `o.foo` where `o: C` compiles to
 *   `struct.get` and cannot consult a tombstone without a cost on every field
 *   read. After `delete o.foo` a static read still sees the old value while the
 *   dynamic path correctly says absent. TypeScript rejects `delete o.foo` on a
 *   non-optional declared field, so this is reachable only through `any`, and the
 *   test262 population is entirely dynamic — a deliberate, bounded divergence.
 *
 * ## Byte-neutrality
 * Everything is gated on `ctx.standalone || ctx.wasi` (in gc/host mode the
 * `env::__extern_*` imports own the dynamic-property path) and on the module
 * actually declaring a class. Every placeholder body is the "nothing to add"
 * answer (`0`), so a skipped fill degrades to exactly today's behaviour instead
 * of trapping.
 */
import { inheritedSetAnyDirty } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** `(externref v) -> i32` — 1 iff `v` is an instance of a user-declared class. */
export const IS_CLASS_INSTANCE_CARRIER = "__is_class_instance_carrier";
/** `(externref obj, externref key) -> i32` — 1 iff a tombstone was written. */
export const INSTANCE_FIELD_TOMBSTONE = "__instance_field_tombstone";
/** `(externref obj, externref key) -> i32` — 1 iff `key` is tombstoned on `obj`. */
export const INSTANCE_FIELD_DELETED = "__instance_field_deleted";

const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
const CLOSURE_BAG_ENSURE = "__closure_bag_ensure";

/** Abbreviated heap type `eq` (`closure-props.ts` uses the same encoding). */
const EQ_HEAP_TYPE = -19;

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * The user-declared-class struct type indices, in `ctx.structFields` order.
 *
 * `ctx.classDeclarationMap` is written **only** by `collectClassDeclaration`
 * (`class-bodies.ts`) and keyed by class name — the same key space as
 * `ctx.structMap`. A struct name in that map therefore came from a user-source
 * `class` declaration or class expression, and builtin carriers (Date, RegExp,
 * Error, the vec/closure wrappers) are never in it. That is a **structural**
 * screen, not a name-shape heuristic — the exact property #4086 records
 * `startsWith("__")` as failing to have, and the one #4071 needed when letting
 * closed-struct fields into `Object.keys` measured -5 (`Object.keys(new Date(0))`
 * answering `["timestamp"]`).
 */
function userClassStructTypeIdxs(ctx: CodegenContext): number[] {
  const idxs: number[] = [];
  const seen = new Set<number>();
  for (const className of ctx.classDeclarationMap.keys()) {
    const typeIdx = ctx.structMap.get(className);
    if (typeIdx === undefined || seen.has(typeIdx)) continue;
    seen.add(typeIdx);
    idxs.push(typeIdx);
  }
  return idxs;
}

/**
 * Reserve the three natives as placeholder defined funcs so `__delete_property`'s
 * non-`$Object` arm and the closed-struct ladders can bake a `call <idx>` long
 * before the fill knows their bodies. Append-only mint (no funcIdx shifts),
 * idempotent, and a no-op outside standalone/wasi.
 */
export function reserveInstanceTombstones(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (ctx.funcMap.get(IS_CLASS_INSTANCE_CARRIER) !== undefined) return;

  const reserve = (name: string, params: ValType[]): void => {
    const typeIdx = addFuncType(ctx, params, [I32], `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    // Locals are assigned at FILL (they need types cheapest to resolve there);
    // the "nothing to add" placeholder below uses none.
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [],
      body: [{ op: "i32.const", value: 0 }],
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  };

  reserve(IS_CLASS_INSTANCE_CARRIER, [EXT]);
  reserve(INSTANCE_FIELD_TOMBSTONE, [EXT, EXT]);
  reserve(INSTANCE_FIELD_DELETED, [EXT, EXT]);
}

/**
 * `if (__instance_field_deleted(<obj>, <key>)) { ...absent }` — the screen every
 * closed-struct reflective ladder puts at its head.
 *
 * Returns `[]` when the native was never reserved, so the caller keeps its
 * current body unchanged. `objLocal`/`keyLocal` default to the `(0 = obj,
 * 1 = key)` shape all three hasOwn-family natives share.
 */
export function buildTombstoneScreen(ctx: CodegenContext, absent: Instr[], objLocal = 0, keyLocal = 1): Instr[] {
  const idx = ctx.funcMap.get(INSTANCE_FIELD_DELETED);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objLocal },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: idx },
    { op: "if", blockType: { kind: "empty" }, then: absent },
  ];
}

/**
 * `if (!__instance_field_deleted(obj, <key>)) { ...body }` — the enumeration
 * form of {@link buildTombstoneScreen}, for a site whose key is a **literal**
 * rather than a parameter (`getOwnPropertyNames` emits one arm per field name).
 *
 * `keyInstrs` must leave one `externref` on the stack. Returns `body` unwrapped
 * when the native was never reserved, so the caller's emission is unchanged.
 */
export function buildTombstoneSkip(ctx: CodegenContext, keyInstrs: Instr[], body: Instr[]): Instr[] {
  const idx = ctx.funcMap.get(INSTANCE_FIELD_DELETED);
  if (idx === undefined) return body;
  return [
    { op: "local.get", index: 0 },
    ...keyInstrs,
    { op: "call", funcIdx: idx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: body },
  ];
}

/**
 * `if (__instance_field_tombstone(obj, key)) return 1;` — the arm
 * `__delete_property` runs on a non-`$Object` receiver, *after* the #2896
 * builtin-fn metadata arm and the #4010 carrier-bag arm have both declined.
 *
 * Ordering is load-bearing: `delete fn.name` / `delete fn.length` on a builtin
 * stays with `__builtinfn_delete`, and a real bag entry stays with
 * `__carrier_bag_delete` — the `built-ins/**\/{name,length}.js` stratum is the
 * ~700-file population that cost #4055 v1 its -684, and it never reaches here.
 */
export function buildInstanceTombstoneDeleteArm(ctx: CodegenContext): Instr[] {
  const idx = ctx.funcMap.get(INSTANCE_FIELD_TOMBSTONE);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: idx },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
  ];
}

/**
 * Fill the three natives at FINALIZE, once every class struct is registered and
 * `__closure_bag_lookup` / `__closure_bag_ensure` / `__extern_get` /
 * `__extern_set` are in `funcMap`. Leaves the `0` placeholders (the "nothing to
 * add" answers) in place when a dependency is missing or the module declares no
 * classes.
 */
export function fillInstanceTombstones(ctx: CodegenContext): void {
  const carrierIdx = ctx.funcMap.get(IS_CLASS_INSTANCE_CARRIER);
  if (carrierIdx === undefined) return;
  const lookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const ensureIdx = ctx.funcMap.get(CLOSURE_BAG_ENSURE);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  // #4504: an internal tombstone marker must never be routed through the
  // public [[Set]] entry point while its inherited-descriptor resolver is
  // active.  The marker belongs to the hidden bag's OWN table; a prototype
  // setter on Object.prototype must neither observe delete nor replace it.
  const externSetOwnIdx = ctx.funcMap.get("__extern_set_own");
  const inheritedSetRuntimeActive = ctx.standalone && inheritedSetAnyDirty(ctx) && externSetOwnIdx !== undefined;
  if (lookupIdx === undefined || ensureIdx === undefined || externGetIdx === undefined || externSetIdx === undefined) {
    return;
  }

  const setFn = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };

  // ── __is_class_instance_carrier(v) -> i32 ────────────────────────────────
  // A `ref.test` over each user class's struct root also matches every
  // subclass instance (subclass structs are declared as WasmGC subtypes), so
  // the chain does not have to be closed under inheritance to be complete.
  {
    const typeIdxs = userClassStructTypeIdxs(ctx);
    if (typeIdxs.length === 0) return; // no classes ⇒ leave every placeholder at 0
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
    for (const typeIdx of typeIdxs) {
      body.push(
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
      );
    }
    body.push({ op: "i32.const", value: 0 });
    setFn(IS_CLASS_INSTANCE_CARRIER, [{ name: "__any", type: { kind: "anyref" } }], body);
  }

  /** `if (!__is_class_instance_carrier(obj)) return 0;` */
  const requireCarrier: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: carrierIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
  ];

  // ── __instance_field_tombstone(obj, key) -> i32 ──────────────────────────
  // ENSURE (not lookup): a delete is a mutation, and it is the one operation
  // that legitimately has to create the receiver's bag. The value stored is the
  // bag itself — see the module header for why identity is the marker.
  setFn(
    INSTANCE_FIELD_TOMBSTONE,
    [{ name: "__bag", type: EXT }],
    [
      ...requireCarrier,
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: ensureIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 2 }, // obj = bag
      { op: "local.get", index: 1 }, // key
      { op: "local.get", index: 2 }, // value = bag  ← the marker
      ...(inheritedSetRuntimeActive
        ? ([{ op: "call", funcIdx: externSetOwnIdx! }, { op: "drop" }] satisfies Instr[])
        : ([{ op: "call", funcIdx: externSetIdx }] satisfies Instr[])),
      { op: "i32.const", value: 1 },
    ],
  );

  // ── __instance_field_deleted(obj, key) -> i32 ────────────────────────────
  // LOOKUP, never ensure: a *query* must never allocate a bag, or merely asking
  // whether a property is present would hand a later `__integrity_bag` consumer
  // a carrier that previously had none (the `carrier-bag-hasown.ts` rule).
  setFn(
    INSTANCE_FIELD_DELETED,
    [
      { name: "__bag", type: EXT },
      { name: "__v", type: EXT },
    ],
    [
      ...requireCarrier,
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: externGetIdx },
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      // ref.eq over the two `eqref`-narrowed refs. `__extern_get`'s undefined
      // sentinel is not the bag, so this is decisive: 1 only for a key this
      // module's own tombstone arm wrote.
      { op: "local.get", index: 3 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.eq" },
    ],
  );
}
