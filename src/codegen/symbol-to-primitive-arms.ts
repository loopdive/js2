// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 H1) The Symbol-wrapper fact `__extern_to_string_spec` needs on the
 * host-free lanes. A leaf (object-runtime / native-strings / registry only) so
 * the coercion engine can import it without a cycle.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { FLAG_INTERNAL, WRAPPER_PRIMITIVE_KEY } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { builtinBrandOffsetOf } from "./builtin-brands.js";
import { unshiftExternGetObjectKeyCoercionArm } from "./object-model/extern-get-object-key.js";

/**
 * (#6651 V10d) `[] -> i32`: 1 while the intrinsic `Symbol.prototype[@@toPrimitive]`
 * still stands. `delete Symbol.prototype[Symbol.toPrimitive]` removes its `@@3`
 * entry from the Symbol brand's prototype companion; §7.1.1 step 2.d then runs
 * OrdinaryToPrimitive on the wrapper, which this arm must not pre-empt. Only a
 * companion SEEDED with the builtins (every seeder installs `constructor`
 * first) can have lost the entry; one never created, or created bare by a
 * named write, still stands for the intact intrinsic, and without the proto
 * store nothing can remove it at all.
 */
function intrinsicSymbolToPrimitivePresentInstrs(
  ctx: CodegenContext,
  boxSymbolIdx: number,
  valueLocal: number,
): Instr[] {
  const companionIdx = ctx.funcMap.get("__protoidx_companion");
  const hasRIdx = ctx.funcMap.get("__protoidx_has_r");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const symbolOff = builtinBrandOffsetOf("Symbol");
  const types = ctx.objectRuntimeTypes;
  if (!types || companionIdx === undefined || hasRIdx === undefined || objFindIdx === undefined)
    return [{ op: "i32.const", value: 1 }];
  if (symbolOff === undefined) return [{ op: "i32.const", value: 1 }];
  const companion = (): Instr[] => [
    { op: "i32.const", value: symbolOff },
    { op: "i32.const", value: 0 }, // LOOKUP — a read must not allocate the companion.
    { op: "call", funcIdx: companionIdx },
  ];
  addStringConstantGlobal(ctx, "constructor");
  const unseeded: Instr[] = [
    ...companion(),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        ...companion(),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: types.objectTypeIdx },
        ...stringConstantExternrefInstrs(ctx, "constructor"),
        { op: "call", funcIdx: objFindIdx },
        { op: "ref.is_null" },
      ],
    },
  ];
  return [
    ...unseeded,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: valueLocal },
        { op: "i32.const", value: 3 }, // well-known Symbol.toPrimitive
        { op: "call", funcIdx: boxSymbolIdx },
        { op: "call", funcIdx: hasRIdx },
      ],
    },
  ];
}

/**
 * §7.1.1 step 2 for a Symbol WRAPPER, inside `__extern_to_string_spec`: when
 * `v` (param 0) is a `$Object` whose internal `[[PrimitiveValue]]` slot holds a
 * `$Symbol` and no `@@toPrimitive` is visible through `__extern_get`, the
 * intrinsic `Symbol.prototype[@@toPrimitive]` would answer the Symbol, and
 * ToString of it throws. `__extern_get` cannot see that intrinsic on a wrapper
 * (#6651 H5), so `__to_primitive` falls through to OrdinaryToPrimitive and
 * renders `"Symbol(…)"` — the lenient answer. A user-installed `@@toPrimitive`
 * on the wrapper IS visible, and then this arm stays out of the way.
 *
 * Returns `[]` when a dependency is missing (the arm is then simply absent).
 * `entryLocal` is a `ref null $PropEntry` scratch local.
 */
export function symbolWrapperToStringThrowArm(ctx: CodegenContext, entryLocal: number, throwInstrs: Instr[]): Instr[] {
  return symbolWrapperIntrinsicArm(ctx, 0, entryLocal, throwInstrs);
}

/**
 * The shared §7.1.1 step 2.d test behind {@link symbolWrapperToStringThrowArm}:
 * runs `then` (with the wrapper's `$PropEntry` in `entryLocal`, its value the
 * `$Symbol`) when the externref in `valueLocal` is a Symbol wrapper whose
 * ToPrimitive the INTRINSIC `@@toPrimitive` decides — i.e. it answers the
 * Symbol itself. (#6651 V10d) ToPropertyKey reuses it to keep `o[Object(sym)]`
 * keyed by the Symbol.
 */
export function symbolWrapperIntrinsicArm(
  ctx: CodegenContext,
  valueLocal: number,
  entryLocal: number,
  then: Instr[],
): Instr[] {
  const types = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const boxSymbolIdx = ctx.funcMap.get("__box_symbol");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (!types || ctx.symbolTypeIdx < 0) return [];
  if (objFindIdx === undefined || boxSymbolIdx === undefined || externGetIdx === undefined) return [];
  const { objectTypeIdx, propEntryTypeIdx } = types;
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");
  addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);
  const noUserToPrimitive: Instr[] = [
    { op: "local.get", index: valueLocal },
    { op: "i32.const", value: 3 }, // well-known Symbol.toPrimitive
    { op: "call", funcIdx: boxSymbolIdx },
    { op: "call", funcIdx: externGetIdx },
    ...(nullishToNullIdx === undefined ? [] : ([{ op: "call", funcIdx: nullishToNullIdx }] satisfies Instr[])),
    { op: "ref.is_null" },
  ];
  return [
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        ...stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
        { op: "call", funcIdx: objFindIdx },
        { op: "local.tee", index: entryLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: entryLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
            { op: "i32.const", value: FLAG_INTERNAL },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: entryLocal },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value
                { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...noUserToPrimitive,
                    ...intrinsicSymbolToPrimitivePresentInstrs(ctx, boxSymbolIdx, valueLocal),
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** (#6651 V10d) Finalize: ToPropertyKey at the head of `__extern_get`, Symbol-wrapper aware. */
export function unshiftExternGetPropertyKeyArm(ctx: CodegenContext): void {
  unshiftExternGetObjectKeyCoercionArm(ctx, (v, e, then) => symbolWrapperIntrinsicArm(ctx, v, e, then));
}
