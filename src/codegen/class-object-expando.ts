// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster C) A property ASSIGNED onto a class object at module scope —
 * `class K {}; K.foo = f;` — made visible to the dynamic object MOP, standalone.
 *
 * ## The defect, measured on the slice's base
 *
 * `registerModuleClassStaticAssignments` (codegen/index.ts) gives every
 * top-level `C.p = v` on an unreassigned class declaration its own mutable
 * `externref` global, `__static_C_p`, and every TYPED access of `C.p` (and
 * `this.p` inside a static member) lowers to `global.get`/`global.set` of it.
 * The dynamic MOP never learned that name → slot map. A read or write that
 * reaches the class object through an untyped value — `id(K).foo`, an `any`
 * alias, a parameter, `Reflect.get(K, "foo")`, the Promise combinator's
 * `Get(C, "resolve")` — takes `__extern_get` / `__extern_set`, which look in
 * the class object's own-property bag (#4194) and its static sidecar
 * (#5195), where the value never is. Two stores, no bridge:
 *
 * | probe (standalone, `.tmp/cx/j1.js`)            | base | node |
 * | ---------------------------------------------- | ---- | ---- |
 * | `K.foo = f` then `id(K).foo === f`             | false | true |
 * | `typeof id(K).foo`                             | "undefined" | "function" |
 * | `id(K).bar = 6` then typed `K.bar`             | old value | 6 |
 * | `Object.prototype.hasOwnProperty.call(id(K), "bar")` | false | true |
 *
 * It is what keeps D4's `{all,race}/invoke-resolve-on-promises-every-
 * iteration-of-custom.js` from ever calling the user's `Custom.resolve`.
 *
 * ## The representation decision: the GLOBAL stays the one store
 *
 * Two alternatives were measured before this one was chosen:
 *
 *  - **Drop the global and let every access use the bag** (the lane a write
 *    INSIDE a function body already takes). One store, and the bag's
 *    reflection is already wired. Rejected: it turns every typed read and call
 *    of such a property into a dynamic lookup, and the pattern is a HOT one in
 *    real code — jsbi (linked into the standalone Temporal provider) keeps
 *    `JSBI.__imul`, `JSBI.__kMaxLength`, `JSBI.__kBitConversionDouble`, … as
 *    exactly these top-level assignments. It also turned the typed read of an
 *    `extends Error` class object into an illegal-cast trap (the own-field
 *    arm of `property-access-dispatch.ts` types the class identifier as its
 *    INSTANCE), which the global lowering never reaches.
 *  - **Mirror into both stores.** Two sources of truth for one mutable slot —
 *    the exact hazard `class-static-sidecar.ts` refuses for static fields.
 *
 * So the global remains the ONLY storage, and the dynamic MOP is taught to
 * find it: an identity-guarded prologue on each native MOP helper,
 * `receiver === <C's class-object singleton> && key === "p"` → the global.
 * Typed code is byte-for-byte unchanged, and no value is ever held twice.
 *
 * ## What each helper answers
 *
 * | helper | on a hit |
 * | --- | --- |
 * | `__extern_get` | the global, when it holds a value |
 * | `__extern_set` | stores into the global (#4504 result channel: success) |
 * | `__extern_has`, `__hasOwnProperty`, `__object_hasOwn`, `__propertyIsEnumerable` | 1, when it holds a value |
 * | `__getOwnPropertyDescriptor` | `{ value, writable, enumerable, configurable }` (an assignment-created data property, §10.1.9 step 2) |
 * | `__delete_property` | clears the global, answers true |
 *
 * A global that is still `null` reads as ABSENT and falls through to the
 * pre-existing body, so a dynamic read that runs before the module-scope
 * assignment answers `undefined`, as the spec does. BOUNDED DIVERGENCE: the
 * lowering cannot tell a never-assigned cell from one assigned JS `null`
 * (both are `ref.null.extern`), so `K.p = null` reads back `undefined`
 * through the dynamic MOP — the typed read already returned the raw null for
 * both, so this narrows nothing that worked.
 *
 * NOT covered (recorded, not attempted): own-KEY enumeration (`Object.keys`,
 * `for-in`, gOPN) of the class object, and reflection written against the
 * class IDENTIFIER (`K.hasOwnProperty("p")`, `Object.keys(K)`), which is
 * folded at compile time from the declared members and never reaches these
 * helpers — the same gap a write inside a function body has today.
 *
 * ## Gate
 *
 * Standalone only, and only for classes with at least one recorded
 * module-scope assignment cell: every other module — and the gc lane — keeps
 * identical bytes. The cells are recorded at registration time and resolved
 * against the LIVE `staticProps` / `classObjectGlobals` maps at fill time, so
 * a later global-index shift cannot leave a stale index baked here.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { localGlobalIdx } from "./registry/imports.js";
import { fillClassStaticReflectiveArms } from "./class-static-descriptor.js"; // (#6767)

/** Per-compilation record: class name → property names assigned at module scope. */
const cellsByCtx = new WeakMap<CodegenContext, Map<string, Set<string>>>();

/**
 * Record that `className.propName` received a module-scope assignment cell
 * (`__static_<className>_<propName>`). Called by the registration prepass.
 */
export function recordClassObjectExpandoCell(ctx: CodegenContext, className: string, propName: string): void {
  let byClass = cellsByCtx.get(ctx);
  if (!byClass) {
    byClass = new Map();
    cellsByCtx.set(ctx, byClass);
  }
  let names = byClass.get(className);
  if (!names) {
    names = new Set();
    byClass.set(className, names);
  }
  names.add(propName);
}

/** Whether `className.propName` is a recorded module-scope assignment cell. */
export function isClassObjectExpandoCell(ctx: CodegenContext, className: string, propName: string): boolean {
  return cellsByCtx.get(ctx)?.get(className)?.has(propName) === true;
}

interface ExpandoCell {
  staticGlobalIdx: number;
  classObjectGlobalIdx: number;
  structTypeIdx: number;
}

/** propName → the (class, cell) pairs that own it, in deterministic order. */
function collectCells(ctx: CodegenContext): Map<string, ExpandoCell[]> {
  const byName = new Map<string, ExpandoCell[]>();
  const byClass = cellsByCtx.get(ctx);
  if (!byClass) return byName;
  for (const className of [...byClass.keys()].sort()) {
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    const structTypeIdx = ctx.structMap.get(className);
    if (classObjectGlobalIdx === undefined || structTypeIdx === undefined) continue;
    for (const propName of [...byClass.get(className)!].sort()) {
      const staticGlobalIdx = ctx.staticProps.get(`${className}_${propName}`);
      if (staticGlobalIdx === undefined) continue;
      if (ctx.mod.globals[localGlobalIdx(ctx, staticGlobalIdx)]?.type.kind !== "externref") continue;
      let cells = byName.get(propName);
      if (!cells) {
        cells = [];
        byName.set(propName, cells);
      }
      cells.push({ staticGlobalIdx, classObjectGlobalIdx, structTypeIdx });
    }
  }
  return byName;
}

type MopFn = { locals: { name: string; type: ValType }[]; body: Instr[] };

/**
 * Finalize: prepend the identity-guarded cell arms to the native MOP helpers.
 * Runs with `fillClassObjectNameArms` — after every competing `__extern_get`
 * prefix, including the proto-cache arm and its call-site inlining.
 */
export function fillClassObjectExpandoArms(ctx: CodegenContext): void {
  // (#6767) The DECLARED-static twin of these cells, filled first so a
  // module-scope assignment's arm (prepended below) answers ahead of it.
  fillClassStaticReflectiveArms(ctx);
  if (!ctx.standalone || ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0) return;
  const cells = collectCells(ctx);
  if (cells.size === 0) return;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined) return;

  /**
   * `if (typeof key is string) { flat = flatten(key); for each name:
   *    if (flat == name) for each owner: if (recv === owner's class object) hit }`
   */
  const prepend = (fn: MopFn | undefined, paramCount: number, hit: (cell: ExpandoCell) => Instr[]): void => {
    if (!fn) return;
    const recvLocal = paramCount + fn.locals.length;
    const keyLocal = recvLocal + 1;
    const flatLocal = recvLocal + 2;
    fn.locals.push(
      { name: "__cls_expando_recv", type: { kind: "anyref" } },
      { name: "__cls_expando_key", type: { kind: "anyref" } },
      { name: "__cls_expando_flat", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    );
    const nameArms: Instr[] = [];
    for (const [propName, owners] of cells) {
      const ownerArms: Instr[] = [];
      for (const cell of owners) {
        ownerArms.push(
          { op: "local.get", index: recvLocal },
          { op: "ref.test", typeIdx: cell.structTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: cell.classObjectGlobalIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast_null", typeIdx: cell.structTypeIdx },
              { op: "local.get", index: recvLocal },
              { op: "ref.cast_null", typeIdx: cell.structTypeIdx },
              { op: "ref.eq" },
              { op: "if", blockType: { kind: "empty" }, then: hit(cell) },
            ],
          },
        );
      }
      nameArms.push(
        { op: "local.get", index: flatLocal },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, propName),
        { op: "call", funcIdx: equalsIdx },
        { op: "if", blockType: { kind: "empty" }, then: ownerArms },
      );
    }
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: recvLocal },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: keyLocal },
      { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: keyLocal },
          { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: flatLocal },
          ...nameArms,
        ],
      },
    );
  };

  const find = (name: string): MopFn | undefined => ctx.mod.functions.find((candidate) => candidate.name === name);
  /** `if (cell holds a value) { then }` */
  const whenPresent = (cell: ExpandoCell, then: Instr[]): Instr[] => [
    { op: "global.get", index: cell.staticGlobalIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then },
  ];

  prepend(find("__extern_get"), 2, (cell) =>
    whenPresent(cell, [{ op: "global.get", index: cell.staticGlobalIdx }, { op: "return" }]),
  );

  const setResultGlobalIdx = ctx.externSetResultGlobalIdx;
  prepend(find("__extern_set"), 3, (cell) => [
    { op: "local.get", index: 2 },
    { op: "global.set", index: cell.staticGlobalIdx },
    ...(setResultGlobalIdx === undefined
      ? []
      : ([
          { op: "i32.const", value: 1 },
          { op: "global.set", index: setResultGlobalIdx },
        ] satisfies Instr[])),
    { op: "return" },
  ]);

  for (const name of ["__extern_has", "__hasOwnProperty", "__object_hasOwn", "__propertyIsEnumerable"]) {
    prepend(find(name), 2, (cell) => whenPresent(cell, [{ op: "i32.const", value: 1 }, { op: "return" }]));
  }

  const descriptorIdx = ctx.funcMap.get("__create_descriptor");
  if (descriptorIdx !== undefined) {
    // writable | enumerable | configurable — an ordinary assignment-created data property.
    prepend(find("__getOwnPropertyDescriptor"), 2, (cell) =>
      whenPresent(cell, [
        { op: "global.get", index: cell.staticGlobalIdx },
        { op: "i32.const", value: 0x07 },
        { op: "call", funcIdx: descriptorIdx },
        { op: "return" },
      ]),
    );
  }

  // `recv.p(...args)` through an untyped receiver: resolve the cell, then
  // Call(value, recv, args) — the same apply `class-proto-lookup.ts` uses for
  // its class-object call twin. Without it the class-object STRUCT receiver
  // takes the method-call native's non-`$Object` arm and throws "not a function".
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  if (applyClosureIdx !== undefined) {
    prepend(find("__extern_method_call"), 3, (cell) =>
      whenPresent(cell, [
        { op: "global.get", index: cell.staticGlobalIdx },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: applyClosureIdx },
        { op: "return" },
      ]),
    );
  }

  prepend(find("__delete_property"), 2, (cell) => [
    { op: "ref.null.extern" },
    { op: "global.set", index: cell.staticGlobalIdx },
    { op: "i32.const", value: 1 },
    { op: "return" },
  ]);
}
