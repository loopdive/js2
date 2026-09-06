// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// class-object-of.ts — (#5354) "which class does this struct belong to?",
// answered by the module that OWNS the struct.
//
// ## The gap this closes
//
// A compiled class that crosses the #2527 linked-provider seam as a VALUE is
// presented to the consumer by `_makeClassCtorMirrorForHost` (runtime.ts): a
// constructible host `Function` proxy whose `.prototype` is a chain-aware
// FACADE object. An instance minted by that mirror's `[[Construct]]` — or by
// any provider-side factory — reaches the consumer as a `_wrapForHost` proxy
// whose `getPrototypeOf` trap answered a hardcoded `Object.prototype`.
//
// So the two halves of the object-identity graph were unrelated objects:
//
//     d instanceof Temporal.PlainDate                            // false
//     Object.getPrototypeOf(d) === Temporal.PlainDate.prototype  // false
//     d.constructor                                              // undefined
//
// `instanceof` is OrdinaryHasInstance (§7.3.20): it reads `C.prototype` (the
// facade) and walks `[[Prototype]]` from the instance (`Object.prototype`),
// never meets, answers false. test262's `TemporalHelpers.assertPlainDate` opens
// with exactly that check, which is where 32 of the 123 #5249 calendar rows
// stopped.
//
// The fix is at IDENTITY, not at `instanceof`: the instance's `[[Prototype]]`
// must BE the object `C.prototype` answers. To do that the host has to know
// which class a foreign struct is an instance of — and only the owning module
// can say, because class discrimination is a `__tag` field read on a WasmGC
// struct the consumer has no type for.
//
// ## Shape
//
//     __class_object_of(inst) -> externref
//
//   * the class-object singleton whose `__tag` matches `inst`'s, or
//   * `null` when `inst` is not one of this module's host-registered classes,
//     or when that class's singleton has not been materialised yet (the
//     globals are lazy; the host then keeps its previous answer).
//
// Discrimination is by `__tag`, never by `ref.test` alone: WasmGC canonicalizes
// struct types structurally, so `class C { x }` and `class D { y }` are LITERALLY
// the same type and the first arm would swallow the other's instances (#2009,
// re-measured in #5195 F1). Every arm therefore tests the tag value.
//
// The class object and the class prototype are carriers of the SAME struct type
// with the SAME tag as an instance, so both answer this function. That is not
// filtered here — the runtime holds the identities (`_classProtoStructs`, the
// class object itself) and screens them at the one call site that cares, which
// costs no wasm bytes and cannot go stale.
//
// Gated on `ctx.classCtorHostRegistered` — the classes whose singleton actually
// reached `__register_class_ctor`, i.e. exactly those that can escape to the
// host at all. A module that never lets a class escape emits identical bytes.

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { exportFunc } from "./emit-helpers.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { noJsHost } from "./js-errors.js";
import { addFuncType } from "./registry/types.js";

export const CLASS_OBJECT_OF_EXPORT = "__class_object_of";
export const CLASS_PARENT_OF_EXPORT = "__class_parent_object_of";

interface ClassObjectOfArm {
  structTypeIdx: number;
  tagFieldIdx: number;
  tagValue: number;
  /** The class's own singleton — the answer for `__class_object_of`. */
  classObjectGlobalIdx: number;
  /** Its `extends` parent's singleton, when the parent is also host-visible. */
  parentClassObjectGlobalIdx?: number;
}

function collectArms(ctx: CodegenContext): ClassObjectOfArm[] {
  const arms: ClassObjectOfArm[] = [];
  for (const className of [...ctx.classCtorHostRegistered].sort()) {
    const structTypeIdx = ctx.structMap.get(className);
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    const tagValue = ctx.classTagMap.get(className);
    if (structTypeIdx === undefined || classObjectGlobalIdx === undefined || tagValue === undefined) continue;
    const tagFieldIdx = (ctx.structFields.get(className) ?? []).findIndex((field) => field.name === "__tag");
    // No tag ⇒ no way to tell this class apart from a structurally identical
    // one. Decline rather than risk answering another class's identity.
    if (tagFieldIdx < 0) continue;
    const parentName = ctx.classParentMap.get(className);
    const parentClassObjectGlobalIdx = parentName === undefined ? undefined : ctx.classObjectGlobals.get(parentName);
    arms.push({
      structTypeIdx,
      tagFieldIdx,
      tagValue,
      classObjectGlobalIdx,
      ...(parentClassObjectGlobalIdx !== undefined ? { parentClassObjectGlobalIdx } : {}),
    });
  }
  return arms;
}

/**
 * The shared tag-dispatch body: `answer(arm)` names the global to return, and
 * an arm that has no answer simply falls through to the trailing null.
 */
function tagDispatchBody(arms: ClassObjectOfArm[], answer: (arm: ClassObjectOfArm) => number | undefined): Instr[] {
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const arm of arms) {
    const globalIdx = answer(arm);
    if (globalIdx === undefined) continue;
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: arm.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: arm.structTypeIdx },
          { op: "struct.get", typeIdx: arm.structTypeIdx, fieldIdx: arm.tagFieldIdx },
          { op: "i32.const", value: arm.tagValue },
          { op: "i32.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // The singleton is lazily initialised — an untouched class holds a
          // null global, and answering it would tell the host "not a class
          // instance" in a way it cannot distinguish from the real miss. Same
          // null either way, deliberately: both mean "no answer from here".
          { op: "global.get", index: globalIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "global.get", index: globalIdx }, { op: "return" }],
            else: [],
          },
        ],
        else: [],
      },
    );
  }
  body.push({ op: "ref.null.extern" });
  return body;
}

/** Emit `__class_object_of`. Idempotent; no-op when nothing can escape. */
export function emitClassObjectOfExport(ctx: CodegenContext): void {
  if (ctx.wasi || ctx.standalone || noJsHost(ctx)) return;
  if (ctx.funcMap.has(CLASS_OBJECT_OF_EXPORT)) return;
  if (ctx.classCtorHostRegistered.size === 0) return;

  const arms = collectArms(ctx);
  if (arms.length === 0) return;

  const externRef: ValType = { kind: "externref" };

  const emit = (name: string, body: Instr[]): void => {
    const typeIdx = addFuncType(ctx, [externRef], [externRef], `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [{ name: "__inst_any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as WasmFunction);
    exportFunc(ctx.mod, name, funcIdx);
    ctx.funcMap.set(name, funcIdx);
  };

  emit(
    CLASS_OBJECT_OF_EXPORT,
    tagDispatchBody(arms, (arm) => arm.classObjectGlobalIdx),
  );

  // (#5354) `class B extends A` — the mirror's prototype facade is B.prototype,
  // and its own `[[Prototype]]` must be A.prototype (§15.7.14 step 6) or
  // `new B() instanceof A` is false across the seam. Only the owning module
  // knows the heritage; nothing on the host side records a STATIC parent.
  // Emitted only when some registered class actually has a host-visible parent.
  if (arms.some((arm) => arm.parentClassObjectGlobalIdx !== undefined)) {
    emit(
      CLASS_PARENT_OF_EXPORT,
      tagDispatchBody(arms, (arm) => arm.parentClassObjectGlobalIdx),
    );
  }
}
