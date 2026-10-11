// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

/**
 * Builds the Symbol-wrapper test (`symbolWrapperIntrinsicArm`): runs `then`
 * with the wrapper's `[[PrimitiveValue]]` `$PropEntry` in `entryLocal` when the
 * intrinsic `@@toPrimitive` decides the wrapper in `valueLocal`. Injected by
 * the finalizer so this leaf imports no runtime-owner module.
 */
export type SymbolWrapperArmBuilder = (valueLocal: number, entryLocal: number, then: Instr[]) => Instr[];

/**
 * (#6651 V10d) §7.1.19 ToPropertyKey for an OBJECT key, once, at the head of the
 * finalized standalone `__extern_get`. `obj[key]` with a `$Object` key (a
 * user `toString`, a Symbol wrapper whose `toString` is an accessor) reached the
 * dynamic getter with the raw object; only `__obj_hash`/`__obj_find` coerce
 * their key, so every arm that answers BEFORE the `$Object` table walk — the
 * closed-struct field ladder that serves `{ foo: 3 }[o]`, the proto-cache, the
 * wrapper/string arms — compared the object against string names and missed
 * (`undefined`). Coercing here runs the user conversion exactly once: the
 * resulting string or Symbol is a fixed point of `__to_property_key`.
 *
 * A Symbol wrapper decided by the intrinsic `Symbol.prototype[@@toPrimitive]`
 * keys by its Symbol (§20.4.3.5), which `__to_primitive` cannot see on a
 * wrapper (#6651 H5) — the injected arm answers that case first.
 *
 * Unshifted LAST, so it precedes every other prologue arm. Non-object keys pay
 * one `ref.test`. Standalone-only: the host lane's `__extern_get` is an import.
 */
export function unshiftExternGetObjectKeyCoercionArm(
  ctx: CodegenContext,
  symbolWrapperArm: SymbolWrapperArmBuilder,
): void {
  if (!ctx.standalone) return;
  const types = ctx.objectRuntimeTypes;
  const toPropertyKeyIdx = ctx.funcMap.get("__to_property_key");
  if (!types || toPropertyKeyIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn) return;
  const entryLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__key_wrapper_entry", type: { kind: "ref_null", typeIdx: types.propEntryTypeIdx } });
  const arm: Instr[] = [
    ...symbolWrapperArm(1, entryLocal, [
      { op: "local.get", index: entryLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: types.propEntryTypeIdx, fieldIdx: 1 }, // value: the `$Symbol`
      { op: "extern.convert_any" },
      { op: "local.set", index: 1 },
    ]),
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: types.objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toPropertyKeyIdx },
        { op: "local.set", index: 1 },
      ],
    },
  ];
  fn.body.unshift(...arm);
}
