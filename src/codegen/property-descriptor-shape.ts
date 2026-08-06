// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FieldDef } from "../ir/types.js";
export { exposedClosedStructFieldName } from "./fnctor-identity-fields.js";

/**
 * Descriptor contracts without a concrete value carrier belong to the open
 * `$Object` runtime. Treating their anonymous structs as closed getter arms can
 * intercept a structurally equivalent descriptor returned by the vec overlay.
 */
/** ES §6.2.5.6 ToPropertyDescriptor reads exactly these six fields, and no others. */
const DESCRIPTOR_FIELD_NAMES = ["value", "writable", "enumerable", "configurable", "get", "set"] as const;

/**
 * (#4180) May the #2372 descriptor-struct **transcription** own this struct?
 *
 * `emitDescriptorStructReify` (`object-ops.ts`) builds a fresh `$Object` by
 * copying a typed struct's **wasm fields** and handing that to
 * ToPropertyDescriptor. That is correct for the case it was written for — a
 * descriptor object literal (`var d = {value: 1}`) that the checker closed into
 * a struct whose fields ARE the descriptor's own properties — and silently
 * WRONG for any other struct, because it transcribes the *internal
 * representation* and discards the object's real own properties.
 *
 * Measured 2026-08-06, `--target standalone`:
 *
 * ```js
 * var arrObj = [];
 * arrObj.value = 7;                          // lands in the #3537 vec bag
 * Object.defineProperty(obj, "p", arrObj);   // descriptor becomes {length, data}
 * obj.p;                                     // => undefined
 * ```
 *
 * The emitted `__module_init` literally does
 * `__extern_set(descObj, "length", a.length); __extern_set(descObj, "data", a.data)`.
 * ToPropertyDescriptor then finds no `value`/`enumerable`/… and
 * CompletePropertyDescriptor fills in `undefined` + all-false. No refusal, no
 * diagnostic — the same failure class `descriptor-shape.ts`'s header describes
 * for the *static expansion*, one layer down.
 *
 * The gate is deliberately a **plausible-descriptor** test rather than a
 * builtin-representation denylist: a denylist has to be kept in sync with every
 * struct the compiler ever mints (`__vec_*`, `__subview_*`, `__Date`,
 * `__StandaloneRegExp`, error/box structs, …) and fails open when it falls
 * behind, which is the wrong direction for a helper whose failure mode is a
 * silent wrong answer.
 *
 * - **object-literal structs (`__anon_*`) always transcribe.** Their fields are
 *   their JS own properties by construction, including the `{foo: 1}` case,
 *   which must yield an empty-but-valid descriptor rather than a TypeError.
 *   (`isOpenDescriptorShape` above already relies on this naming convention.)
 * - **any other struct transcribes only if it carries at least one of the six
 *   descriptor field names** — e.g. a fnctor instance with `this.value = …`,
 *   which is a genuine descriptor carrier and whose behaviour is unchanged.
 * - **everything else is passed through as an externref**, so the runtime
 *   applier reads its real own properties. That is safe on both gates it must
 *   clear: `__obj_define_from_desc`'s Type check is `typeof === "object" ||
 *   "function"` since #3246 (not a `ref.test $Object`), and `__typeof_object`
 *   answers 1 for any non-null non-primitive; and the field reads go through
 *   `__desc_has_own` / `__extern_get`, which DO see the #3468/#3537 carrier
 *   bags (verified: `Object.getOwnPropertyNames`/`Object.keys`/gOPD on the same
 *   array all report the expando).
 */
export function isDescriptorTranscribableStruct(structName: string, fields: readonly FieldDef[]): boolean {
  if (structName.startsWith("__anon_")) return true;
  return fields.some((field) => (DESCRIPTOR_FIELD_NAMES as readonly string[]).includes(field.name));
}

export function isOpenDescriptorShape(structName: string, fields: FieldDef[]): boolean {
  const valueField = fields.find((field) => field.name === "value");
  return (
    structName.startsWith("__anon_") &&
    fields.some((field) => field.name === "enumerable") &&
    (valueField === undefined || valueField.type.kind === "externref" || valueField.type.kind === "ref_extern") &&
    fields.every(
      (field) =>
        field.name.startsWith("$") ||
        field.name.startsWith("__") ||
        ["value", "writable", "enumerable", "configurable", "get", "set"].includes(field.name),
    )
  );
}
