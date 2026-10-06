// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 C5) §10.4.3 String-exotic `length` read through the dynamic
 * `__extern_get` boundary, standalone.
 *
 * ## The gap (measured 2026-09-29, `--target standalone`)
 *
 * A String wrapper is a `$Object` whose `length` is DERIVED from the
 * [[StringData]] in its `[[PrimitiveValue]]` slot — it is not a table entry.
 * `hasOwnProperty` (#4232) and `getOwnPropertyDescriptor` both answer it, and
 * the String-exotic arm of `__extern_get` answers the canonical INDEX keys, but
 * the key `"length"` fell through to the ordinary table walk and read
 * `undefined`:
 *
 * | read, `o = new String("abc")` passed as `any` | node | before |
 * | --------------------------------------------- | ---- | ------ |
 * | `o["0"]`                                      | "a"  | "a"    |
 * | `Object.getOwnPropertyDescriptor(o, "length").value` | 3 | 3 |
 * | `o["length"]`                                 | 3    | undefined |
 *
 * `verifyProperty(new S("test262"), "length", …)` (the harness reads
 * `obj[name]`) therefore failed for every `class S extends String`.
 *
 * ## Scope
 *
 * The arm is spliced into `__extern_get`, which every standalone module with an
 * object runtime carries, so it is emitted only where a String wrapper that
 * reaches a dynamic read is demanded — today a `class … extends String`
 * construction (`standalone-subclass-ctors.ts`). Every other module is
 * byte-identical. The same answer is right for a plain `new String(…)` read
 * dynamically; widening the demand to it is recorded as a C5 residual.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

const demanded = new WeakSet<CodegenContext>();

/** Ask for the `length` arm in this compile's `__extern_get`. */
export function demandStringWrapperDynamicLength(ctx: CodegenContext): void {
  demanded.add(ctx);
}

/**
 * Instructions answering `length` for a String wrapper: with the (string) key
 * in param `keyParam` and the wrapper's non-null [[StringData]] in
 * `stringDataLocal`, return the boxed length when the key is `"length"`, else
 * fall through. Empty when not demanded or a helper is missing.
 */
export function stringWrapperLengthArm(ctx: CodegenContext, keyParam: number, stringDataLocal: number): Instr[] {
  // (#6651 V1) a module that uses `Proxy` forwards a trapless [[Get]] on a
  // String-wrapper target through this boundary, so it demands the arm too.
  if (!demanded.has(ctx) && !(ctx.standalone && ctx.proxyDirty === true)) return [];
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const boxIdx = ctx.funcMap.get("__box_number");
  if (flattenIdx === undefined || equalsIdx === undefined || boxIdx === undefined) return [];
  return [
    { op: "local.get", index: keyParam },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    ...nativeStringLiteralInstrs(ctx, "length"),
    { op: "call", funcIdx: equalsIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // `$AnyString` field 0 is the length (the index arm's bound check).
        { op: "local.get", index: stringDataLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: boxIdx },
        { op: "return" },
      ],
    },
  ];
}
