// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Canonical cross-module marker for provider-owned interpreted callbacks. */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureAnyHelpers } from "./any-helpers.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";

export const RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A = 0x2928;
export const RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B = 0x4556414c;
export const RUNTIME_EVAL_INTERP_CALLBACK_KIND_GENERIC = 0;
export const RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_EVAL = 1;
export const RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION = 2;
export const RUNTIME_EVAL_AOT_CALLABLE_BRAND_A = 0x2928;
export const RUNTIME_EVAL_AOT_CALLABLE_BRAND_B = 0x414f5443;

export const RUNTIME_EVAL_VALUE_KIND_REFERENCE = 0;
export const RUNTIME_EVAL_VALUE_KIND_UNDEFINED = 1;
export const RUNTIME_EVAL_VALUE_KIND_NULL = 2;
export const RUNTIME_EVAL_VALUE_KIND_NUMBER = 3;
export const RUNTIME_EVAL_VALUE_KIND_BOOLEAN = 4;
export const RUNTIME_EVAL_VALUE_KIND_STRING = 5;
export const RUNTIME_EVAL_VALUE_KIND_BIGINT = 6;

/**
 * Runtime bit distinguishing a genuine provider re-entry from an in-module
 * use of the same callable carrier. Syntax pre-scans deliberately over-enable
 * the carrier (for example Test262's dead `$262.evalScript` helper), so a
 * compile-time "module has an import" test is insufficient after DCE.
 */
export function ensureRuntimeEvalProviderActiveGlobal(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalProviderActiveGlobalIdx;
  if (cached !== undefined) return cached;
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__runtime_eval_provider_active",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.runtimeEvalProviderActiveGlobalIdx = globalIdx;
  return globalIdx;
}

/**
 * A provider callback cannot cross as an ordinary closure: any exception it
 * throws carries the provider module's private Wasm tag. This non-callable
 * marker is structurally canonical across modules; the caller's apply bridge
 * recognizes it, invokes the provider's envelope entry point, and rethrows
 * through the caller's own tag.
 */
export function ensureRuntimeEvalInterpretedCallbackType(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalInterpretedCallbackTypeIdx;
  if (cached !== undefined) return cached;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$RuntimeEvalInterpretedCallback",
    fields: [
      { name: "target", type: { kind: "externref" }, mutable: false },
      { name: "brandA", type: { kind: "i32" }, mutable: false },
      { name: "brandB", type: { kind: "i32" }, mutable: false },
      { name: "kind", type: { kind: "i32" }, mutable: false },
      // Provider closures are nominal module-local structs. Carry the two
      // standard scalar Function metadata fields explicitly so the caller's
      // property bridge does not have to introspect that foreign struct.
      { name: "name", type: { kind: "externref" }, mutable: false },
      { name: "length", type: { kind: "f64" }, mutable: false },
      { name: "constructor", type: { kind: "externref" }, mutable: false },
    ],
    superTypeIdx: -1,
  });
  ctx.runtimeEvalInterpretedCallbackTypeIdx = typeIdx;
  return typeIdx;
}

/** Canonical provider→caller value carrier. Primitive boxes are module-local
 * implementation details and cannot be passed through the result envelope by
 * identity; this non-recursive shape transports their scalar payloads and
 * leaves genuine references untouched. */
export function ensureRuntimeEvalValueType(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalValueTypeIdx;
  if (cached !== undefined) return cached;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$RuntimeEvalValue",
    fields: [
      { name: "kind", type: { kind: "i32" }, mutable: false },
      { name: "i32val", type: { kind: "i32" }, mutable: false },
      { name: "f64val", type: { kind: "f64" }, mutable: false },
      { name: "i64val", type: { kind: "i64" }, mutable: false },
      { name: "refval", type: { kind: "externref" }, mutable: false },
    ],
    superTypeIdx: -1,
  });
  ctx.runtimeEvalValueTypeIdx = typeIdx;
  return typeIdx;
}

/** Encode one caller-local value as the canonical cross-module value carrier.
 * This is the argument/result counterpart of {@link buildRuntimeEvalValueUnwrap}:
 * module-private `$AnyValue` and primitive boxes are reduced to scalar fields,
 * while genuine references cross unchanged. The returned sequence consumes an
 * externref and leaves the canonical carrier as externref. */
export function buildRuntimeEvalValueWrap(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  paramCount: number,
): Instr[] {
  ensureAnyHelpers(ctx);
  const externref: ValType = { kind: "externref" };
  const valueTypeIdx = ensureRuntimeEvalValueType(ctx);
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const valueLocal = paramCount + locals.length;
  locals.push({ name: `__runtime_eval_wrap_value_${locals.length}`, type: externref });
  const anyLocal = paramCount + locals.length;
  locals.push({
    name: `__runtime_eval_wrap_any_${locals.length}`,
    type: { kind: "ref_null", typeIdx: anyTypeIdx },
  });

  const makeValue = (
    kind: number,
    i32Value: Instr[] = [{ op: "i32.const", value: 0 }],
    f64Value: Instr[] = [{ op: "f64.const", value: 0 }],
    i64Value: Instr[] = [{ op: "i64.const", value: 0n }],
    refValue: Instr[] = [{ op: "ref.null.extern" }],
  ): Instr[] => [
    { op: "i32.const", value: kind },
    ...i32Value,
    ...f64Value,
    ...i64Value,
    ...refValue,
    { op: "struct.new", typeIdx: valueTypeIdx },
    { op: "extern.convert_any" },
  ];
  const anyField = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: anyLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx },
  ];
  const anyTagCase = (tag: number, then: Instr[], otherwise: Instr[]): Instr[] => [
    ...anyField(0),
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then,
      else: otherwise,
    },
  ];
  const anyReference: Instr[] = [
    ...anyField(3),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: anyField(4),
      else: [...anyField(3), { op: "extern.convert_any" }],
    },
  ];
  const anyValue: Instr[] = anyTagCase(
    0,
    makeValue(RUNTIME_EVAL_VALUE_KIND_NULL),
    anyTagCase(
      1,
      makeValue(RUNTIME_EVAL_VALUE_KIND_UNDEFINED),
      anyTagCase(
        2,
        makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, [...anyField(1), { op: "f64.convert_i32_s" }]),
        anyTagCase(
          3,
          makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, anyField(2)),
          anyTagCase(
            4,
            makeValue(RUNTIME_EVAL_VALUE_KIND_BOOLEAN, anyField(1)),
            anyTagCase(
              5,
              makeValue(RUNTIME_EVAL_VALUE_KIND_STRING, undefined, undefined, undefined, anyField(4)),
              anyTagCase(
                6,
                makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, anyReference),
                makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, [
                  { op: "local.get", index: valueLocal },
                ]),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  const helperPayload = (name: string, result: ValType): Instr[] => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) {
      if (result.kind === "i32") return [{ op: "i32.const", value: 0 }];
      if (result.kind === "f64") return [{ op: "f64.const", value: 0 }];
      return [{ op: "i64.const", value: 0n }];
    }
    return [
      { op: "local.get", index: valueLocal },
      { op: "call", funcIdx: idx },
    ];
  };
  const helperTest = (name: string, then: Instr[], otherwise: Instr[]): Instr[] => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return otherwise;
    return [
      { op: "local.get", index: valueLocal },
      { op: "call", funcIdx: idx },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then,
        else: otherwise,
      },
    ];
  };
  const fallbackReference = makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, [
    { op: "local.get", index: valueLocal },
  ]);
  const classifiedValue = helperTest("__typeof_undefined", makeValue(RUNTIME_EVAL_VALUE_KIND_UNDEFINED), [
    { op: "local.get", index: valueLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: makeValue(RUNTIME_EVAL_VALUE_KIND_NULL),
      else: helperTest(
        "__typeof_number",
        makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, helperPayload("__unbox_number", { kind: "f64" })),
        helperTest(
          "__typeof_boolean",
          makeValue(RUNTIME_EVAL_VALUE_KIND_BOOLEAN, helperPayload("__unbox_boolean", { kind: "i32" })),
          helperTest(
            "__typeof_string",
            makeValue(RUNTIME_EVAL_VALUE_KIND_STRING, undefined, undefined, undefined, [
              { op: "local.get", index: valueLocal },
            ]),
            helperTest(
              "__typeof_bigint",
              makeValue(
                RUNTIME_EVAL_VALUE_KIND_BIGINT,
                undefined,
                undefined,
                helperPayload("__to_bigint", { kind: "i64" }),
              ),
              fallbackReference,
            ),
          ),
        ),
      ),
    },
  ]);

  return [
    { op: "local.set", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyTypeIdx },
        { op: "local.set", index: anyLocal },
        ...anyValue,
      ],
      else: classifiedValue,
    },
  ];
}

/** Decode a provider-owned `$RuntimeEvalValue` into caller-local primitive
 * boxes. The input and output are both `externref`; the returned instruction
 * sequence consumes the input from the stack and leaves the decoded value.
 *
 * This builder is intentionally independent of FunctionContext so finalize-
 * time bridges such as `__apply_closure` can share the exact same decode as
 * direct eval/new Function result sites. `locals` is the target function's
 * mutable local list and `paramCount` is used to allocate stable indices.
 */
export function buildRuntimeEvalValueUnwrap(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  paramCount: number,
): Instr[] {
  const externref: ValType = { kind: "externref" };
  const valueTypeIdx = ensureRuntimeEvalValueType(ctx);
  const valueLocal = paramCount + locals.length;
  locals.push({ name: `__runtime_eval_value_${locals.length}`, type: externref });
  const carrierLocal = paramCount + locals.length;
  locals.push({
    name: `__runtime_eval_value_carrier_${locals.length}`,
    type: { kind: "ref_null", typeIdx: valueTypeIdx },
  });

  const carrierField = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: carrierLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: valueTypeIdx, fieldIdx },
  ];
  const kindCase = (kind: number, then: Instr[], otherwise: Instr[]): Instr[] => [
    ...carrierField(0),
    { op: "i32.const", value: kind },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then,
      else: otherwise,
    },
  ];
  const undefinedValue: Instr[] =
    ctx.undefinedSingleton === true && (ctx.standalone || ctx.nativeStrings) && ctx.undefinedGlobalIdx !== undefined
      ? [{ op: "global.get", index: ctx.undefinedGlobalIdx }, { op: "extern.convert_any" }]
      : [{ op: "ref.null.extern" }];
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  const boxBigIntIdx = ctx.funcMap.get("__box_bigint");
  const decoded = kindCase(
    RUNTIME_EVAL_VALUE_KIND_REFERENCE,
    carrierField(4),
    kindCase(
      RUNTIME_EVAL_VALUE_KIND_UNDEFINED,
      undefinedValue,
      kindCase(
        RUNTIME_EVAL_VALUE_KIND_NULL,
        [{ op: "ref.null.extern" }],
        kindCase(
          RUNTIME_EVAL_VALUE_KIND_NUMBER,
          boxNumberIdx === undefined
            ? [{ op: "ref.null.extern" }]
            : [...carrierField(2), { op: "call", funcIdx: boxNumberIdx }],
          kindCase(
            RUNTIME_EVAL_VALUE_KIND_BOOLEAN,
            boxBooleanIdx === undefined
              ? [{ op: "ref.null.extern" }]
              : [...carrierField(1), { op: "call", funcIdx: boxBooleanIdx }],
            kindCase(
              RUNTIME_EVAL_VALUE_KIND_STRING,
              carrierField(4),
              kindCase(
                RUNTIME_EVAL_VALUE_KIND_BIGINT,
                boxBigIntIdx === undefined
                  ? [{ op: "ref.null.extern" }]
                  : [...carrierField(3), { op: "call", funcIdx: boxBigIntIdx }],
                carrierField(4),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  return [
    { op: "local.set", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: valueTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: valueTypeIdx },
        { op: "local.set", index: carrierLocal },
        ...decoded,
      ],
      else: [{ op: "local.get", index: valueLocal }],
    },
  ];
}
