// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4276) Host-free `value instanceof <primitive wrapper>` predicates.
 *
 * Standalone wrapper constructors allocate an ordinary `$Object` and store the
 * primitive brand in the FLAG_INTERNAL `[[PrimitiveValue]]` slot. The
 * historical `$WrapperNumber` / `$WrapperString` / `$WrapperBoolean` structs
 * are not the constructor result representation and are structurally
 * equivalent to primitive call-receiver carriers. Membership must therefore be
 * recovered at the real representation boundary: require `$Object`, require
 * the genuine internal slot, then test the slot value's native primitive
 * carrier.
 *
 * The helper accepts `anyref` rather than `externref` so both direct codegen
 * (`any.convert_extern` at the call site) and IR-native dynamic/object carriers
 * can call the same predicate without a representation round trip.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, FLAG_INTERNAL, WRAPPER_PRIMITIVE_KEY } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

export type StandaloneWrapperConstructorName = "Number" | "String" | "Boolean";

export function ensureStandaloneWrapperInstanceOfHelper(
  ctx: CodegenContext,
  ctorName: StandaloneWrapperConstructorName,
): number {
  ensureObjectRuntime(ctx);
  const helperName = `__instanceof_wrapper_${ctorName}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const objTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (!objTypes || objFindIdx === undefined) {
    throw new Error(`${helperName}: standalone object runtime is unavailable`);
  }
  const { objectTypeIdx, propEntryTypeIdx } = objTypes;
  const anyValueTypeIdx = ctx.anyValueTypeIdx;
  const slotValue = (): Instr[] => [
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
  ];
  const brandTest = (): Instr[] => {
    switch (ctorName) {
      case "String":
        return [...slotValue(), { op: "ref.test", typeIdx: ctx.anyStrTypeIdx }];
      case "Number":
        return [
          ...slotValue(),
          { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
          ...slotValue(),
          { op: "ref.test", typeIdx: -20 }, // abstract i31
          { op: "i32.or" },
        ];
      case "Boolean":
        return [...slotValue(), { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx }];
    }
  };

  addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);
  const body: Instr[] = [
    // Normalize the fast `$AnyValue` dynamic carrier to its tag-6 object
    // payload. Direct externref/object callers arrive as the raw anyref and
    // take the else arm unchanged.
    ...(anyValueTypeIdx >= 0
      ? ([
          { op: "local.get", index: 0 },
          { op: "ref.test", typeIdx: anyValueTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "ref.cast", typeIdx: anyValueTypeIdx },
              { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
              { op: "i32.const", value: 6 }, // JsTag.Object
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "ref.cast", typeIdx: anyValueTypeIdx },
                  { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 3 },
                  { op: "local.set", index: 1 },
                ],
                else: [
                  // The legacy fast-any classifier may carry an otherwise
                  // honest GC object in overloaded tag 5 / externval. Peel
                  // that plane too; genuine strings and primitive boxes fail
                  // the later `$Object` test.
                  { op: "local.get", index: 0 },
                  { op: "ref.cast", typeIdx: anyValueTypeIdx },
                  { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
                  { op: "i32.const", value: 5 },
                  { op: "i32.ne" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                  },
                  { op: "local.get", index: 0 },
                  { op: "ref.cast", typeIdx: anyValueTypeIdx },
                  { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 4 },
                  { op: "any.convert_extern" },
                  { op: "local.set", index: 1 },
                ],
              },
            ],
            else: [
              { op: "local.get", index: 0 },
              { op: "local.set", index: 1 },
            ],
          },
        ] satisfies Instr[])
      : ([
          { op: "local.get", index: 0 },
          { op: "local.set", index: 1 },
        ] satisfies Instr[])),
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        ...stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
        { op: "call", funcIdx: objFindIdx },
        { op: "local.tee", index: 2 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 0 }],
          else: [
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
            { op: "i32.const", value: FLAG_INTERNAL },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: brandTest(),
              else: [{ op: "i32.const", value: 0 }],
            },
          ],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "anyref" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: [
      { name: "value", type: { kind: "anyref" } },
      { name: "slot", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
