// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V6) §10.4.6 module namespace exotic object internals, standalone.
 *
 * The namespace builder (`module-namespace-value.ts`) materializes a namespace
 * as an ordinary null-prototype, non-extensible `$Object` whose export slots are
 * non-configurable accessor entries over zero-argument binding getters (the
 * getter throws the binding's TDZ ReferenceError). That already gives [[Get]],
 * [[Set]] and [[Delete]]. What an ordinary accessor cannot express is that the
 * spec's export property is a DATA property `{value, writable: true,
 * enumerable: true, configurable: false}` whose [[GetOwnProperty]] READS the
 * binding (§10.4.6.5 — so an uninitialized binding throws), and whose
 * [[DefineOwnProperty]] (§10.4.6.6) never changes anything.
 *
 * The builder marks each binding entry with {@link FLAG_NS_BINDING} and the
 * object with {@link OBJ_FLAG_MODULE_NAMESPACE}; the arms below are PREPENDED
 * to the generic natives and fire only for a marked entry, so no other object
 * observes a change:
 *  - `__getOwnPropertyDescriptor` → the data descriptor of the binding value;
 *  - `__hasOwnProperty` / `__object_hasOwn` / `__propertyIsEnumerable` →
 *    [[GetOwnProperty]] runs (TDZ throws), then true;
 *  - `__defineProperty_value` / `__defineProperty_accessor` → §10.4.6.6:
 *    accept exactly the descriptors compatible with the binding, reject the
 *    rest through the #6770 rejection channel (so `Reflect.defineProperty`
 *    answers false and `Object.defineProperty` throws);
 *  - `__object_freeze` → TypeError (a writable export cannot be frozen),
 *    `__object_isFrozen` → false.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { ensureExnTag } from "../registry/physical-imports.js";
import { ensureDefineRejectionGlobal } from "./define-rejection-channel.js";
import { bound } from "./ports.js"; // core helpers, injected — keeps this leaf out of the import SCC

const addStringConstantGlobal = bound("addStringConstantGlobal");
const stringConstantExternrefInstrs = bound("stringConstantExternrefInstrs");

/** `$PropEntry.flags`: this accessor entry is a module namespace export binding. */
const FLAG_NS_BINDING = 0x100;
/** `$Object.flags` (field 4): the object is a module namespace with ≥1 binding. */
const OBJ_FLAG_MODULE_NAMESPACE = 0x100;
const ENTRY_FLAGS = 2;
const ENTRY_GET = 4;
const OBJECT_FLAGS = 4;

const usedBy = new WeakSet<CodegenContext>();

/**
 * Instructions that mark the own entry `key` of the namespace `$Object` held in
 * `objLocal` (externref) as a binding, and brand the object. Empty unless the
 * native object runtime is present. `entryLocal` is a scratch
 * `(ref null $PropEntry)` local of the caller.
 */
export function markNamespaceBindingInstrs(
  ctx: CodegenContext,
  objLocal: number,
  keyInstrs: readonly Instr[],
  entryLocal: number,
): Instr[] {
  const types = ctx.objectRuntimeTypes;
  const findIdx = ctx.funcMap.get("__obj_find");
  if (!ctx.standalone || types === undefined || findIdx === undefined) return [];
  usedBy.add(ctx);
  const obj = (): Instr[] => [
    { op: "local.get", index: objLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: types.objectTypeIdx },
  ];
  return [
    ...obj(),
    ...keyInstrs,
    { op: "call", funcIdx: findIdx },
    { op: "local.tee", index: entryLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: entryLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: entryLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: types.propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
        { op: "i32.const", value: FLAG_NS_BINDING },
        { op: "i32.or" },
        { op: "struct.set", typeIdx: types.propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
        ...obj(),
        ...obj(),
        { op: "struct.get", typeIdx: types.objectTypeIdx, fieldIdx: OBJECT_FLAGS },
        { op: "i32.const", value: OBJ_FLAG_MODULE_NAMESPACE },
        { op: "i32.or" },
        { op: "struct.set", typeIdx: types.objectTypeIdx, fieldIdx: OBJECT_FLAGS },
      ],
    },
  ];
}

interface ArmResources {
  objectTypeIdx: number;
  propEntryTypeIdx: number;
  findIdx: number;
  getterCallIdx: number;
  toKeyIdx: number | undefined;
}

/** `i32` 1 when param `obj` is a branded namespace (no entry lookup). */
function brandTest(r: ArmResources, obj = 0): Instr[] {
  return [
    { op: "local.get", index: obj },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: r.objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: obj },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: r.objectTypeIdx },
        { op: "struct.get", typeIdx: r.objectTypeIdx, fieldIdx: OBJECT_FLAGS },
        { op: "i32.const", value: OBJ_FLAG_MODULE_NAMESPACE },
        { op: "i32.and" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/** `if (param `obj` is a namespace and its own entry for param 1 is a binding) then` — entry in `entryLocal`. */
function bindingGuard(r: ArmResources, entryLocal: number, then: Instr[], obj = 0): Instr[] {
  return [
    ...brandTest(r, obj),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: obj },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: r.objectTypeIdx },
        { op: "local.get", index: 1 },
        ...(r.toKeyIdx === undefined ? [] : [{ op: "call", funcIdx: r.toKeyIdx } as Instr]),
        { op: "call", funcIdx: r.findIdx },
        { op: "local.tee", index: entryLocal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [
            { op: "local.get", index: entryLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: r.propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
            { op: "i32.const", value: FLAG_NS_BINDING },
            { op: "i32.and" },
            { op: "if", blockType: { kind: "empty" }, then },
          ],
        },
      ],
    },
  ];
}

/** Push the binding's current value — §10.4.6.5 step 4 (TDZ ReferenceError). */
function bindingValue(r: ArmResources, entryLocal: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: entryLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: r.propEntryTypeIdx, fieldIdx: ENTRY_GET },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: r.getterCallIdx },
  ];
}

/** Add a scratch `(ref null $PropEntry)` local to native `name`; prepend `arm(local)`. */
function prepend(ctx: CodegenContext, r: ArmResources, name: string, arm: (entryLocal: number) => Instr[]): void {
  const idx = ctx.funcMap.get(name);
  const fn = idx === undefined ? undefined : ctx.mod.functions.find((f) => f.name === name);
  if (fn === undefined) return;
  const type = ctx.mod.types[fn.typeIdx];
  const params = type?.kind === "func" ? type.params.length : 0;
  const entryLocal = params + fn.locals.length;
  fn.locals.push({ name: "__v6_ns_entry", type: { kind: "ref_null", typeIdx: r.propEntryTypeIdx } });
  fn.body.unshift(...arm(entryLocal));
}

/** The rejection payload: a parked TypeError, thrown (#6770 S4 channel). */
function rejectInstrs(ctx: CodegenContext, message: string): Instr[] | undefined {
  const ctorIdx = ctx.funcMap.get("__new_TypeError");
  if (ctorIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, message);
  const park = ensureDefineRejectionGlobal(ctx);
  return [
    ...stringConstantExternrefInstrs(ctx, message),
    { op: "call", funcIdx: ctorIdx },
    ...(park === undefined
      ? []
      : ([
          { op: "global.set", index: park },
          { op: "global.get", index: park },
        ] as Instr[])),
    { op: "throw", tagIdx: ensureExnTag(ctx) },
  ];
}

/**
 * §10.4.6.6 for a DATA descriptor in the host flag encoding (param 3, f64):
 * reject `configurable: true`, `enumerable: false`, `writable: false`, or a
 * `value` that is not SameValue to the binding's; otherwise succeed unchanged.
 */
function defineValueArm(ctx: CodegenContext, r: ArmResources, entryLocal: number): Instr[] {
  const sameValueIdx = ctx.funcMap.get("__object_is");
  const reject = rejectInstrs(ctx, "TypeError: Cannot redefine a module namespace export");
  if (sameValueIdx === undefined || reject === undefined) return [];
  const flags = (): Instr[] => [{ op: "local.get", index: 3 }, { op: "i32.trunc_sat_f64_u" }];
  const masked = (mask: number, equals: number): Instr[] => [
    ...flags(),
    { op: "i32.const", value: mask },
    { op: "i32.and" },
    { op: "i32.const", value: equals },
    { op: "i32.eq" },
  ];
  return bindingGuard(r, entryLocal, [
    // current = O.[[GetOwnProperty]](P) — reads the binding first (TDZ).
    ...bindingValue(r, entryLocal),
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: sameValueIdx },
    { op: "i32.eqz" },
    ...flags(),
    { op: "i32.const", value: 0x80 },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    { op: "i32.and" }, // has value && !SameValue
    ...masked(0x24, 0x24), // configurable specified and true
    { op: "i32.or" },
    ...masked(0x12, 0x10), // enumerable specified and false
    { op: "i32.or" },
    ...masked(0x09, 0x08), // writable specified and false
    { op: "i32.or" },
    ...masked(0x40, 0x40), // accessor descriptor
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: reject },
    { op: "local.get", index: 0 },
    { op: "return" },
  ]);
}

/**
 * Install every arm. Runs once per compile at the accessor-driver fill, after
 * every native it patches has been emitted, and only when a namespace in this
 * module was marked.
 */
export function installModuleNamespaceExoticArms(ctx: CodegenContext): void {
  if (!usedBy.has(ctx)) return;
  usedBy.delete(ctx);
  const types = ctx.objectRuntimeTypes;
  const findIdx = ctx.funcMap.get("__obj_find");
  const getterCallIdx = ctx.funcMap.get("__call_accessor_get");
  if (types === undefined || findIdx === undefined || getterCallIdx === undefined) return;
  const r: ArmResources = {
    objectTypeIdx: types.objectTypeIdx,
    propEntryTypeIdx: types.propEntryTypeIdx,
    findIdx,
    getterCallIdx,
    toKeyIdx: ctx.funcMap.get("__to_property_key"),
  };
  const trueAfterRead = (entryLocal: number): Instr[] =>
    bindingGuard(r, entryLocal, [
      ...bindingValue(r, entryLocal),
      { op: "drop" },
      { op: "i32.const", value: 1 },
      { op: "return" },
    ]);
  for (const name of ["__hasOwnProperty", "__object_hasOwn", "__propertyIsEnumerable"]) {
    prepend(ctx, r, name, trueAfterRead);
  }
  installDescriptorArm(ctx, r);
  prepend(ctx, r, "__defineProperty_value", (entryLocal) => defineValueArm(ctx, r, entryLocal));
  const rejectAccessor = rejectInstrs(ctx, "TypeError: Cannot redefine a module namespace export");
  if (rejectAccessor !== undefined) {
    prepend(ctx, r, "__defineProperty_accessor", (entryLocal) =>
      bindingGuard(r, entryLocal, [...bindingValue(r, entryLocal), { op: "drop" }, ...rejectAccessor]),
    );
  }
  const rejectFreeze = rejectInstrs(ctx, "TypeError: Cannot freeze a module namespace object");
  if (rejectFreeze !== undefined) {
    prepend(ctx, r, "__object_freeze", () => [
      ...brandTest(r),
      { op: "if", blockType: { kind: "empty" }, then: rejectFreeze },
    ]);
  }
  prepend(ctx, r, "__object_isFrozen", () => [
    ...brandTest(r),
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
  ]);
}

/** `__getOwnPropertyDescriptor` → `{value, writable: true, enumerable: true, configurable: false}`. */
function installDescriptorArm(ctx: CodegenContext, r: ArmResources): void {
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const setIdx = ctx.funcMap.get("__extern_set");
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  if (newObjectIdx === undefined || setIdx === undefined || boxBoolIdx === undefined) return;
  for (const key of ["value", "writable", "enumerable", "configurable"]) addStringConstantGlobal(ctx, key);
  const fn = ctx.mod.functions.find((f) => f.name === "__getOwnPropertyDescriptor");
  if (fn === undefined) return;
  const descLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__v6_ns_desc", type: { kind: "externref" } });
  const put = (key: string, value: Instr[]): Instr[] => [
    { op: "local.get", index: descLocal },
    ...stringConstantExternrefInstrs(ctx, key),
    ...value,
    { op: "call", funcIdx: setIdx },
  ];
  const bool = (value: number): Instr[] => [
    { op: "i32.const", value },
    { op: "call", funcIdx: boxBoolIdx },
  ];
  prepend(ctx, r, "__getOwnPropertyDescriptor", (entryLocal) =>
    bindingGuard(r, entryLocal, [
      { op: "call", funcIdx: newObjectIdx },
      { op: "local.set", index: descLocal },
      ...put("value", bindingValue(r, entryLocal)),
      ...put("writable", bool(1)),
      ...put("enumerable", bool(1)),
      ...put("configurable", bool(0)),
      { op: "local.get", index: descLocal },
      { op: "return" },
    ]),
  );
}
