// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V13, #2727) §9.1.1.4.17 CreateGlobalVarBinding — ONE storage cell for
 * a Script's top-level `var` and its global-object property, standalone.
 *
 * A top-level `var` lives in a wasm module global: bare `v`, and the static
 * `this.v` / `globalThis.v` arms (#4500 Slice A), read and write it directly.
 * #4491 T4 gave the global object a matching own property so the BINDING
 * questions (`in`, `hasOwnProperty`, `for…in`, `delete`) answer, but its value
 * was a one-time `undefined` seed. A receiver only known at run time — the
 * global object reaching a sloppy callee as `this` (`Array.from(a, f, this)`,
 * `f.call(this)`) — therefore read the stale seed and wrote a property the
 * `var` never saw:
 *
 *     var arrayIndex = -1;
 *     function mapFn() { this.arrayIndex++; return this.arrayIndex; }
 *     Array.from([1], mapFn, this);   // NaN, and `arrayIndex` stays -1
 *
 * The property is now a non-configurable ACCESSOR entry whose getter/setter
 * read and write the module global — so the global stays the single cell and
 * every direct access keeps its fast path — and the entry is branded so the
 * reflective MOP still reports what §9.1.1.4.17 creates, a DATA property
 * `{ value, writable: true, enumerable: true, configurable: false }`:
 *  - `__getOwnPropertyDescriptor` → that data descriptor over the live value
 *    (the arm is shared with the #6651 V6 namespace exotic object);
 *  - `__defineProperty_value` → §10.1.6.3 on a writable non-configurable data
 *    property: a `value` writes the binding, `writable: false` converts the
 *    entry into the plain non-writable data property it now is, and
 *    `configurable: true` / `enumerable: false` / an accessor reject.
 * Everything else ([[Get]], [[Set]], `in`, own-key enumeration, `delete` → false)
 * is already right for a non-configurable enumerable accessor.
 *
 * The getter/setter bodies are filled HERE, after every function body has been
 * compiled, so they read the global's FINAL wasm type: a later widening of the
 * var's carrier cannot leave a stale conversion behind. A type this module does
 * not convert degrades to `undefined` / a dropped write, never to a trap.
 */
import type { GlobalDef, Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import {
  type ArmResources,
  armResources,
  bindingGuard,
  bindingValue,
  installDescriptorArm,
  markBindingEntryInstrs,
  prepend,
  rejectInstrs,
} from "./module-namespace-exotic.js";
import { bound } from "./ports.js"; // core helpers, injected — keeps this leaf out of the import SCC

const undefinedExternInstrs = bound("undefinedExternInstrs");

/** `$PropEntry.flags`: this accessor entry is a script `var` binding view. */
const FLAG_GLOBAL_VAR = 0x200;
/** `$Object.flags` (field 4): the object carries ≥1 script `var` binding view. */
const OBJ_FLAG_GLOBAL_VAR = 0x200;
const ENTRY_VALUE = 1;
const ENTRY_FLAGS = 2;
const ENTRY_GET = 4;
const ENTRY_SET = 5;
const NONE_HEAP = -18;
/** Native entry bits cleared when `writable: false` turns the view into plain data. */
const CLEAR_ON_FREEZE = 0x01 | 0x08 | FLAG_GLOBAL_VAR;

/**
 * One reserved getter/setter pair over a script `var`'s module global.
 * `coerce` is the core coercion engine (`coercionInstrs`), injected by the
 * caller so this leaf imports nothing from the core.
 */
export interface GlobalVarAccessor {
  readonly global: GlobalDef;
  readonly getName: string;
  readonly setName: string;
  readonly coerce: (from: ValType, to: ValType) => Instr[];
}

const EXTERN: ValType = { kind: "externref" };

const pending = new WeakMap<CodegenContext, GlobalVarAccessor[]>();

/** Can the getter/setter convert this carrier without a trapping cast? */
export function globalVarAccessorSupports(global: GlobalDef): boolean {
  const kind = global.type.kind;
  return kind === "externref" || kind === "f64" || kind === "ref" || kind === "ref_null";
}

/**
 * Instructions that brand the own entry `key` of the global object in
 * `objLocal` as a `var` binding view. Records `accessor` for the post-pass fill.
 */
export function markGlobalVarBindingInstrs(
  ctx: CodegenContext,
  objLocal: number,
  keyInstrs: readonly Instr[],
  entryLocal: number,
  accessor: GlobalVarAccessor,
): Instr[] {
  const instrs = markBindingEntryInstrs(ctx, objLocal, keyInstrs, entryLocal, FLAG_GLOBAL_VAR, OBJ_FLAG_GLOBAL_VAR);
  if (instrs.length === 0) return instrs;
  let list = pending.get(ctx);
  if (list === undefined) pending.set(ctx, (list = []));
  list.push(accessor);
  return instrs;
}

function globalIndex(ctx: CodegenContext, global: GlobalDef): number | undefined {
  const local = ctx.mod.globals.indexOf(global);
  return local < 0 ? undefined : ctx.numImportGlobals + local;
}

/** The getter body: the module global, boxed to externref. */
function getterBody(ctx: CodegenContext, accessor: GlobalVarAccessor, undef: Instr[]): Instr[] {
  const index = globalIndex(ctx, accessor.global);
  const type = accessor.global.type;
  if (index === undefined) return undef;
  if (!globalVarAccessorSupports(accessor.global)) return undef;
  return [{ op: "global.get", index }, ...accessor.coerce(type, EXTERN)];
}

/** The setter body (param 0 = the new value): convert, store, answer `undefined`. */
function setterBody(ctx: CodegenContext, accessor: GlobalVarAccessor, undef: Instr[]): Instr[] {
  const index = globalIndex(ctx, accessor.global);
  const type = accessor.global.type;
  if (index === undefined) return undef;
  const value: Instr = { op: "local.get", index: 0 };
  const write: Instr = { op: "global.set", index };
  if (type.kind === "externref") return [value, write, ...undef];
  if (type.kind === "f64") return [value, ...accessor.coerce(EXTERN, type), write, ...undef];
  if (type.kind === "ref" || type.kind === "ref_null") {
    // A value of another shape cannot live in this typed slot; dropping the
    // write is the same answer the static `this.v = …` arm gives it. A
    // nullable slot also takes `null`.
    const store: Instr[] = [
      value,
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: type.typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [value, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: type.typeIdx }, write],
      },
    ];
    if (type.kind === "ref") return [...store, ...undef];
    return [
      value,
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null", typeIdx: type.typeIdx }, write],
        else: store,
      },
      ...undef,
    ];
  }
  return undef;
}

/**
 * §10.1.6.3 ValidateAndApplyPropertyDescriptor for a DATA descriptor (host flag
 * encoding in param 3) against current `{writable: true, enumerable: true,
 * configurable: false}`.
 */
function defineValueArm(ctx: CodegenContext, r: ArmResources, entryLocal: number): Instr[] {
  const setterCallIdx = ctx.funcMap.get("__call_accessor_set");
  const reject = rejectInstrs(ctx, "TypeError: Cannot redefine property: non-configurable global variable");
  if (setterCallIdx === undefined || reject === undefined) return [];
  const masked = (mask: number, equals: number): Instr[] => [
    { op: "local.get", index: 3 },
    { op: "i32.trunc_sat_f64_u" },
    { op: "i32.const", value: mask },
    { op: "i32.and" },
    { op: "i32.const", value: equals },
    { op: "i32.eq" },
  ];
  const entry = (): Instr[] => [{ op: "local.get", index: entryLocal }, { op: "ref.as_non_null" }];
  const t = r.propEntryTypeIdx;
  return bindingGuard(r, entryLocal, [
    ...masked(0x24, 0x24), // configurable specified and true
    ...masked(0x12, 0x10), // enumerable specified and false
    { op: "i32.or" },
    ...masked(0x40, 0x40), // accessor descriptor
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: reject },
    // `value` present → [[Set]] the binding through the entry's own setter.
    ...masked(0x80, 0x80),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        ...entry(),
        { op: "struct.get", typeIdx: t, fieldIdx: ENTRY_SET },
        { op: "extern.convert_any" },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: setterCallIdx },
      ],
    },
    // `writable: false` → the property becomes plain non-writable data holding
    // the binding's current value; it is no longer a view of the `var`.
    ...masked(0x09, 0x08),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...entry(),
        ...bindingValue(r, entryLocal),
        { op: "any.convert_extern" },
        { op: "struct.set", typeIdx: t, fieldIdx: ENTRY_VALUE },
        ...entry(),
        ...entry(),
        { op: "struct.get", typeIdx: t, fieldIdx: ENTRY_FLAGS },
        { op: "i32.const", value: ~CLEAR_ON_FREEZE },
        { op: "i32.and" },
        { op: "struct.set", typeIdx: t, fieldIdx: ENTRY_FLAGS },
        ...entry(),
        { op: "ref.null", typeIdx: NONE_HEAP },
        { op: "struct.set", typeIdx: t, fieldIdx: ENTRY_GET },
        ...entry(),
        { op: "ref.null", typeIdx: NONE_HEAP },
        { op: "struct.set", typeIdx: t, fieldIdx: ENTRY_SET },
      ],
    },
    { op: "local.get", index: 0 },
    { op: "return" },
  ]);
}

/**
 * Fill every reserved getter/setter and install the MOP arms. Runs once per
 * compile at the accessor-driver fill, after every native it patches exists.
 */
export function installGlobalVarBindingArms(ctx: CodegenContext): void {
  const list = pending.get(ctx);
  if (list === undefined) return;
  pending.delete(ctx);
  const undef = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr];
  for (const accessor of list) {
    const getter = ctx.mod.functions.find((f) => f.name === accessor.getName);
    const setter = ctx.mod.functions.find((f) => f.name === accessor.setName);
    if (getter) getter.body = getterBody(ctx, accessor, [...undef]);
    if (setter) setter.body = setterBody(ctx, accessor, [...undef]);
  }
  const r = armResources(ctx, FLAG_GLOBAL_VAR, OBJ_FLAG_GLOBAL_VAR);
  if (r === undefined) return;
  installDescriptorArm(ctx, r);
  prepend(ctx, r, "__defineProperty_value", (entryLocal) => defineValueArm(ctx, r, entryLocal));
}
