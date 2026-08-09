// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4248) `Number.prototype` / `String.prototype` / `Boolean.prototype` carry a
 * [[PrimitiveValue]] — ToPrimitive must see it, under `--target standalone`.
 *
 * ## The spec fact that keeps surprising people
 *
 * ES5 §15.7.4: "The Number prototype object is itself a Number object whose
 * [[PrimitiveValue]] is +0." Same shape for §15.5.4 (`String.prototype` is a
 * String object with value `""`) and §15.6.4 (`Boolean.prototype` is a Boolean
 * object with value `false`). So `Number.prototype == 0` is **true**, and
 * Sputnik asserts exactly that (`S15.7.3.1_A3`, `S15.7.4_A1`,
 * `S15.6.3.1_A1`, `S15.5.4_A1`).
 *
 * ## The gap
 *
 * `__to_primitive` (object-runtime.ts) recovers a wrapper's primitive by
 * reading the `[[PrimitiveValue]]` FLAG_INTERNAL own-slot off a `$Object`. A
 * builtin prototype in standalone is a `$NativeProto` — a different heap type
 * with no own-props table at all — so it failed the `ref.test $Object` and
 * fell into the "non-`$Object`, return unchanged" arm. The comparison then ran
 * against the object itself and answered `false`.
 *
 * This is deliberately NOT modelled by giving the three prototypes a real
 * `[[PrimitiveValue]]` slot: they have no slot to put one in, and widening
 * `$NativeProto` for three constants would put an externref field on every
 * builtin prototype in the module. The value is a per-brand CONSTANT, so the
 * arm is a three-way `i32.eq` on `$brand`.
 *
 * ## Placement and the null receiver
 *
 * Spliced at the FRONT of `__to_primitive`, ahead of its own null/primitive
 * early-outs. `any.convert_extern` of a null externref is a null anyref and
 * `ref.test` answers 0 for null, so a null input still reaches the original
 * first instruction unchanged — the arm cannot trap on the receiver the
 * function is most often called with.
 *
 * `$isClass != 0` declines: a user class proto is a `$NativeProto` façade
 * (#2101) and has no [[PrimitiveValue]].
 *
 * ## Demand gate
 *
 * No `$NativeProto` type in the module ⇒ no splice. Same exact gate as
 * `native-proto-own-props.ts`; see that module's note on why this class of
 * arm is not the #4232 §5 hazard (it materializes no closures).
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/** `$NativeProto` field indices — the reader-visible contract (native-proto.ts). */
const NP_BRAND = 0;
const NP_IS_CLASS = 1;

/**
 * Prepend the three §15.5.4/§15.6.4/§15.7.4 default-primitive arms onto
 * `__to_primitive`. No-op (and no body touched) outside standalone, without a
 * `$NativeProto`, or when a needed boxing helper is missing.
 */
export function unshiftNativeProtoToPrimitiveArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const protoTypeIdx = ctx.nativeProtoTypeIdx;
  if (protoTypeIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__to_primitive");
  if (!fn) return;
  // `__box_boolean` is a registered native under standalone (registry/imports.ts
  // `registerNative("__box_boolean", …)`), so it is present wherever
  // `__to_primitive` is — but a finalize splice may NOT add an import, so an
  // absent helper means "emit nothing" rather than "ensure it".
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (boxBooleanIdx === undefined) return;
  if (ctx.anyStrTypeIdx < 0) return;
  addStringConstantGlobal(ctx, "");
  const emptyString = stringConstantExternrefInstrs(ctx, "");
  if (emptyString.length === 0) return;

  /** `$brand == <brand of name>` → return `value`, else fall through. */
  const arm = (name: "Number" | "String" | "Boolean", value: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: protoTypeIdx },
    { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_BRAND },
    { op: "i32.const", value: BUILTIN_BRAND_TABLE[name]! },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...value, { op: "return" }],
    },
  ];

  fn.body.unshift({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: protoTypeIdx },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: protoTypeIdx },
      { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_IS_CLASS },
      { op: "br_if", depth: 0 },
      // §15.7.4 — [[PrimitiveValue]] +0. Emitted as the i31 small-int box
      // directly rather than through `__box_number`: that helper's own body
      // routes `+0` to exactly this shape (registry/imports.ts — the `-0`
      // guard admits `+0`), and `__to_primitive`'s leading early-out already
      // names an i31 as "already a primitive".
      ...arm("Number", [{ op: "i32.const", value: 0 }, { op: "ref.i31" }, { op: "extern.convert_any" }]),
      // §15.5.4 — [[PrimitiveValue]] "".
      ...arm(
        "String",
        emptyString.map((i) => ({ ...i })),
      ),
      // §15.6.4 — [[PrimitiveValue]] false.
      ...arm("Boolean", [
        { op: "i32.const", value: 0 },
        { op: "call", funcIdx: boxBooleanIdx },
      ]),
    ],
  });
}
